'use node';

import { v } from 'convex/values';
import type { GenericId } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { assertOwnsAgentAction } from './ownership';
import { assertRealMode } from '../src/lib/surface-mode';
import {
  newOauthNonce,
  OAUTH_STATE_MESSAGES,
  OAUTH_STATE_TTL_MS,
  signOauthState,
  verifyOauthState,
} from '../src/lib/oauth-state';
import {
  buildSlackManifest,
  extractManifestTemplate,
  slackInstallUrl,
} from '../src/surfaces/slack-manifest';
import { safeFailureMessage } from '../src/surfaces/redact';

type CredentialId = GenericId<'credentials'>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const SLACK_API = 'https://slack.com/api/';
const CONFIGURATION_TOKEN_LABEL = 'Slack app configuration token (12 hours, revoked after use)';

const credentialInternal = internal as unknown as {
  credentials: {
    decrypt: FunctionReference<'action', 'internal', { credentialId: CredentialId }, string>;
    revokeInternal: FunctionReference<
      'mutation',
      'internal',
      { credentialId: CredentialId },
      unknown
    >;
    store: FunctionReference<
      'action',
      'internal',
      {
        appId?: string;
        kind: 'value' | 'location' | 'oauth';
        label: string;
        plaintext?: string;
        source: { ref: string; sourceId: Id<'docSources'> } | 'entered' | 'oauth';
        userId: string;
      },
      CredentialId
    >;
  };
};

export interface ProvisionOutcome {
  appId: string;
  appName: string;
  installUrl: string;
}

export interface InstallOutcome {
  agentId?: Id<'agents'>;
  ok: boolean;
  reason?: string;
  surfaceSlug?: string;
}

/**
 * The public origin Slack redirects the administrator back to.
 *
 * Raises:
 *   Error: If the deployment has no public URL, because the manifest cannot
 *     then declare a redirect the install could ever return to.
 */
function publicUrlOrThrow(): string {
  const url = process.env.DAY0_PUBLIC_URL?.trim();
  if (!url) {
    throw new Error(
      'DAY0_PUBLIC_URL is not set, so this deployment has no address Slack can redirect an ' +
        'install back to. Start a tunnel to this machine and set it before provisioning an app.',
    );
  }
  return url;
}

/**
 * Call one Slack Web API method and enforce its in-band success contract.
 *
 * Args:
 *   fetcher: HTTP implementation, replaceable by behavioural tests.
 *   method: Fixed Slack method name.
 *   init.token: Bearer credential, when the method takes one.
 *   init.form: Form-encoded body values.
 *   init.json: JSON body values.
 *
 * Returns:
 *   The parsed successful payload.
 *
 * Raises:
 *   Error: If HTTP or Slack reports failure.
 */
async function callSlack(
  fetcher: Fetcher,
  method: string,
  init: { form?: Record<string, string>; json?: unknown; token?: string },
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  const response = await fetcher(`${SLACK_API}${method}`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      typeof payload.error === 'string'
        ? `Slack ${method} failed: ${payload.error}`
        : `Slack ${method} returned HTTP ${response.status}.`,
    );
  }
  return payload;
}

/**
 * Read the app credentials `apps.manifest.create` returned.
 *
 * Slack nests them under `credentials`; a response without a client secret is
 * useless for the exchange that follows, so it is a failure rather than a
 * partially provisioned app the card would show as ready.
 */
export function parseManifestCreate(payload: Record<string, unknown>): {
  appId: string;
  clientId: string;
  clientSecret: string;
} {
  const appId = payload.app_id;
  const credentials = payload.credentials as Record<string, unknown> | undefined;
  const clientId = credentials?.client_id;
  const clientSecret = credentials?.client_secret;
  if (typeof appId !== 'string' || typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    throw new Error('Slack apps.manifest.create returned no app credentials.');
  }
  return { appId, clientId, clientSecret };
}

/** Read the bot token `oauth.v2.access` returned. */
export function parseOauthAccess(payload: Record<string, unknown>): {
  botToken: string;
  botUserId?: string;
  teamId?: string;
} {
  const botToken = payload.access_token;
  if (typeof botToken !== 'string' || botToken === '') {
    throw new Error('Slack oauth.v2.access returned no bot token.');
  }
  const team = payload.team as Record<string, unknown> | undefined;
  return {
    botToken,
    botUserId: typeof payload.bot_user_id === 'string' ? payload.bot_user_id : undefined,
    teamId: typeof team?.id === 'string' ? team.id : undefined,
  };
}

interface ProvisionDependencies {
  fetch: Fetcher;
  newNonce(): string;
  now(): number;
}

const provisionDependencies: ProvisionDependencies = {
  fetch: (input, init) => fetch(input, init),
  newNonce: newOauthNonce,
  now: () => Date.now(),
};

/**
 * Register a dedicated provider app for one employee from its team's manifest.
 *
 * The procedure is the one the team's own policy page documents: an
 * administrator issues a short-lived app configuration token at approval time,
 * the employee registers its app from the page's manifest template, and the
 * install link the administrator clicks is what delivers a token. The
 * configuration token is stored encrypted for the one call it is needed for and
 * revoked immediately afterwards, whether or not that call succeeded - it
 * carries workspace-wide app-management authority and outlives this action by
 * twelve hours otherwise.
 *
 * Args:
 *   ctx: Convex Node action context.
 *   surfaceId: The approved chat surface the app belongs to.
 *   configurationToken: The administrator's app configuration token.
 *
 * Returns:
 *   The app's id and name and the install link for the administrator.
 */
export async function runProvisionApp(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
  configurationToken: string,
  dependencies: ProvisionDependencies = provisionDependencies,
): Promise<ProvisionOutcome> {
  const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, { surfaceId });
  if (!context) throw new Error('Surface not found.');
  const { agent, surface } = context;
  if (!agent.userId) throw new Error('Agent has no owner.');
  if (surface.class !== 'chat') {
    throw new Error('Only a chat surface provisions a dedicated app for this employee.');
  }
  if (surface.managerApprovedAt === undefined || surface.itApprovedAt === undefined) {
    throw new Error('The connection needs both approvals before an app is registered for it.');
  }
  if (!surface.endpoint?.startsWith(SLACK_API)) {
    throw new Error('The documented endpoint is not the approved Slack host.');
  }
  const token = configurationToken.trim();
  if (!token) throw new Error('An app configuration token is required.');

  const publicUrl = publicUrlOrThrow();
  const pages: Doc<'docPages'>[] = await ctx.runQuery(internal.orientationData.pagesForAgent, {
    agentId: surface.agentId,
  });
  const template = extractManifestTemplate(
    pages.map((page: Doc<'docPages'>): string => page.markdown).join('\n\n'),
  );
  if (!template) {
    throw new Error(
      'The linked documentation carries no app manifest template, so there is nothing to ' +
        'register an app from. Ask the messaging administrator to publish one.',
    );
  }
  const built = buildSlackManifest({ agentName: agent.name, publicUrl, template });

  const now = dependencies.now();
  const configurationCredentialId: CredentialId = await ctx.runAction(
    credentialInternal.credentials.store,
    {
      userId: agent.userId,
      kind: 'value',
      label: CONFIGURATION_TOKEN_LABEL,
      plaintext: token,
      source: 'entered',
    },
  );

  let created: { appId: string; clientId: string; clientSecret: string };
  try {
    const decrypted: string = await ctx.runAction(credentialInternal.credentials.decrypt, {
      credentialId: configurationCredentialId,
    });
    created = parseManifestCreate(
      await callSlack(dependencies.fetch, 'apps.manifest.create', {
        token: decrypted,
        form: { manifest: JSON.stringify(built.manifest) },
      }),
    );
  } finally {
    // The token is single-purpose and workspace-wide: it stops being ours the
    // moment the call that needed it has returned, success or failure.
    await ctx.runMutation(credentialInternal.credentials.revokeInternal, {
      credentialId: configurationCredentialId,
    });
  }

  const clientSecretCredentialId: CredentialId = await ctx.runAction(
    credentialInternal.credentials.store,
    {
      userId: agent.userId,
      kind: 'oauth',
      label: `${built.appName} client secret`,
      plaintext: created.clientSecret,
      source: 'oauth',
      appId: created.appId,
    },
  );

  const nonce = dependencies.newNonce();
  const stateExpiresAt = now + OAUTH_STATE_TTL_MS;
  const state = signOauthState(
    { expiresAt: stateExpiresAt, nonce, surfaceId: String(surface._id) },
    process.env.DAY0_CREDENTIAL_KEY,
  );
  const installUrl = slackInstallUrl({
    clientId: created.clientId,
    redirectUrl: built.redirectUrl,
    scopes: built.scopes,
    state,
  });

  await ctx.runMutation(internal.surfaces.recordProvisionedApp, {
    surfaceId: surface._id,
    appId: created.appId,
    appName: built.appName,
    clientId: created.clientId,
    clientSecretCredentialId,
    installUrl,
    redirectUrl: built.redirectUrl,
    scopes: built.scopes,
    stateNonce: nonce,
    stateExpiresAt,
    now,
  });

  return { appId: created.appId, appName: built.appName, installUrl };
}

/**
 * Owner-checked entry point for the card's "Provision a dedicated app" control.
 */
export const provisionApp = action({
  args: { surfaceId: v.id('surfaces'), configurationToken: v.string() },
  handler: async (ctx, args): Promise<ProvisionOutcome> => {
    const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, {
      surfaceId: args.surfaceId,
    });
    if (!context) throw new Error('Surface not found.');
    await assertOwnsAgentAction(ctx, context.surface.agentId);
    assertRealMode('App provisioning');
    try {
      return await runProvisionApp(ctx, args.surfaceId, args.configurationToken);
    } catch (error) {
      throw new Error(
        safeFailureMessage(error, args.configurationToken, 'The app could not be registered.'),
      );
    }
  },
});

/**
 * Complete one OAuth install and attach the dedicated identity to its surface.
 *
 * This is the one action reached without a caller identity, so the signed
 * single-use state is what authorises it: an unsigned, expired or already-used
 * state is refused before the provider is called at all, and the surface the
 * state names is the only surface it can ever write to.
 */
export async function runCompleteInstall(
  ctx: ActionCtx,
  state: string,
  code: string,
  dependencies: ProvisionDependencies = provisionDependencies,
): Promise<InstallOutcome> {
  const now = dependencies.now();
  const verified = verifyOauthState(state, process.env.DAY0_CREDENTIAL_KEY, now);
  if (!verified.ok) return { ok: false, reason: OAUTH_STATE_MESSAGES[verified.reason] };
  if (!code.trim()) return { ok: false, reason: 'Slack returned no authorisation code.' };

  const claim = await ctx.runMutation(internal.surfaces.claimInstallState, {
    surfaceId: verified.surfaceId as Id<'surfaces'>,
    nonce: verified.nonce,
    now,
  });
  if (!claim.ok) {
    return {
      ok: false,
      reason:
        claim.reason === 'expired'
          ? OAUTH_STATE_MESSAGES.expired
          : claim.reason === 'used'
            ? 'That install link has already been used. Provision the app again for a fresh one.'
            : 'This connection has no app awaiting an install.',
    };
  }

  const surfaceRef = verified.surfaceId as Id<'surfaces'>;
  const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, {
    surfaceId: surfaceRef,
  });
  if (!context?.agent.userId) return { ok: false, reason: 'This connection no longer exists.' };

  let clientSecret = '';
  try {
    clientSecret = await ctx.runAction(credentialInternal.credentials.decrypt, {
      credentialId: claim.clientSecretCredentialId,
    });
    const access = parseOauthAccess(
      await callSlack(dependencies.fetch, 'oauth.v2.access', {
        form: {
          client_id: claim.clientId,
          client_secret: clientSecret,
          code: code.trim(),
          redirect_uri: claim.redirectUrl,
        },
      }),
    );
    const credentialId: CredentialId = await ctx.runAction(credentialInternal.credentials.store, {
      userId: context.agent.userId,
      kind: 'oauth',
      label: `${context.surface.displayName} bot token (${claim.slug} dedicated app)`,
      plaintext: access.botToken,
      source: 'oauth',
      appId: context.surface.provisioning?.appId,
    });
    await ctx.runMutation(internal.surfaces.recordInstalledApp, {
      surfaceId: surfaceRef,
      credentialId,
      now: dependencies.now(),
    });
    await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
      surfaceId: surfaceRef,
      renewExpiry: true,
    });
    return { ok: true, agentId: claim.agentId, surfaceSlug: claim.slug };
  } catch (error) {
    const reason = safeFailureMessage(
      error,
      clientSecret,
      'The install could not be completed.',
    );
    await ctx.runMutation(internal.surfaces.recordInstallFailure, {
      surfaceId: surfaceRef,
      reason,
      now: dependencies.now(),
    });
    return { ok: false, agentId: claim.agentId, reason };
  } finally {
    clientSecret = '';
  }
}

/**
 * The redirect route's entry point, authorised by the signed state alone.
 *
 * It carries no owner check by design: the administrator who clicks the install
 * link is not signed in to Day0, and often is not the manager. What it does
 * carry is a state this deployment signed, which expires and is single-use.
 */
export const completeInstall = action({
  args: { state: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<InstallOutcome> => {
    assertRealMode('App installation');
    return await runCompleteInstall(ctx, args.state, args.code);
  },
});

/** Test seam: the internal form used by the mirrored behavioural tests. */
export const completeInstallInternal = internalAction({
  args: { state: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<InstallOutcome> =>
    await runCompleteInstall(ctx, args.state, args.code),
});

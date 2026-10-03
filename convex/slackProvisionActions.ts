'use node';

import { v } from 'convex/values';
import type { GenericId } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { credentialKeyring } from './credentialCryptoActions';
import { assertOwnsAgentAction } from './ownership';
import { logEvent } from './eventLog';
import type { HeldConfigurationRows, RotationRecorded } from './slackProvision';
import { openOwnedCredential, sealForOwner } from '../src/lib/credential-crypto';
import { cronsPauseReason } from '../src/lib/crons-pause';
import { log } from '../src/lib/logger';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../src/lib/organisation-key';
import { assertRealMode } from '../src/lib/surface-mode';
import {
  newOauthNonce,
  OAUTH_STATE_MESSAGES,
  OAUTH_STATE_TTL_MS,
  signOauthState,
  verifyOauthState,
} from '../src/lib/oauth-state';
import {
  configurationRenewal,
  configurationTokenRefused,
  installedBotIssuer,
  KEPT_APP_CONNECTION_REVOKED,
  NO_CONFIGURATION_TOKEN,
  parseTokenRotation,
  rejoinPlan,
  rotationRefusal,
  slackAppManifest,
  slackClientSecretIssuer,
  SLACK_SYSTEM,
  type SlackAppManifest,
  type SlackIssuedBy,
  type VisibleChannel,
} from '../src/surfaces/identity-issuers/slack';
import { approvedChannelNames } from '../src/surfaces/intake-scope';
import { slackInstallUrl } from '../src/surfaces/slack-manifest';
import { safeFailureMessage } from '../src/surfaces/redact';
import { slackApiUrl } from '../src/surfaces/slack-endpoint';

type CredentialId = GenericId<'credentials'>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const SLACK_API = 'https://slack.com/api/';
const CONFIGURATION_TOKEN_LABEL =
  'Slack app configuration token (12 hours; Day0 asks Slack to revoke it after use)';

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
        holder?: typeof ORGANISATION_HOLDER;
        kind: 'value' | 'location' | 'oauth';
        label: string;
        plaintext?: string;
        source: { ref: string; sourceId: Id<'docSources'> } | 'entered' | 'oauth';
        userId: string;
        issuedBy?: SlackIssuedBy;
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

/** A Slack Web API failure, with Slack's own error word where it gave one. */
class SlackCallError extends Error {
  readonly slackError?: string;

  constructor(message: string, slackError?: string) {
    super(message);
    this.name = 'SlackCallError';
    if (slackError !== undefined) this.slackError = slackError;
  }
}

/** Slack's error word a failure carried, or undefined for any other failure. */
function slackErrorOf(error: unknown): string | undefined {
  return error instanceof SlackCallError ? error.slackError : undefined;
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
 *   SlackCallError: If HTTP or Slack reports failure.
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
  const response = await fetcher(slackApiUrl(method), {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // A proxy's or Slack's own HTML error page: the status is all it says.
    throw new SlackCallError(
      `Slack ${method} returned HTTP ${response.status} with a body that is not JSON.`,
    );
  }
  if (!response.ok || payload.ok !== true) {
    throw typeof payload.error === 'string'
      ? new SlackCallError(`Slack ${method} failed: ${payload.error}`, payload.error)
      : new SlackCallError(`Slack ${method} returned HTTP ${response.status}.`);
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
  if (
    typeof appId !== 'string' ||
    typeof clientId !== 'string' ||
    typeof clientSecret !== 'string'
  ) {
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

/**
 * Ask Slack to revoke the configuration token and record what Slack answered.
 *
 * Day0's own copy is revoked by `credentials.revokeInternal`; the token itself
 * stays live at Slack for twelve hours unless Slack revokes it (P7-3). Slack
 * does not document whether `auth.revoke` accepts a configuration token, so
 * the answer is recorded as `surface.configuration-token-revoked` with
 * `atProvider` rather than assumed. It never throws: the app the token
 * registered does not depend on it.
 */
async function revokeConfigurationToken(
  ctx: ActionCtx,
  fetcher: Fetcher,
  surface: Doc<'surfaces'>,
  token: string,
): Promise<void> {
  let failure: string | undefined;
  try {
    const answer = await callSlack(fetcher, 'auth.revoke', { token, form: {} });
    if (answer.revoked !== true) failure = 'Slack auth.revoke did not report the token revoked.';
  } catch (error: unknown) {
    failure = safeFailureMessage(error, token, 'Slack auth.revoke failed.');
  }
  await logEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.configuration-token-revoked',
    payload: {
      surfaceId: surface._id,
      atProvider: failure === undefined,
      ...(failure ? { reason: failure } : {}),
    },
  });
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

/** How many times a use re-reads the configuration token after losing to a concurrent rotation. */
const ROTATION_READS = 3;

/** A configuration token that opens, the connection it is for, and whether this use rotated it. */
interface UsableConfiguration {
  readonly connection: Doc<'organisationConnections'>;
  readonly token: string;
  readonly rotated: boolean;
}

/** The value a snapshot's row holds, opened from that snapshot (never re-read). */
function openHeld(row: Doc<'credentials'>): string {
  if (row.ciphertext === undefined || row.iv === undefined) {
    throw new Error('The organisation holds no value for this Slack token.');
  }
  return openOwnedCredential(
    {
      ciphertext: row.ciphertext,
      iv: row.iv,
      userId: row.userId,
      ...(row.keyId === undefined ? {} : { keyId: row.keyId }),
    },
    credentialKeyring(),
    { allowUnbound: false },
  );
}

/** A value sealed for the organisation (F18), as the rotation's write stores it. */
function sealedForOrganisation(value: string): { ciphertext: string; iv: string; keyId: string } {
  return sealForOwner(value, credentialKeyring(), ORGANISATION_OWNER_KEY);
}

/** What one rotation came to: the new token, written; or the pair moved on and is read again. */
type RotationOutcome =
  | { readonly kind: 'rotated'; readonly token: string }
  | { readonly kind: 'moved' };

/**
 * Rotate the connection's configuration token with its kept refresh token
 * (`tooling.tokens.rotate`, S2) and write the new pair before anything uses it, under the
 * generation the snapshot read: a concurrent rotation that wrote first wins, and this one answers
 * `moved` for the caller to read the winner's. A refusal is written on the connection's ledger;
 * a spent refresh token marks the connection for IT's attention.
 *
 * @throws Error with Slack's words when Slack refused and the pair had not moved on.
 */
async function rotateConfiguration(
  ctx: ActionCtx,
  held: HeldConfigurationRows,
  dependencies: ProvisionDependencies,
): Promise<RotationOutcome> {
  if (held.refresh === null)
    throw new Error('The organisation holds no refresh token to rotate with.');
  const expectedGeneration = held.secret.generation ?? 0;
  const refreshToken = openHeld(held.refresh);
  const identity = {
    organisationConnectionId: held.connection._id,
    secretCredentialId: held.secret._id,
    expectedGeneration,
  };
  let rotated: ReturnType<typeof parseTokenRotation>;
  try {
    rotated = parseTokenRotation(
      await callSlack(dependencies.fetch, 'tooling.tokens.rotate', {
        form: { refresh_token: refreshToken },
      }),
      dependencies.now(),
    );
  } catch (error: unknown) {
    const reason = safeFailureMessage(error, refreshToken, 'Slack tooling.tokens.rotate failed.');
    const { moved } = await ctx.runMutation(internal.slackProvision.recordRotationRefused, {
      ...identity,
      reason,
      spent: rotationRefusal(slackErrorOf(error)) === 'spent',
      now: dependencies.now(),
    });
    if (moved) return { kind: 'moved' };
    throw new SlackCallError(reason, slackErrorOf(error));
  }
  const recorded: RotationRecorded = await ctx.runMutation(internal.slackProvision.recordRotation, {
    ...identity,
    token: sealedForOrganisation(rotated.token),
    refresh: sealedForOrganisation(rotated.refreshToken),
    expiresAt: rotated.expiresAt,
    now: dependencies.now(),
  });
  return recorded.ok ? { kind: 'rotated', token: rotated.token } : { kind: 'moved' };
}

/**
 * The organisation's configuration token, current for one use: used as it is while it has life
 * left, else rotated first (B9). A rotation that lost to a concurrent one reads the winner's.
 *
 * @param organisationConnectionId - The Slack configuration connection.
 * @param options.rotate - Rotate whatever the token's expiry says, as after Slack refused it.
 * @throws Error when the connection holds no live token, or Slack refused the rotation.
 */
async function currentConfiguration(
  ctx: ActionCtx,
  organisationConnectionId: Id<'organisationConnections'>,
  dependencies: ProvisionDependencies,
  options: { readonly rotate: boolean } = { rotate: false },
): Promise<UsableConfiguration> {
  for (let read = 0; read < ROTATION_READS; read += 1) {
    const held: HeldConfigurationRows | null = await ctx.runQuery(
      internal.slackProvision.heldConfiguration,
      { organisationConnectionId },
    );
    if (held === null) throw new Error(NO_CONFIGURATION_TOKEN);
    const renewal =
      options.rotate && held.refresh !== null
        ? 'rotate'
        : configurationRenewal(
            {
              ...(held.secret.expiresAt === undefined ? {} : { expiresAt: held.secret.expiresAt }),
              refreshable: held.refresh !== null,
            },
            dependencies.now(),
          );
    if (renewal === 'use') {
      return { connection: held.connection, token: openHeld(held.secret), rotated: false };
    }
    const outcome = await rotateConfiguration(ctx, held, dependencies);
    if (outcome.kind === 'rotated') {
      return { connection: held.connection, token: outcome.token, rotated: true };
    }
  }
  throw new Error(
    "The organisation's Slack configuration token kept changing while Day0 read it; try again.",
  );
}

/** The app `apps.manifest.create` created, and the connection whose token created it. */
interface CreatedApp {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly organisationConnectionId?: Id<'organisationConnections'>;
}

/**
 * Create the app with `apps.manifest.create` and read its credentials. Slack answered ok, so an
 * app exists even when its reply carried no credentials: that is recorded as
 * `surface.app-unrecorded` and named, since Day0 cannot install it (P3-17).
 */
async function createApp(
  ctx: ActionCtx,
  surface: Doc<'surfaces'>,
  ownerKey: string,
  token: string,
  built: SlackAppManifest,
  dependencies: ProvisionDependencies,
  onAnswer: (outcome: { readonly appId?: string; readonly failure?: string }) => Promise<void>,
): Promise<{ appId: string; clientId: string; clientSecret: string }> {
  let reply: Record<string, unknown>;
  try {
    reply = await callSlack(dependencies.fetch, 'apps.manifest.create', {
      token,
      form: { manifest: JSON.stringify(built.manifest) },
    });
  } catch (error: unknown) {
    await onAnswer({
      failure: safeFailureMessage(error, token, 'Slack apps.manifest.create failed.'),
    });
    throw error;
  }
  const appId = typeof reply.app_id === 'string' ? reply.app_id : undefined;
  await onAnswer(appId === undefined ? {} : { appId });
  try {
    return parseManifestCreate(reply);
  } catch (error: unknown) {
    await logEvent(
      ctx,
      {
        agentId: surface.agentId,
        type: 'surface.app-unrecorded',
        payload: { surfaceId: surface._id, ...(appId ? { appId } : {}) },
      },
      { startedUnder: ownerKey },
    );
    if (!appId) throw error;
    throw new Error(
      `Slack created app ${appId} but its reply carried no client credentials, so Day0 cannot ` +
        `install it; delete app ${appId} in Slack's app settings before provisioning again.`,
    );
  }
}

/**
 * Create the app with the organisation's Slack configuration connection: its token made current
 * first, and the call written on the connection's ledger whatever Slack answered. When Slack
 * refuses a token Day0 held as current (revoked, or ended early), it is rotated and the creation
 * tried once more.
 */
async function createThroughConnection(
  ctx: ActionCtx,
  surface: Doc<'surfaces'>,
  ownerKey: string,
  organisationConnectionId: Id<'organisationConnections'>,
  built: SlackAppManifest,
  dependencies: ProvisionDependencies,
): Promise<CreatedApp> {
  const recordUse = async (outcome: {
    readonly appId?: string;
    readonly failure?: string;
  }): Promise<void> => {
    await ctx.runMutation(internal.slackProvision.recordConfigurationUse, {
      organisationConnectionId,
      method: 'apps.manifest.create',
      outcome: outcome.failure === undefined ? 'done' : 'failed',
      ...(outcome.failure === undefined ? {} : { reason: outcome.failure }),
      ...(outcome.appId === undefined ? {} : { appId: outcome.appId }),
      now: dependencies.now(),
    });
  };
  const current = await currentConfiguration(ctx, organisationConnectionId, dependencies);
  try {
    const created = await createApp(
      ctx,
      surface,
      ownerKey,
      current.token,
      built,
      dependencies,
      recordUse,
    );
    return { ...created, organisationConnectionId };
  } catch (error: unknown) {
    if (current.rotated || !configurationTokenRefused(slackErrorOf(error))) throw error;
  }
  const renewed = await currentConfiguration(ctx, organisationConnectionId, dependencies, {
    rotate: true,
  });
  const created = await createApp(
    ctx,
    surface,
    ownerKey,
    renewed.token,
    built,
    dependencies,
    recordUse,
  );
  return { ...created, organisationConnectionId };
}

/**
 * Create the app with a configuration token pasted on the card, where the organisation has no
 * Slack connection (Q8 (b)): the token is stored encrypted for the one call and revoked, in Day0
 * and at Slack, straight after it, whether or not the call succeeded, since it carries
 * workspace-wide app-management authority and outlives this action by twelve hours otherwise.
 */
async function createWithPastedToken(
  ctx: ActionCtx,
  surface: Doc<'surfaces'>,
  ownerKey: string,
  pasted: string,
  built: SlackAppManifest,
  dependencies: ProvisionDependencies,
): Promise<CreatedApp> {
  const configurationCredentialId: CredentialId = await ctx.runAction(
    credentialInternal.credentials.store,
    {
      userId: ownerKey,
      kind: 'value',
      label: CONFIGURATION_TOKEN_LABEL,
      plaintext: pasted,
      source: 'entered',
    },
  );
  try {
    const decrypted: string = await ctx.runAction(credentialInternal.credentials.decrypt, {
      credentialId: configurationCredentialId,
    });
    return await createApp(ctx, surface, ownerKey, decrypted, built, dependencies, async () => {});
  } finally {
    // The token is single-purpose and workspace-wide: it stops being ours the
    // moment the call that needed it has returned, success or failure.
    await ctx.runMutation(credentialInternal.credentials.revokeInternal, {
      credentialId: configurationCredentialId,
    });
    await revokeConfigurationToken(ctx, dependencies.fetch, surface, pasted);
  }
}

/** The organisation's active Slack configuration connection, or null. */
async function activeConfigurationConnection(
  ctx: ActionCtx,
): Promise<Doc<'organisationConnections'> | null> {
  const connection: Doc<'organisationConnections'> | null = await ctx.runQuery(
    internal.organisationConnections.activeFor,
    { system: SLACK_SYSTEM },
  );
  return connection?.kind === 'slack-configuration' ? connection : null;
}

/**
 * Register a dedicated provider app for one employee, or issue its kept app's install link again.
 *
 * The employee acts as its own Slack app (D2). With the organisation's Slack configuration
 * connection (B9) the app is created with no token pasted: the kept configuration token is made
 * current with its refresh token first, written before it is used, and every use is on the
 * connection's ledger. Without one, the card's pasted configuration token is used once and revoked
 * (Q8 (b)). The manifest is the documentation's template, else the access kit's. The app's client
 * secret is held by the organisation (the wave 11 common rules), so a handover keeps the identity
 * (A25). A card that already has its app, before its install or after an expiry or a Disconnect
 * (A26's `reissue: 'install'`), is given a fresh install link for that app and no second one.
 *
 * Args:
 *   ctx: Convex Node action context.
 *   surfaceId: The approved chat surface the app belongs to.
 *   configurationToken: A configuration token pasted on the card, when the organisation has no
 *     Slack connection; ignored (and revoked) when it has one.
 *
 * Returns:
 *   The app's id and name and the install link for the administrator.
 */
export async function runProvisionApp(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
  configurationToken: string | undefined,
  dependencies: ProvisionDependencies = provisionDependencies,
): Promise<ProvisionOutcome> {
  const { agent, surface, ownerKey } = await provisionableCard(ctx, surfaceId);
  const pasted = configurationToken?.trim() || undefined;
  const publicUrl = publicUrlOrThrow();
  const now = dependencies.now();
  const kept = surface.provisioning;
  if (kept) {
    // A token pasted for an app the card already has is not needed: revoked unused rather than
    // left live for twelve hours.
    if (pasted) await revokeConfigurationToken(ctx, dependencies.fetch, surface, pasted);
    return await reissueKeptApp(ctx, surface, kept, dependencies, now);
  }
  const pages: Doc<'docPages'>[] = await ctx.runQuery(internal.orientationData.pagesForAgent, {
    agentId: surface.agentId,
  });
  const built = slackAppManifest({
    documentation: pages.map((page: Doc<'docPages'>): string => page.markdown).join('\n\n'),
    employeeName: agent.name,
    publicUrl,
  });
  const created = await createEmployeeApp(ctx, surface, ownerKey, pasted, built, dependencies);
  return await recordCreatedApp(ctx, { surface, ownerKey }, created, built, dependencies, now);
}

/** The card an app is provisioned for, its employee, and the owner the action started under. */
interface ProvisionableCard {
  readonly agent: Doc<'agents'>;
  readonly surface: Doc<'surfaces'>;
  readonly ownerKey: string;
}

/**
 * Read the card and refuse one that cannot have its own Slack app: not a chat card, not approved,
 * already holding a connected app's identity, or documented at another host than Slack's.
 *
 * @throws Error naming why the card cannot have an app.
 */
async function provisionableCard(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
): Promise<ProvisionableCard> {
  const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, { surfaceId });
  if (!context) throw new Error('Surface not found.');
  const { agent, surface } = context;
  if (!agent.userId) throw new Error('Agent has no owner.');
  if (surface.class !== 'chat') {
    throw new Error('Only a chat surface provisions a dedicated app for this employee.');
  }
  if (surface.managerApprovedAt === undefined) {
    throw new Error('The connection needs its approval before an app is registered for it.');
  }
  if (
    surface.verdict === 'connected' &&
    surface.credentialKind === 'oauth' &&
    surface.credentialId
  ) {
    throw new Error(
      'This surface already has a connected dedicated identity. Revoke it before installing a replacement.',
    );
  }
  if (!surface.endpoint?.startsWith(SLACK_API)) {
    throw new Error('The documented endpoint is not the approved Slack host.');
  }
  return { agent, surface, ownerKey: agent.userId };
}

/**
 * File a fresh install link for the app the card already has: the second click before its install,
 * or the renewal after an expiry or a Disconnect (A26's `reissue: 'install'`), with no
 * configuration token and never a second app (P3-17). An app whose creating connection IT revoked
 * is not installed again.
 *
 * @throws Error with {@link KEPT_APP_CONNECTION_REVOKED}.
 */
async function reissueKeptApp(
  ctx: ActionCtx,
  surface: Doc<'surfaces'>,
  kept: NonNullable<Doc<'surfaces'>['provisioning']>,
  dependencies: ProvisionDependencies,
  now: number,
): Promise<ProvisionOutcome> {
  if (kept.organisationConnectionId !== undefined) {
    const creator: Doc<'organisationConnections'> | null = await ctx.runQuery(
      internal.organisationConnections.getInternal,
      { organisationConnectionId: kept.organisationConnectionId },
    );
    if (creator?.status === 'revoked') throw new Error(KEPT_APP_CONNECTION_REVOKED);
  }
  const link = installLink(surface, kept, dependencies, now);
  await ctx.runMutation(internal.slackProvision.recordInstallLink, {
    surfaceId: surface._id,
    appId: kept.appId,
    ...link,
    now,
  });
  return { appId: kept.appId, appName: kept.appName, installUrl: link.installUrl };
}

/**
 * Create the employee's app: with the organisation's Slack configuration connection where there
 * is one (B9), else with the token pasted on the card (Q8 (b)). A token pasted beside a connection
 * is the fallback when the connection cannot create the app (its refresh token spent, say), and is
 * revoked unused when it can, after the creation rather than before, so a failing connection never
 * costs the manager the token they pasted.
 *
 * @throws Error with {@link NO_CONFIGURATION_TOKEN} when there is neither, else Slack's refusal.
 */
async function createEmployeeApp(
  ctx: ActionCtx,
  surface: Doc<'surfaces'>,
  ownerKey: string,
  pasted: string | undefined,
  built: SlackAppManifest,
  dependencies: ProvisionDependencies,
): Promise<CreatedApp> {
  const connection = await activeConfigurationConnection(ctx);
  if (connection === null) {
    if (pasted === undefined) throw new Error(NO_CONFIGURATION_TOKEN);
    return await createWithPastedToken(ctx, surface, ownerKey, pasted, built, dependencies);
  }
  let created: CreatedApp;
  try {
    created = await createThroughConnection(
      ctx,
      surface,
      ownerKey,
      connection._id,
      built,
      dependencies,
    );
  } catch (error: unknown) {
    if (pasted === undefined) throw error;
    log.warn('slack app created with the pasted token: the connection could not', {
      reason: safeFailureMessage(error, pasted, 'the connection failed'),
    });
    return await createWithPastedToken(ctx, surface, ownerKey, pasted, built, dependencies);
  }
  if (pasted !== undefined)
    await revokeConfigurationToken(ctx, dependencies.fetch, surface, pasted);
  return created;
}

/**
 * Store the created app's client secret as a row the organisation holds, its holder passed to the
 * store itself, and record the app with its install link; the record stamps the secret's
 * `issuedBy`. When the record is refused, the secret is revoked in Day0 so no row the organisation
 * holds is left live with nothing naming it, and the app Slack created is named for deletion.
 */
async function recordCreatedApp(
  ctx: ActionCtx,
  { surface, ownerKey }: { readonly surface: Doc<'surfaces'>; readonly ownerKey: string },
  created: CreatedApp,
  built: SlackAppManifest,
  dependencies: ProvisionDependencies,
  now: number,
): Promise<ProvisionOutcome> {
  const clientSecretCredentialId: CredentialId = await ctx.runAction(
    credentialInternal.credentials.store,
    {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'oauth',
      label: `${built.appName} client secret`,
      plaintext: created.clientSecret,
      source: 'oauth',
      appId: created.appId,
      issuedBy: slackClientSecretIssuer({
        appId: created.appId,
        clientId: created.clientId,
        ...(created.organisationConnectionId === undefined
          ? {}
          : { organisationConnectionId: created.organisationConnectionId }),
      }),
    },
  );
  const app: RegisteredApp = {
    appId: created.appId,
    clientId: created.clientId,
    redirectUrl: built.redirectUrl,
    scopes: built.scopes,
  };
  const link = installLink(surface, app, dependencies, now);
  try {
    await ctx.runMutation(internal.slackProvision.recordCreatedApp, {
      surfaceId: surface._id,
      ...app,
      scopes: [...app.scopes],
      appName: built.appName,
      clientSecretCredentialId,
      ...(created.organisationConnectionId === undefined
        ? {}
        : { organisationConnectionId: created.organisationConnectionId }),
      ...link,
      startedUnder: ownerKey,
      now,
    });
  } catch (error: unknown) {
    await ctx.runMutation(credentialInternal.credentials.revokeInternal, {
      credentialId: clientSecretCredentialId,
    });
    throw new Error(
      `Slack created app ${created.appId}, but Day0 could not record it for this card ` +
        `(${error instanceof Error ? error.message : String(error)}); delete app ${created.appId} ` +
        "in Slack's app settings.",
    );
  }
  return { appId: created.appId, appName: built.appName, installUrl: link.installUrl };
}

/** A registered app, as the install link is built from it. */
interface RegisteredApp {
  readonly appId: string;
  readonly clientId: string;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
}

/** A fresh single-use install link and the state that binds it to the card. */
interface InstallLink {
  readonly installUrl: string;
  readonly stateNonce: string;
  readonly stateExpiresAt: number;
}

/**
 * Sign a fresh single-use install state for a registered app and build its link.
 *
 * Returns:
 *   The link the administrator clicks and the nonce and expiry the card keeps for it.
 */
function installLink(
  surface: Doc<'surfaces'>,
  app: RegisteredApp,
  dependencies: ProvisionDependencies,
  now: number,
): InstallLink {
  const stateNonce = dependencies.newNonce();
  const stateExpiresAt = now + OAUTH_STATE_TTL_MS;
  const state = signOauthState(
    { expiresAt: stateExpiresAt, nonce: stateNonce, surfaceId: String(surface._id) },
    process.env.DAY0_CREDENTIAL_KEY,
  );
  const installUrl = slackInstallUrl({
    clientId: app.clientId,
    redirectUrl: app.redirectUrl,
    scopes: app.scopes,
    state,
  });
  return { installUrl, stateNonce, stateExpiresAt };
}

/**
 * Owner-checked entry point for the card's "Provision a dedicated app" control. With the
 * organisation's Slack connection the card pastes nothing; without one it pastes a configuration
 * token (Q8 (b)).
 */
export const provisionApp = action({
  args: { surfaceId: v.id('surfaces'), configurationToken: v.optional(v.string()) },
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
        safeFailureMessage(
          error,
          args.configurationToken ?? '',
          'The app could not be registered.',
        ),
      );
    }
  },
});

/** How long a paused deployment's renewal waits before it looks again. */
const KEEP_CURRENT_PAUSED_RETRY_MS = 60 * 60 * 1000;

/** How long a renewal Slack could not answer waits before its next try, for its first tries. */
const KEEP_CURRENT_RETRY_MS = 15 * 60 * 1000;

/** How many tries wait {@link KEEP_CURRENT_RETRY_MS}; each later one waits an hour. */
const KEEP_CURRENT_QUICK_RETRIES = 4;

/** How long each later try waits: past the token's lapse the refresh token still renews it. */
const KEEP_CURRENT_SLOW_RETRY_MS = 60 * 60 * 1000;

/** One scheduled renewal: the connection and the token generation it was queued for. */
interface KeepCurrentJob {
  readonly organisationConnectionId: Id<'organisationConnections'>;
  readonly secretCredentialId: Id<'credentials'>;
  readonly generation: number;
  readonly attempt?: number;
}

/**
 * Renew the organisation's kept configuration token before it lapses, though nothing uses it
 * (B9), so a retire's `apps.manifest.delete` (11-AR, which reads the stored token as it stands)
 * finds it current. The landing and a rotation by hand queue the first (m9), each rotation the
 * next ({@link keepCurrentAt}); a job finds nothing to
 * do when the connection is revoked or needs IT, or when another rotation moved the pair on
 * (that rotation queued its own). A token IT rotated by hand since is adopted and renewed at once.
 * A paused deployment calls no vendor (`DAY0_CRONS_PAUSED`), and looks again an hour later. A
 * renewal Slack could not answer is tried again, every quarter-hour at first and then hourly, for
 * as long as the connection stands: the refresh token renews the token after it lapses too, and a
 * retire needs it current (11-AR). Slack's refusal of the refresh token ends the renewals, the
 * connection left for IT (`needs-attention`).
 */
async function runKeepConfigurationCurrent(
  ctx: ActionCtx,
  job: KeepCurrentJob,
  dependencies: ProvisionDependencies = provisionDependencies,
): Promise<void> {
  const reason = cronsPauseReason();
  if (reason !== undefined) {
    log.info('slack configuration renewal deferred: deployment paused', { reason });
    await ctx.scheduler.runAfter(
      KEEP_CURRENT_PAUSED_RETRY_MS,
      internal.slackProvisionActions.keepConfigurationCurrent,
      { ...job },
    );
    return;
  }
  const held: HeldConfigurationRows | null = await ctx.runQuery(
    internal.slackProvision.heldConfiguration,
    { organisationConnectionId: job.organisationConnectionId },
  );
  if (held === null || held.connection.status !== 'active' || held.refresh === null) return;
  const adopted = held.secret._id !== job.secretCredentialId;
  if (!adopted && (held.secret.generation ?? 0) !== job.generation) return;
  try {
    await rotateConfiguration(ctx, held, dependencies);
  } catch (error: unknown) {
    const attempt = (job.attempt ?? 0) + 1;
    const spent = rotationRefusal(slackErrorOf(error)) === 'spent';
    log.warn('slack configuration renewal failed', {
      attempt,
      spent,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (spent) return;
    await ctx.scheduler.runAfter(
      attempt <= KEEP_CURRENT_QUICK_RETRIES ? KEEP_CURRENT_RETRY_MS : KEEP_CURRENT_SLOW_RETRY_MS,
      internal.slackProvisionActions.keepConfigurationCurrent,
      {
        organisationConnectionId: job.organisationConnectionId,
        secretCredentialId: held.secret._id,
        generation: held.secret.generation ?? 0,
        attempt,
      },
    );
  }
}

/** The scheduled renewal of the organisation's Slack configuration token. Internal. */
export const keepConfigurationCurrent = internalAction({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    secretCredentialId: v.id('credentials'),
    generation: v.number(),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await runKeepConfigurationCurrent(ctx, args);
    return null;
  },
});

/** The most pages of public channels the re-join reads. */
const REJOIN_CHANNEL_PAGES = 10;

/** The public channels the bot can see, with its membership of each. */
async function publicChannels(fetcher: Fetcher, token: string): Promise<VisibleChannel[]> {
  const visible: VisibleChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < REJOIN_CHANNEL_PAGES; page += 1) {
    const payload = await callSlack(fetcher, 'conversations.list', {
      token,
      form: {
        exclude_archived: 'true',
        limit: '200',
        types: 'public_channel',
        ...(cursor ? { cursor } : {}),
      },
    });
    for (const item of Array.isArray(payload.channels) ? payload.channels : []) {
      const channel =
        item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
      if (typeof channel?.id !== 'string' || typeof channel.name !== 'string') continue;
      visible.push({ id: channel.id, name: channel.name, isMember: channel.is_member === true });
    }
    const metadata = payload.response_metadata as { next_cursor?: unknown } | undefined;
    cursor =
      typeof metadata?.next_cursor === 'string' && metadata.next_cursor.trim()
        ? metadata.next_cursor.trim()
        : undefined;
    if (!cursor) break;
  }
  return visible;
}

/**
 * After a renewal installed the employee's own app again, re-join the public channels its approved
 * intake scope names, which Slack took the bot out of when its token was revoked (S1; RM4, ruled):
 * `conversations.join` for each public one, and every other (a private channel, one the workspace
 * does not have, or a join Slack refused) named as needing a person in it. Writes
 * `surface.channels-rejoined`; never throws, since the install has landed either way.
 */
async function rejoinIntakeChannels(
  ctx: ActionCtx,
  surface: Doc<'surfaces'>,
  token: string,
  dependencies: ProvisionDependencies,
): Promise<void> {
  const approved = surface.intakeScope ? approvedChannelNames(surface.intakeScope) : [];
  if (approved.length === 0) return;
  const joined: string[] = [];
  const needsPerson: string[] = [];
  let reason: string | undefined;
  try {
    const plan = rejoinPlan(approved, await publicChannels(dependencies.fetch, token));
    joined.push(...plan.alreadyIn);
    for (const channel of plan.join) {
      try {
        await callSlack(dependencies.fetch, 'conversations.join', {
          token,
          form: { channel: channel.id },
        });
        joined.push(`#${channel.name}`);
      } catch (error: unknown) {
        needsPerson.push(`#${channel.name}`);
        reason ??= slackErrorOf(error) ?? safeFailureMessage(error, token, 'the join failed');
      }
    }
    needsPerson.push(...plan.needsPerson);
  } catch (error: unknown) {
    needsPerson.push(...rejoinPlan(approved, []).needsPerson);
    reason = slackErrorOf(error) ?? safeFailureMessage(error, token, 'the channel list failed');
  }
  await logEvent(ctx, {
    agentId: surface.agentId,
    type: 'surface.channels-rejoined',
    payload: {
      surfaceId: surface._id,
      joined,
      needsPerson,
      ...(reason === undefined ? {} : { reason }),
    },
  });
}

/**
 * Take back a bot token stored for an install that could not be recorded: revoked in Day0, and at
 * Slack, each tried whatever the other did, so no row the organisation holds is left live with
 * nothing naming it and no bot is left live at Slack. Never throws; the install's own failure is
 * the one the caller reports, and each release that fails is logged.
 */
async function releaseInstalledToken(
  ctx: ActionCtx,
  credentialId: CredentialId,
  token: string,
  dependencies: ProvisionDependencies,
): Promise<void> {
  const [inDay0, atSlack] = await Promise.allSettled([
    ctx.runMutation(credentialInternal.credentials.revokeInternal, { credentialId }),
    callSlack(dependencies.fetch, 'auth.revoke', { token, form: {} }),
  ]);
  for (const [where, outcome] of [
    ['in Day0', inDay0],
    ['at Slack', atSlack],
  ] as const) {
    if (outcome.status === 'rejected') {
      log.warn('an unrecorded install token was not released', {
        where,
        reason: safeFailureMessage(outcome.reason, token, 'the release failed'),
      });
    }
  }
}

/**
 * Complete one OAuth install and attach the dedicated identity to its surface.
 *
 * This is the one action reached without a caller identity, so the signed
 * single-use state is what authorises it: an unsigned, expired or already-used
 * state is refused before the provider is called at all, and the surface the
 * state names is the only surface it can ever write to. The bot token is held by
 * the organisation (the wave 11 common rules); `recordInstalledApp` writes its
 * `issuedBy`, whom the card acts as, and the card's link to the connection that
 * created the app. An install of an app the card had installed before is a
 * renewal, after which the employee re-joins its public intake channels (RM4).
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
  const renewal = context.surface.provisioning?.installedAt !== undefined;

  let clientSecret = '';
  let landed: { credentialId: CredentialId; token: string } | undefined;
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
    landed = {
      token: access.botToken,
      credentialId: await ctx.runAction(credentialInternal.credentials.store, {
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        kind: 'oauth',
        label: `${context.surface.displayName} bot token (${claim.slug} dedicated app)`,
        plaintext: access.botToken,
        source: 'oauth',
        appId: context.surface.provisioning?.appId,
        ...(context.surface.provisioning === undefined
          ? {}
          : { issuedBy: installedBotIssuer(context.surface.provisioning) }),
      }),
    };
    await ctx.runMutation(internal.surfaces.recordInstalledApp, {
      surfaceId: surfaceRef,
      credentialId: landed.credentialId,
      ...(access.botUserId === undefined ? {} : { botUserId: access.botUserId }),
      now: dependencies.now(),
    });
  } catch (error) {
    if (landed !== undefined) {
      await releaseInstalledToken(ctx, landed.credentialId, landed.token, dependencies);
    }
    const reason = safeFailureMessage(error, clientSecret, 'The install could not be completed.');
    await ctx.runMutation(internal.surfaces.recordInstallFailure, {
      surfaceId: surfaceRef,
      reason,
      now: dependencies.now(),
    });
    return { ok: false, agentId: claim.agentId, reason };
  } finally {
    clientSecret = '';
  }
  if (renewal) await rejoinIntakeChannels(ctx, context.surface, landed.token, dependencies);
  await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
    surfaceId: surfaceRef,
    renewExpiry: true,
  });
  return { ok: true, agentId: claim.agentId, surfaceSlug: claim.slug };
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

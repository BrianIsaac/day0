'use node';

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { credentialKeyring, requireCredentialKey } from './credentialCryptoActions';
import type {
  ClaimedLinearAuthorisation,
  HeldLinearToken,
  LinearClaimFailure,
  LinearIssuerContext,
  LinearRotationOutcome,
} from './linearIdentity';
import { assertAdministrator, assertOwnsAgentAction, callerIsAdministrator } from './ownership';
import { openOwnedCredential, sealForOwner } from '../src/lib/credential-crypto';
import { log } from '../src/lib/logger';
import {
  newOauthNonce,
  OAUTH_STATE_MESSAGES,
  OAUTH_STATE_TTL_MS,
  signOauthState,
  verifyOauthState,
} from '../src/lib/oauth-state';
import { ORGANISATION_OWNER_KEY } from '../src/lib/organisation-key';
import { assertRealMode } from '../src/lib/surface-mode';
import { organisationSystemOf } from '../src/surfaces/access-request';
import { decryptCredential } from '../src/surfaces/credentials';
import { LINEAR_MCP_ENDPOINT } from '../src/surfaces/fixed-endpoints';
import {
  isTokenRefusal,
  LINEAR_ISSUER,
  LINEAR_OAUTH_REDIRECT_PATH,
  LINEAR_SYSTEM,
  LinearIssuerRefusal,
  linearAuthorisationUrl,
  newPkcePair,
  readLinearViewer,
  requestAppActorToken,
  requestLinearTokens,
  requireAppViewer,
  revokeLinearToken,
  SHARED_TOKEN_RENEWAL_LEAD_MS,
  TOKEN_READ_MARGIN_MS,
  tokenDue,
  type LinearFetch,
  type LinearIssuedTokens,
  type LinearViewer,
} from '../src/surfaces/identity-issuers/linear';
import { safeFailureMessage } from '../src/surfaces/redact';

/*
 * Linear's issuer in the deployment (wave 11, 11-AL; the access plan, section 4.10). Shared mode:
 * the card's Connect lands the organisation's one app-actor token, requested by the
 * `client_credentials` grant with the connection's fixed scope set (L2), used until its last day
 * and requested once again when Linear refuses it (a 401, "fetch a new token"). Per-employee mode:
 * an administrator records the employee's own app and installs it with `actor=app`; the redirect
 * (`app/api/oauth/linear`) lands the pair, and the 24-hour access token is refreshed ahead of its
 * expiry, and at read time when due, through the rotation-safe write (L3).
 *
 * Every Linear token a card holds is read through {@link readLinearBearer}: the seam the runtime's
 * readers (intake, the probe, and once 11-AM's runtime read chains to it, the adapters) call.
 */

/** How many times a scheduled renewal that could not reach Linear is tried again. */
const SCHEDULED_RENEWAL_RETRIES = 5;

/** The longest reason the record keeps. */
const REASON_MAX = 300;

/** The issuer's dependencies: Linear's transport and the clock. */
export interface LinearIdentityDeps {
  readonly fetch: LinearFetch;
  readonly now: () => number;
}

/** The test seam's replacements, when a test has set them. */
let depsForTest: Partial<LinearIdentityDeps> | undefined;

/**
 * Replace the issuer's transport or clock for a test, or restore them with undefined.
 *
 * @param deps - The replacements.
 */
export function __setLinearIdentityDepsForTest(
  deps: Partial<LinearIdentityDeps> | undefined,
): void {
  depsForTest = deps;
}

/** The issuer's dependencies: the platform's `fetch` and clock unless a test replaced them. */
function linearIdentityDeps(): LinearIdentityDeps {
  return {
    fetch: depsForTest?.fetch ?? (async (url, init) => await fetch(url, init)),
    now: depsForTest?.now ?? Date.now,
  };
}

/** A token or secret sealed for the organisation. */
function sealed(value: string): { ciphertext: string; iv: string; keyId: string } {
  return sealForOwner(value, credentialKeyring(), ORGANISATION_OWNER_KEY);
}

/** A reason cut to what the record keeps, with any token Linear issued removed. */
function clipped(error: unknown, fallback: string, secrets: readonly string[] = []): string {
  return safeFailureMessage(error, secrets[0] ?? '', fallback, REASON_MAX, secrets.slice(1));
}

/** Why a card's Connect did not connect it: a refusal the card shows. */
export const CONNECT_REFUSALS = [
  'not-approved',
  'not-linear',
  'no-connection',
  'not-an-app-connection',
  'install-needed',
] as const;

/** One of {@link CONNECT_REFUSALS}. */
export type ConnectRefusal = (typeof CONNECT_REFUSALS)[number];

/** What a card's Connect answered: connected, the installation link, or why not. */
export type ConnectOutcome =
  | { readonly ok: true; readonly connected: true }
  | { readonly ok: true; readonly authoriseUrl: string }
  | { readonly ok: false; readonly reason: ConnectRefusal; readonly message: string };

/** What starting or registering an installation answered: its link, or why not. */
export type InstallStart =
  | { readonly ok: true; readonly authoriseUrl: string }
  | { readonly ok: false; readonly reason: ConnectRefusal; readonly message: string };

/** What the redirect's completion answered, as the route's landing reads it. */
export interface LinearAuthorisationResult {
  readonly ok: boolean;
  readonly agentId?: string;
  readonly surfaceSlug?: string;
  readonly reason?: string;
}

/** A refusal the card shows. */
type Refused = { readonly ok: false; readonly reason: ConnectRefusal; readonly message: string };

/**
 * The organisation's Linear app connection a card connects through, or why it cannot, before any
 * request is made.
 */
function connectableThrough(
  context: LinearIssuerContext,
): { readonly ok: true; readonly connection: Doc<'organisationConnections'> } | Refused {
  if (context.surface.managerApprovedAt === undefined) {
    return { ok: false, reason: 'not-approved', message: 'Approve the card before connecting it.' };
  }
  if (organisationSystemOf(context.surface) !== LINEAR_SYSTEM) {
    return { ok: false, reason: 'not-linear', message: 'This card is not a Linear card.' };
  }
  const connection = context.connection;
  if (connection === null) {
    return {
      ok: false,
      reason: 'no-connection',
      message: 'Linear is not connected for the organisation yet: send IT the access request.',
    };
  }
  if (connection.kind !== 'oauth-app') {
    return {
      ok: false,
      reason: 'not-an-app-connection',
      message: `${connection.displayName} is connected as a ${connection.kind}, not as Linear's app.`,
    };
  }
  return { ok: true, connection };
}

/** The card and its connection, or a ConvexError when the card is gone. */
async function contextOf(ctx: ActionCtx, surfaceId: Id<'surfaces'>): Promise<LinearIssuerContext> {
  const context = await ctx.runQuery(internal.linearIdentity.issuerContext, { surfaceId });
  if (!context) throw new ConvexError('Surface not found.');
  return context;
}

/** A credential's value through the credentials action, which records its use. */
async function valueOf(ctx: ActionCtx, credentialId: Id<'credentials'>): Promise<string> {
  return await decryptCredential(ctx, credentialId);
}

/** The shared token in hand: its row, its generation and its value. */
interface SharedToken {
  readonly credentialId: Id<'credentials'>;
  readonly generation: number;
  readonly bearer: string;
}

/**
 * The organisation's shared app-actor token, requested only when the connection holds none, the one
 * it holds is in its last day, or Linear refused the one at `refused` (L2: "fetch a new token if it
 * receives a 401"). Always requested with the connection's scope set (`requestAppActorToken`).
 * A renewal that loses to a concurrent one uses the winner's token.
 *
 * @throws LinearIssuerRefusal when Linear refuses the request; Error when the connection is gone.
 */
async function sharedToken(
  ctx: ActionCtx,
  organisationConnectionId: Id<'organisationConnections'>,
  deps: LinearIdentityDeps,
  refused?: number,
): Promise<SharedToken> {
  const held = await ctx.runQuery(internal.linearIdentity.sharedTokenOf, {
    organisationConnectionId,
  });
  if (held === null || held.connection.status !== 'active') {
    throw new Error("The organisation's Linear connection is no longer active.");
  }
  const { connection, token } = held;
  const usable = token !== null && token.revokedAt === undefined && token.ciphertext !== undefined;
  const generation = token?.generation ?? 0;
  if (
    usable &&
    refused !== generation &&
    !tokenDue(token.expiresAt, deps.now(), SHARED_TOKEN_RENEWAL_LEAD_MS)
  ) {
    return { credentialId: token._id, generation, bearer: await valueOf(ctx, token._id) };
  }
  if (!connection.clientId || !connection.secretCredentialId) {
    throw new Error("The organisation's Linear connection holds no client id or secret.");
  }
  const issued = await requestAppActorToken(
    deps.fetch,
    { clientId: connection.clientId, clientCredentialsScopes: connection.clientCredentialsScopes },
    await valueOf(ctx, connection.secretCredentialId),
    deps.now(),
  );
  const landed: LinearRotationOutcome = await ctx.runMutation(
    internal.linearIdentity.landSharedToken,
    {
      organisationConnectionId,
      sealed: sealed(issued.accessToken),
      ...(issued.expiresAt === undefined ? {} : { expiresAt: issued.expiresAt }),
      ...(usable ? { expectedGeneration: generation } : {}),
      now: deps.now(),
    },
  );
  if (landed.ok) {
    return {
      credentialId: landed.credentialId,
      generation: landed.generation,
      bearer: issued.accessToken,
    };
  }
  if (landed.reason === 'stale' && landed.credentialId !== undefined) {
    // Another renewal wrote first; its token is as good as this one, which lapses unused.
    const winner = await ctx.runQuery(internal.linearIdentity.heldToken, {
      credentialId: landed.credentialId,
    });
    return {
      credentialId: landed.credentialId,
      generation: winner?.access.generation ?? 0,
      bearer: await valueOf(ctx, landed.credentialId),
    };
  }
  throw new Error(
    "The organisation's Linear connection was revoked while its token was requested.",
  );
}

/**
 * The app user a token acts as, refused unless it is an app (D2); a token Linear refuses is
 * `unauthorised`.
 */
async function appUserOf(deps: LinearIdentityDeps, bearer: string): Promise<LinearViewer> {
  return requireAppViewer(await readLinearViewer(deps.fetch, bearer));
}

/**
 * Connect a card through the organisation's shared app: link it, take the shared token (a new one
 * once when Linear refuses the held one), read the app user, and land it.
 */
async function connectShared(
  ctx: ActionCtx,
  context: LinearIssuerContext & { readonly connection: Doc<'organisationConnections'> },
  ownerKey: string,
  deps: LinearIdentityDeps,
): Promise<void> {
  const organisationConnectionId = context.connection._id;
  await ctx.runMutation(internal.organisationConnections.linkSurface, {
    surfaceId: context.surface._id,
    organisationConnectionId,
  });
  let token = await sharedToken(ctx, organisationConnectionId, deps);
  let appUser: LinearViewer;
  try {
    appUser = await appUserOf(deps, token.bearer);
  } catch (error) {
    if (!isTokenRefusal(error)) throw error;
    token = await sharedToken(ctx, organisationConnectionId, deps, token.generation);
    appUser = await appUserOf(deps, token.bearer);
  }
  await ctx.runMutation(internal.linearIdentity.connectSharedCard, {
    surfaceId: context.surface._id,
    ownerKey,
    organisationConnectionId,
    credentialId: token.credentialId,
    appUser: { id: appUser.id, name: appUser.name },
    now: deps.now(),
  });
}

/** Where Linear sends an installation back: the connection's registered address, else this deployment's. */
function redirectUrlOf(connection: Doc<'organisationConnections'>): string {
  if (connection.redirectUrl) return connection.redirectUrl;
  const origin = process.env.DAY0_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (!origin) {
    throw new ConvexError(
      'DAY0_PUBLIC_URL is not set and the Linear connection names no redirect, so Linear has nowhere to send the installation back.',
    );
  }
  return `${origin}${LINEAR_OAUTH_REDIRECT_PATH}`;
}

/** An installation's link and the pending row that completes it, for one registered app. */
interface MintedInstall {
  readonly authoriseUrl: string;
  readonly pending: NonNullable<Doc<'surfaces'>['pendingAuthorisation']>;
}

/**
 * A fresh `actor=app` installation link for an app: a signed, single-use state bound to the card,
 * and a PKCE verifier sealed for the organisation in the pending row, never in the link.
 */
async function mintInstall(
  surfaceId: Id<'surfaces'>,
  connection: Doc<'organisationConnections'>,
  app: {
    readonly clientId: string;
    readonly redirectUrl: string;
    readonly scopes: readonly string[];
  },
  now: number,
): Promise<MintedInstall> {
  const nonce = newOauthNonce();
  const stateExpiresAt = now + OAUTH_STATE_TTL_MS;
  const state = signOauthState(
    { expiresAt: stateExpiresAt, nonce, surfaceId: String(surfaceId) },
    requireCredentialKey(),
  );
  const pkce = await newPkcePair();
  const verifier = sealed(pkce.verifier);
  return {
    authoriseUrl: linearAuthorisationUrl({
      clientId: app.clientId,
      redirectUrl: app.redirectUrl,
      scopes: app.scopes,
      state,
      codeChallenge: pkce.challenge,
    }),
    pending: {
      stateNonce: nonce,
      stateExpiresAt,
      clientId: app.clientId,
      verifierCiphertext: verifier.ciphertext,
      verifierIv: verifier.iv,
      verifierKeyId: verifier.keyId,
      issuer: LINEAR_ISSUER,
      resource: LINEAR_MCP_ENDPOINT,
      redirectUrl: app.redirectUrl,
      organisationConnectionId: connection._id,
      startedAt: now,
    },
  };
}

/**
 * Connect a Linear card through the organisation's connection: the card's one Connect (the access
 * plan, section 4.3). In shared mode the card lands the organisation's app-actor token and is
 * probed; in per-employee mode, once an administrator has recorded the employee's app, it answers
 * the installation link (a Linear administrator completes it, L1), and before that the access
 * request is the way on. Public: the caller must own the employee (`assertOwnsAgentAction`); real
 * mode only. Writes the card's link, its credential and whom it acts as, or the pending installation.
 *
 * @throws ConvexError when the card is gone or the caller does not own the employee.
 */
export const connect = action({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<ConnectOutcome> => {
    assertRealMode('Connecting Linear');
    const context = await contextOf(ctx, args.surfaceId);
    const agent = await assertOwnsAgentAction(ctx, context.surface.agentId);
    const checked = connectableThrough(context);
    if (!checked.ok) return checked;
    const { connection } = checked;
    const deps = linearIdentityDeps();
    if (connection.mode === 'shared') {
      if (agent.userId === undefined) throw new ConvexError('The employee has no owner.');
      await connectShared(ctx, { ...context, connection }, agent.userId, deps);
      return { ok: true, connected: true };
    }
    return await startInstall(ctx, context, connection, deps);
  },
});

/** Start an installation of the card's recorded app, or say the access request comes first. */
async function startInstall(
  ctx: ActionCtx,
  context: LinearIssuerContext,
  connection: Doc<'organisationConnections'>,
  deps: LinearIdentityDeps,
): Promise<InstallStart> {
  const app = context.surface.provisioning;
  if (!app) {
    return {
      ok: false,
      reason: 'install-needed',
      message:
        "Linear is connected for each employee: a Linear administrator creates this employee's app and records it on the organisation page. Send IT the access request.",
    };
  }
  await ctx.runMutation(internal.organisationConnections.linkSurface, {
    surfaceId: context.surface._id,
    organisationConnectionId: connection._id,
  });
  const minted = await mintInstall(context.surface._id, connection, app, deps.now());
  await ctx.runMutation(internal.linearIdentity.recordPendingAuthorisation, {
    surfaceId: context.surface._id,
    clientId: app.clientId,
    installUrl: minted.authoriseUrl,
    pending: minted.pending,
  });
  return { ok: true, authoriseUrl: minted.authoriseUrl };
}

/**
 * Start a fresh installation of an employee's recorded Linear app, for the person who will
 * complete it: the card's owner or an administrator, since installing with `actor=app` needs a
 * Linear administrator (L1). The renewal's `reissue: 'authorise'` (11-AR) lands here. Public,
 * guarded by `callerIsAdministrator` or `assertOwnsAgentAction`; real mode only. Writes the card's
 * pending installation.
 */
export const startAuthorisation = action({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<InstallStart> => {
    assertRealMode('Installing a Linear app');
    const context = await contextOf(ctx, args.surfaceId);
    if (!(await callerIsAdministrator(ctx))) {
      await assertOwnsAgentAction(ctx, context.surface.agentId);
    }
    const checked = connectableThrough(context);
    if (!checked.ok) return checked;
    const { connection } = checked;
    if (connection.mode !== 'per-employee') {
      return {
        ok: false,
        reason: 'not-an-app-connection',
        message: "Linear is connected through the organisation's shared app: use Connect.",
      };
    }
    return await startInstall(ctx, context, connection, linearIdentityDeps());
  },
});

/** The longest app name Linear's create form takes (the manifest's `oauth.client_name`). */
const APP_NAME_MAX = 80;

/**
 * Record the employee's own Linear app, which a Linear administrator created for the card from the
 * access request (per-employee mode, L1: one app per employee, no API creates one), and start its
 * installation: the answer's link is followed by a Linear administrator, who consents to install it
 * as an app user. The client secret is sealed for the organisation, never shown again. Public,
 * guarded by `assertAdministrator` (B8); real mode only. Writes the card's app, the secret's row,
 * the pending installation and `surface.app-provisioned`.
 */
export const registerEmployeeApp = action({
  args: {
    surfaceId: v.id('surfaces'),
    clientId: v.string(),
    clientSecret: v.string(),
    appName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<InstallStart> => {
    assertRealMode('Recording a Linear app');
    await assertAdministrator(ctx);
    const context = await contextOf(ctx, args.surfaceId);
    const checked = connectableThrough(context);
    if (!checked.ok) return checked;
    const { connection } = checked;
    if (connection.mode !== 'per-employee') {
      return {
        ok: false,
        reason: 'not-an-app-connection',
        message:
          "Linear is connected through the organisation's shared app: no app per employee is recorded.",
      };
    }
    const clientId = args.clientId.trim();
    const clientSecret = args.clientSecret.trim();
    if (clientId === '' || clientSecret === '') {
      throw new ConvexError(
        "Give the app's client id and client secret from Linear's app settings.",
      );
    }
    const appName = (args.appName?.trim() || `Day0 ${context.agent.name}`).slice(0, APP_NAME_MAX);
    const deps = linearIdentityDeps();
    const now = deps.now();
    await ctx.runMutation(internal.organisationConnections.linkSurface, {
      surfaceId: context.surface._id,
      organisationConnectionId: connection._id,
    });
    const app = { clientId, redirectUrl: redirectUrlOf(connection), scopes: connection.scopes };
    const minted = await mintInstall(context.surface._id, connection, app, now);
    await ctx.runMutation(internal.linearIdentity.recordEmployeeApp, {
      surfaceId: context.surface._id,
      organisationConnectionId: connection._id,
      appName,
      clientId,
      sealedSecret: sealed(clientSecret),
      redirectUrl: app.redirectUrl,
      scopes: [...app.scopes],
      installUrl: minted.authoriseUrl,
      pending: minted.pending,
      now,
    });
    return { ok: true, authoriseUrl: minted.authoriseUrl };
  },
});

/** The words a refused claim of a pending installation reads as. */
const CLAIM_FAILURES: { readonly [Failure in LinearClaimFailure]: string } = {
  none: 'This installation link is not waiting on any card. Start it again from the card.',
  used: 'This installation link was replaced by a newer one. Use the newest link.',
  expired: 'This installation link has expired. Start it again from the card.',
  replaced: "The card's Linear app was replaced. Start the installation again from the card.",
};

/** Revoke tokens Linear issued that Day0 will not keep, so no grant is left live behind it. */
async function revokeUnkept(deps: LinearIdentityDeps, tokens: LinearIssuedTokens): Promise<void> {
  const settled = await Promise.allSettled([
    revokeLinearToken(deps.fetch, tokens.accessToken, 'access_token'),
    ...(tokens.refreshToken === undefined
      ? []
      : [revokeLinearToken(deps.fetch, tokens.refreshToken, 'refresh_token')]),
  ]);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      log.warn('linear token not kept could not be revoked; it lapses at Linear', {
        reason: clipped(outcome.reason, 'unknown', [tokens.accessToken, tokens.refreshToken ?? '']),
      });
    }
  }
}

/**
 * Complete an employee's app installation from Linear's redirect (`app/api/oauth/linear`): the
 * signed state is verified and its card's pending installation consumed once, the code exchanged
 * with the PKCE verifier and the app's secret, the token's `viewer` read and refused unless it is an
 * app user, the card linked, and the pair landed as the employee's own identity. Linear's refusal of
 * the installation and every failure land on the card's record; tokens Day0 does not keep are
 * revoked at Linear. Public and identity-free: the caller is the administrator's browser, and the
 * state is what authenticates it (Q13). Real mode only.
 */
export const completeAuthorisation = action({
  args: { state: v.string(), code: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args): Promise<LinearAuthorisationResult> => {
    assertRealMode('Installing a Linear app');
    const deps = linearIdentityDeps();
    const verified = verifyOauthState(args.state, process.env.DAY0_CREDENTIAL_KEY, deps.now());
    if (!verified.ok) return { ok: false, reason: OAUTH_STATE_MESSAGES[verified.reason] };
    const claimed: ClaimedLinearAuthorisation | { ok: false; reason: LinearClaimFailure } =
      await ctx.runMutation(internal.linearIdentity.claimPendingAuthorisation, {
        surfaceId: verified.surfaceId,
        stateNonce: verified.nonce,
        now: deps.now(),
      });
    if (!claimed.ok) return { ok: false, reason: CLAIM_FAILURES[claimed.reason] };
    const surfaceId = verified.surfaceId as Id<'surfaces'>;
    const landing = { agentId: claimed.agentId, surfaceSlug: claimed.slug };
    const fail = async (reason: string): Promise<LinearAuthorisationResult> => {
      await ctx.runMutation(internal.linearIdentity.recordAuthorisationFailure, {
        surfaceId,
        reason,
        now: deps.now(),
      });
      return { ok: false, ...landing, reason };
    };
    if (args.error !== undefined) {
      return await fail(`Linear did not install the app: ${args.error.slice(0, 80)}.`);
    }
    if (!args.code) return await fail('Linear sent no code back.');
    const { pending } = claimed;
    let issued: LinearIssuedTokens;
    try {
      const verifier = openOwnedCredential(
        {
          ciphertext: pending.verifierCiphertext,
          iv: pending.verifierIv,
          userId: ORGANISATION_OWNER_KEY,
          ...(pending.verifierKeyId === undefined ? {} : { keyId: pending.verifierKeyId }),
        },
        credentialKeyring(),
        { allowUnbound: false },
      );
      const secret = await valueOf(ctx, claimed.clientSecretCredentialId);
      issued = await requestLinearTokens(
        deps.fetch,
        { clientId: pending.clientId, clientSecret: secret },
        {
          grant: 'authorization_code',
          code: args.code,
          redirectUrl: pending.redirectUrl,
          codeVerifier: verifier,
        },
        deps.now(),
      );
    } catch (error) {
      return await fail(clipped(error, 'Exchanging the code with Linear failed.', [args.code]));
    }
    if (issued.refreshToken === undefined) {
      await revokeUnkept(deps, issued);
      return await fail('Linear answered without a refresh token, so the token could not be kept.');
    }
    const secrets = [issued.accessToken, issued.refreshToken];
    try {
      const appUser = await appUserOf(deps, issued.accessToken);
      if (!pending.organisationConnectionId)
        throw new Error('The installation names no connection.');
      await ctx.runMutation(internal.linearIdentity.landEmployeeTokens, {
        surfaceId,
        organisationConnectionId: pending.organisationConnectionId,
        clientId: pending.clientId,
        access: sealed(issued.accessToken),
        refresh: sealed(issued.refreshToken),
        ...(issued.expiresAt === undefined ? {} : { expiresAt: issued.expiresAt }),
        appUser: { id: appUser.id, name: appUser.name },
        now: deps.now(),
      });
    } catch (error) {
      await revokeUnkept(deps, issued);
      return await fail(clipped(error, 'Landing the Linear app failed.', secrets));
    }
    return { ok: true, ...landing };
  },
});

/** What a per-employee refresh answered: the bearer to use, or why Linear refused. */
type RefreshOutcome =
  | { readonly ok: true; readonly bearer: string }
  | { readonly ok: false; readonly refusal: string };

/** Whether the pair moved on since `held` was read: a concurrent refresh rotated it. */
async function rotatedSince(ctx: ActionCtx, held: HeldLinearToken): Promise<boolean> {
  const now = await ctx.runQuery(internal.linearIdentity.heldToken, {
    credentialId: held.access._id,
  });
  return (now?.access.generation ?? 0) !== (held.access.generation ?? 0);
}

/**
 * Refresh an employee's own token with rotation (L3): exchange the refresh token of the generation
 * read and write the new pair only while the pair is still at that generation. A refresh that loses
 * to a concurrent one takes the winner's token; Linear's 30-minute grace answers the loser's replay
 * with the same pair. One whose credential was revoked meanwhile revokes what it was issued.
 *
 * @throws LinearIssuerRefusal or Error when Linear cannot be reached or answers unusably; Linear's
 *   refusal of the refresh is the typed outcome instead.
 */
async function refreshEmployee(
  ctx: ActionCtx,
  held: HeldLinearToken,
  deps: LinearIdentityDeps,
): Promise<RefreshOutcome> {
  const { access, refresh } = held;
  const clientId = access.issuedBy?.clientId;
  const secretId = access.issuedBy?.clientSecretCredentialId;
  if (!clientId || !secretId || refresh === null) {
    return { ok: false, refusal: 'Day0 no longer holds what refreshing this Linear token needs.' };
  }
  const clientSecret = await valueOf(ctx, secretId);
  if (await rotatedSince(ctx, held)) return { ok: true, bearer: await valueOf(ctx, access._id) };
  const presented = await valueOf(ctx, refresh._id);
  let issued: LinearIssuedTokens;
  try {
    issued = await requestLinearTokens(
      deps.fetch,
      { clientId, clientSecret },
      { grant: 'refresh_token', refreshToken: presented },
      deps.now(),
    );
  } catch (error) {
    if (!(error instanceof LinearIssuerRefusal) || error.reason !== 'token-refused') throw error;
    if (await rotatedSince(ctx, held)) return { ok: true, bearer: await valueOf(ctx, access._id) };
    return { ok: false, refusal: `Linear refused to renew the token: ${error.message}` };
  }
  const rotation: LinearRotationOutcome = await ctx.runMutation(
    internal.linearIdentity.rotateEmployeeTokens,
    {
      credentialId: access._id,
      expectedGeneration: access.generation ?? 0,
      access: sealed(issued.accessToken),
      ...(issued.refreshToken === undefined ? {} : { refresh: sealed(issued.refreshToken) }),
      ...(issued.expiresAt === undefined ? {} : { expiresAt: issued.expiresAt }),
      now: deps.now(),
    },
  );
  if (rotation.ok) return { ok: true, bearer: issued.accessToken };
  if (rotation.reason === 'stale') return { ok: true, bearer: await valueOf(ctx, access._id) };
  await revokeUnkept(deps, issued);
  return { ok: false, refusal: 'The Linear token was revoked while it was being renewed.' };
}

/** The words a card ends with when its own app's token can no longer be renewed. */
function reinstallWords(refusal: string): string {
  return `${refusal} A Linear administrator installs the app again from the card.`;
}

/**
 * The bearer to send for a Linear token a card holds, renewed first when it is due: the shared
 * app-actor token in its last day is requested again; an employee's own access token within
 * {@link TOKEN_READ_MARGIN_MS} of its expiry is refreshed, and while it still lives a failed
 * refresh hands it back. Null for any credential Linear's issuer did not obtain, which the caller
 * reads the plain way.
 *
 * @throws Error when the token cannot be renewed and no longer works (the card then ends with the
 *   reason), or the credential is unavailable.
 */
export async function readLinearBearer(
  ctx: ActionCtx,
  credentialId: string,
  deps: LinearIdentityDeps = linearIdentityDeps(),
): Promise<string | null> {
  const held = await ctx.runQuery(internal.linearIdentity.heldToken, { credentialId });
  const issuedBy = held?.access.issuedBy;
  if (!held || issuedBy?.system !== LINEAR_SYSTEM) return null;
  switch (issuedBy.grant) {
    case 'client-credentials': {
      if (!issuedBy.organisationConnectionId) return null;
      return (await sharedToken(ctx, issuedBy.organisationConnectionId, deps)).bearer;
    }
    case 'authorisation-code':
    case 'token-rotation': {
      const expiresAt = held.access.expiresAt;
      if (!tokenDue(expiresAt, deps.now(), TOKEN_READ_MARGIN_MS)) {
        return await valueOf(ctx, held.access._id);
      }
      const alive = expiresAt !== undefined && expiresAt > deps.now();
      let outcome: RefreshOutcome;
      try {
        outcome = await refreshEmployee(ctx, held, deps);
      } catch (error) {
        const reason = clipped(error, 'Linear could not be reached.');
        if (!alive) throw new Error(`Linear could not be reached to renew the token: ${reason}`);
        log.warn('linear read-time refresh failed; the stored token still lives', {
          credentialId,
          reason,
        });
        return await valueOf(ctx, held.access._id);
      }
      if (outcome.ok) return outcome.bearer;
      if (alive) {
        log.warn('linear read-time refresh refused; the stored token still lives', {
          credentialId,
          reason: outcome.refusal,
        });
        return await valueOf(ctx, held.access._id);
      }
      throw new Error(reinstallWords(outcome.refusal));
    }
    case 'oauth-install':
    case 'app-created':
      return null;
    default: {
      const unknown: never = issuedBy.grant;
      throw new Error(`unhandled credential grant ${String(unknown)}`);
    }
  }
}

/**
 * The bearer for any credential a card holds: a Linear token through {@link readLinearBearer}, any
 * other read as `credentials.decrypt` reads it. Internal, for an action in another module (the
 * probe, intake); records the credential's use.
 */
export const currentBearer = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> =>
    (await readLinearBearer(ctx, args.credentialId)) ?? (await valueOf(ctx, args.credentialId)),
});

/**
 * The one new token after Linear refused the card's bearer (a 401): the shared app-actor token is
 * requested again with the connection's scope set (L2), an employee's own token refreshed. A token
 * a concurrent renewal already replaced is not renewed twice: its successor is answered. Internal,
 * for the probe's Linear identity region.
 *
 * @throws LinearIssuerRefusal or Error when no new token can be had; the caller ends the card.
 */
export const renewAfterRefusal = internalAction({
  args: { credentialId: v.id('credentials'), generation: v.number() },
  handler: async (ctx, args): Promise<string> => {
    const deps = linearIdentityDeps();
    const held = await ctx.runQuery(internal.linearIdentity.heldToken, {
      credentialId: args.credentialId,
    });
    const issuedBy = held?.access.issuedBy;
    if (!held || issuedBy?.system !== LINEAR_SYSTEM) {
      throw new Error('The card holds no token Linear issued to Day0.');
    }
    if (issuedBy.grant === 'client-credentials' && issuedBy.organisationConnectionId) {
      return (await sharedToken(ctx, issuedBy.organisationConnectionId, deps, args.generation))
        .bearer;
    }
    if ((held.access.generation ?? 0) !== args.generation)
      return await valueOf(ctx, held.access._id);
    const outcome = await refreshEmployee(ctx, held, deps);
    if (outcome.ok) return outcome.bearer;
    throw new Error(reinstallWords(outcome.refusal));
  },
});

/**
 * Renew the shared app-actor token in its last day, so every reader finds a live one. Does nothing
 * when a renewal has moved it on. Linear unreachable is tried again with a growing wait; a refusal
 * is logged, and each card ends with it at its next check. Internal; scheduled by
 * `linearIdentity.landSharedToken`.
 */
export const renewSharedScheduled = internalAction({
  args: {
    organisationConnectionId: v.id('organisationConnections'),
    generation: v.number(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const held = await ctx.runQuery(internal.linearIdentity.sharedTokenOf, {
      organisationConnectionId: args.organisationConnectionId,
    });
    if (!held?.token || (held.token.generation ?? 0) !== args.generation) return;
    if (held.connection.status !== 'active') return;
    const attempt = args.attempt ?? 0;
    try {
      await sharedToken(ctx, args.organisationConnectionId, linearIdentityDeps());
    } catch (error) {
      const reason = clipped(error, 'Linear could not be reached.');
      if (unreachable(error) && attempt < SCHEDULED_RENEWAL_RETRIES) {
        await ctx.scheduler.runAfter(
          60_000 * 2 ** attempt,
          internal.linearIdentityActions.renewSharedScheduled,
          {
            ...args,
            attempt: attempt + 1,
          },
        );
        return;
      }
      log.warn('linear shared token renewal failed', {
        organisationConnectionId: args.organisationConnectionId,
        attempt,
        reason,
      });
    }
  },
});

/** Whether a failed renewal may succeed later: Linear unreachable or busy. */
function unreachable(error: unknown): boolean {
  return error instanceof LinearIssuerRefusal && error.reason === 'unavailable';
}

/**
 * Refresh an employee's own token ahead of its expiry, so every reader finds a live one. Does
 * nothing when another refresh has moved the pair on. Linear unreachable is tried again with a
 * growing wait; a refusal, or the retries running out, goes on the record of every card holding the
 * token, and each card ends with the reason when the token stops working. Internal; scheduled by
 * `linearIdentity` at each landing and rotation.
 */
export const refreshScheduled = internalAction({
  args: {
    credentialId: v.id('credentials'),
    generation: v.number(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const deps = linearIdentityDeps();
    const held = await ctx.runQuery(internal.linearIdentity.heldToken, {
      credentialId: args.credentialId,
    });
    if (
      !held ||
      held.access.revokedAt !== undefined ||
      (held.access.generation ?? 0) !== args.generation ||
      held.refresh === null
    ) {
      return;
    }
    const attempt = args.attempt ?? 0;
    let refusal: string;
    try {
      const outcome = await refreshEmployee(ctx, held, deps);
      if (outcome.ok) return;
      refusal = outcome.refusal;
    } catch (error) {
      const reason = clipped(error, 'Linear could not be reached.');
      if (unreachable(error) && attempt < SCHEDULED_RENEWAL_RETRIES) {
        await ctx.scheduler.runAfter(
          60_000 * 2 ** attempt,
          internal.linearIdentityActions.refreshScheduled,
          {
            ...args,
            attempt: attempt + 1,
          },
        );
        return;
      }
      refusal = unreachable(error)
        ? `Linear could not be reached to renew the token after ${attempt + 1} attempts: ${reason}`
        : `Renewing the Linear token failed: ${reason}`;
    }
    await ctx.runMutation(internal.linearIdentity.recordRefusal, {
      credentialId: args.credentialId,
      reason: reinstallWords(refusal).slice(0, REASON_MAX),
      ...(held.access.expiresAt === undefined ? {} : { endsAt: held.access.expiresAt }),
      now: deps.now(),
    });
  },
});

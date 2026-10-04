'use node';

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { credentialKeyring, requireCredentialKey } from './credentialCryptoActions';
import type {
  ClaimedLinearAuthorisation,
  LinearClaimFailure,
  LinearIssuerContext,
  LinearRotationOutcome,
} from './linearIdentity';
import {
  assertAdministrator,
  assertOwnsAgentAction,
  callerIsAdministrator,
  getCallerOrThrow,
} from './ownership';
import {
  openOwnedCredential,
  sealForOwner,
  type SealedCredential,
} from '../src/lib/credential-crypto';
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
import { linearEmployeeAppName } from '../src/surfaces/access-kit/linear';
import { organisationSystemOf } from '../src/surfaces/access-request';
import { decryptCredential } from '../src/surfaces/credentials';
import { LINEAR_MCP_ENDPOINT } from '../src/surfaces/fixed-endpoints';
import {
  isAuthorityRefusal,
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
import type { IssuedTokens } from '../src/surfaces/mcp-oauth';
import { safeFailureMessage } from '../src/surfaces/redact';
import {
  accessTokenFor,
  nativeTokenKeeper,
  refresherFor,
  refreshHeld,
  runScheduledRefresh,
  TokenRefreshRefused,
  type RefreshPreparation,
  type RefreshWords,
  type RotationOutcome,
  type TokenRefresher,
  type TokenStoreDeps,
} from '../src/surfaces/token-store';
import { isAppIdentity } from '../src/work/ticket-ownership';

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
export function linearIdentityDeps(): LinearIdentityDeps {
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
  'linear-refused',
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

/**
 * Linear's refusal (or the connection's end) as the card's answer, its words Day0's own and safe
 * to show: a thrown error's words would not reach the browser in production (the standard, 6.3).
 * Any other failure is rethrown.
 *
 * @throws The error itself when it is not Linear's refusal.
 */
function refusedByLinear(error: unknown): Refused {
  if (!(error instanceof LinearIssuerRefusal)) throw error;
  return { ok: false, reason: 'linear-refused', message: error.message.slice(0, REASON_MAX) };
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
    throw new LinearIssuerRefusal(
      'connection-ended',
      "The organisation's Linear connection is no longer active.",
    );
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
    throw new LinearIssuerRefusal(
      'connection-ended',
      "The organisation's Linear connection holds no client id or secret.",
    );
  }
  // The value a renewal in place replaces stays live at Linear for its 30 days unless revoked,
  // and the connection's revoke ends only the value it holds then (the round review's m5).
  const superseded = usable ? await valueOf(ctx, token._id) : undefined;
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
      secretCredentialId: connection.secretCredentialId,
      now: deps.now(),
    },
  );
  if (landed.ok) {
    // Never the value just landed: a vendor that answered the same token again keeps it live.
    if (superseded !== undefined && superseded !== issued.accessToken) {
      await revokeUnkept(deps, { accessToken: superseded });
    }
    return {
      credentialId: landed.credentialId,
      generation: landed.generation,
      bearer: issued.accessToken,
    };
  }
  if (landed.reason === 'stale') {
    // Another renewal wrote first; its token is as good as this one, which Day0 keeps nowhere, so
    // it is revoked at Linear rather than left live for 30 days (the round review's m5), unless it
    // is the very value that renewal landed.
    const winner =
      landed.credentialId === undefined
        ? null
        : await ctx.runQuery(internal.linearIdentity.heldToken, {
            credentialId: landed.credentialId,
          });
    if (landed.credentialId === undefined || winner?.access.ciphertext === undefined) {
      // The app's secret was rotated while this token was requested (join 3): it may carry the
      // old secret, and the emptied row waits for a request made after the rotation.
      await revokeUnkept(deps, issued);
      throw new LinearIssuerRefusal(
        'unavailable',
        "The organisation's Linear app was rotated while its token was renewed: the next read requests one with the new secret.",
      );
    }
    const bearer = await valueOf(ctx, landed.credentialId);
    if (bearer !== issued.accessToken) await revokeUnkept(deps, issued);
    return {
      credentialId: landed.credentialId,
      generation: winner?.access.generation ?? 0,
      bearer,
    };
  }
  // The connection was revoked while Linear issued the token: Day0 keeps it nowhere, so it is
  // revoked at Linear now rather than left live for 30 days (R41V-1).
  await revokeUnkept(deps, issued);
  throw new LinearIssuerRefusal(
    'connection-ended',
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
  let token = await sharedToken(ctx, organisationConnectionId, deps);
  let appUser: LinearViewer;
  try {
    appUser = await appUserOf(deps, token.bearer);
  } catch (error) {
    if (!isTokenRefusal(error)) throw error;
    token = await sharedToken(ctx, organisationConnectionId, deps, token.generation);
    appUser = await appUserOf(deps, token.bearer);
  }
  // Linked only once Linear has issued the token and named the app user: a refused connect leaves
  // the card as it was.
  await ctx.runMutation(internal.organisationConnections.linkSurface, {
    surfaceId: context.surface._id,
    organisationConnectionId,
  });
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
    await getCallerOrThrow(ctx);
    assertRealMode('Connecting Linear');
    const context = await contextOf(ctx, args.surfaceId);
    const agent = await assertOwnsAgentAction(ctx, context.surface.agentId);
    const checked = connectableThrough(context);
    if (!checked.ok) return checked;
    const { connection } = checked;
    const deps = linearIdentityDeps();
    if (connection.mode === 'shared') {
      if (agent.userId === undefined) throw new ConvexError('The employee has no owner.');
      try {
        await connectShared(ctx, { ...context, connection }, agent.userId, deps);
      } catch (error) {
        return refusedByLinear(error);
      }
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
    await getCallerOrThrow(ctx);
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
    await getCallerOrThrow(ctx);
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
    const appName = (args.appName?.trim() || linearEmployeeAppName(context.agent.name)).slice(
      0,
      APP_NAME_MAX,
    );
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

/** An OAuth error code as RFC 6749 shapes them (`access_denied`), the only error text recorded. */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

/** The words a refused claim of a pending installation reads as. */
const CLAIM_FAILURES: { readonly [Failure in LinearClaimFailure]: string } = {
  none: 'This installation link is not waiting on any card. Start it again from the card.',
  used: 'This installation link was replaced by a newer one. Use the newest link.',
  expired: 'This installation link has expired. Start it again from the card.',
  replaced: "The card's Linear app was replaced. Start the installation again from the card.",
};

/** Revoke tokens Linear issued that Day0 will not keep, so no grant is left live behind it. */
async function revokeUnkept(
  deps: LinearIdentityDeps,
  tokens: Pick<LinearIssuedTokens, 'accessToken' | 'refreshToken'>,
): Promise<void> {
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
      // Only an OAuth error code is recorded: the redirect's text is the browser's, not Linear's.
      const code = OAUTH_ERROR_CODE.test(args.error) ? args.error : 'an unrecognised error';
      return await fail(`Linear did not install the app: ${code}.`);
    }
    if (!args.code) return await fail('Linear sent no code back.');
    const { pending } = claimed;
    let issued: LinearIssuedTokens;
    // Kept beside the code for the failure's words, which never carry either (the review's m13).
    let secret: string | undefined;
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
      secret = await valueOf(ctx, claimed.clientSecretCredentialId);
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
      return await fail(
        clipped(error, 'Exchanging the code with Linear failed.', [
          args.code,
          ...(secret === undefined ? [] : [secret]),
        ]),
      );
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

/** How Linear's issuer words a refresh's failures, which the card and its record carry (11-AL). */
const LINEAR_REFRESH_WORDS: RefreshWords = {
  reason: (error: unknown): string => clipped(error, 'Linear could not be reached.'),
  refused: (message: string): string => `Linear refused to renew the token: ${message}`,
  revokedMeanwhile: 'The Linear token was revoked while it was being renewed.',
  unreachableWhenExpired: (reason: string): Error =>
    new Error(`Linear could not be reached to renew the token: ${reason}`),
  refusedWhenExpired: (refusal: string): Error =>
    new LinearIssuerRefusal('token-refused', reinstallWords(refusal)),
  unreachableAfter: (attempts: number, reason: string): string =>
    `Linear could not be reached to renew the token after ${attempts} attempts: ${reason}`,
  failed: (reason: string): string => `Renewing the Linear token failed: ${reason}`,
};

/**
 * Linear's half of a native refresh (the token store owns when, the generation, and the loser
 * taking the winner's token; L3): an employee's own access token, refreshed at a read within
 * {@link TOKEN_READ_MARGIN_MS} of its expiry by exchanging its rotating refresh token with the
 * employee's app's client id and secret, and written through Linear's own rotation-safe write,
 * which queues Linear's next scheduled refresh. The shared app-actor token is not one: it has no
 * refresh token and is requested again by its issuer (AL6, AL7).
 *
 * @param deps - Linear's transport and the clock.
 */
export function linearTokenRefresher(deps: LinearIdentityDeps): TokenRefresher {
  return {
    name: 'linear',
    owns: (issuedBy): boolean =>
      issuedBy.system === LINEAR_SYSTEM &&
      (issuedBy.grant === 'authorisation-code' || issuedBy.grant === 'token-rotation'),
    readRefreshMarginMs: TOKEN_READ_MARGIN_MS,
    retryable: unreachable,
    words: LINEAR_REFRESH_WORDS,
    prepare: async (ctx, held): Promise<RefreshPreparation> => {
      const clientId = held.issuedBy?.clientId;
      const secretId = held.issuedBy?.clientSecretCredentialId;
      if (!clientId || !secretId) {
        return {
          ok: false,
          refusal: 'Day0 no longer holds what refreshing this Linear token needs.',
        };
      }
      const clientSecret = await valueOf(ctx, secretId);
      return {
        ok: true,
        refresh: {
          exchange: async (presented: string): Promise<IssuedTokens> => {
            try {
              return await requestLinearTokens(
                deps.fetch,
                { clientId, clientSecret },
                { grant: 'refresh_token', refreshToken: presented },
                deps.now(),
              );
            } catch (error) {
              if (error instanceof LinearIssuerRefusal && error.reason === 'token-refused') {
                throw new TokenRefreshRefused(error.message);
              }
              throw error;
            }
          },
          discard: async (_presented: string, issued: IssuedTokens): Promise<void> =>
            await revokeUnkept(deps, issued),
        },
      };
    },
    rotate: async (ctx, rotation): Promise<RotationOutcome> => {
      const seal = (value: string): SealedCredential =>
        sealForOwner(value, credentialKeyring(), rotation.ownerKey);
      return await ctx.runMutation(internal.linearIdentity.rotateEmployeeTokens, {
        credentialId: rotation.credentialId,
        expectedGeneration: rotation.expectedGeneration,
        access: seal(rotation.tokens.accessToken),
        ...(rotation.tokens.refreshToken === undefined
          ? {}
          : { refresh: seal(rotation.tokens.refreshToken) }),
        ...(rotation.tokens.expiresAt === undefined
          ? {}
          : { expiresAt: rotation.tokens.expiresAt }),
        now: rotation.now,
      });
    },
  };
}

/** The native token store as Linear's issuer reads its own tokens through it. */
function linearTokenStore(deps: LinearIdentityDeps): TokenStoreDeps {
  return {
    keeper: nativeTokenKeeper(credentialKeyring),
    refreshers: [linearTokenRefresher(deps)],
    now: deps.now,
    backends: [],
  };
}

/** The words a card ends with when its own app's token can no longer be renewed. */
function reinstallWords(refusal: string): string {
  return `${refusal} Day0 is unauthorised in Linear until a Linear administrator installs the app again from the card.`;
}

/**
 * The bearer to send for a Linear token a card holds, renewed first when it is due: the shared
 * app-actor token in its last day is requested again by its issuer; an employee's own access token
 * is the native token store's (`accessTokenFor` through {@link linearTokenRefresher}), refreshed
 * within {@link TOKEN_READ_MARGIN_MS} of its expiry, and while it still lives a failed refresh
 * hands it back. Null for any credential Linear's issuer did not obtain, which the caller reads
 * through the token store.
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
    case 'token-rotation':
      return await accessTokenFor(ctx, held.access._id, linearTokenStore(deps));
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
 * The bearer for any credential a card holds, as Linear's issuer reads it: a Linear token through
 * {@link readLinearBearer}, any other through the token store (`accessTokenFor`), never a plain
 * decrypt, which would answer a Nango-held row with its location. The rungs' one read is
 * `mcpOauthActions.readSurfaceBearer`, which also refreshes an MCP authorisation's tokens.
 *
 * @param deps - Linear's transport and the clock.
 */
async function bearerAsLinearReadsIt(
  ctx: ActionCtx,
  credentialId: Id<'credentials'>,
  deps: LinearIdentityDeps,
): Promise<string> {
  return (
    (await readLinearBearer(ctx, credentialId, deps)) ??
    (await accessTokenFor(ctx, credentialId, linearTokenStore(deps)))
  );
}

/**
 * The bearer for any credential a card holds, as Linear's issuer reads it
 * ({@link bearerAsLinearReadsIt}). Internal, for an action in another module; records the
 * credential's use.
 */
export const currentBearer = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> =>
    await bearerAsLinearReadsIt(ctx, args.credentialId, linearIdentityDeps()),
});

/**
 * The one new token after Linear refused the card's bearer (a 401): the shared app-actor token is
 * requested again with the connection's scope set (L2), an employee's own token refreshed. A token
 * a concurrent renewal already replaced is not renewed twice: its successor is answered.
 *
 * @param generation - The generation of the token Linear refused.
 * @throws LinearIssuerRefusal when no new token can be had; the caller ends the card.
 */
export async function renewLinearTokenAfterRefusal(
  ctx: ActionCtx,
  credentialId: Id<'credentials'>,
  generation: number,
  deps: LinearIdentityDeps = linearIdentityDeps(),
): Promise<string> {
  const held = await ctx.runQuery(internal.linearIdentity.heldToken, { credentialId });
  const issuedBy = held?.access.issuedBy;
  if (!held || issuedBy?.system !== LINEAR_SYSTEM) {
    throw new LinearIssuerRefusal(
      'connection-ended',
      'The card holds no token Linear issued to Day0.',
    );
  }
  if (issuedBy.grant === 'client-credentials' && issuedBy.organisationConnectionId) {
    return (await sharedToken(ctx, issuedBy.organisationConnectionId, deps, generation)).bearer;
  }
  if ((held.access.generation ?? 0) !== generation) return await valueOf(ctx, held.access._id);
  const store = linearTokenStore(deps);
  const tokens = await store.keeper.read(ctx, held.access._id);
  const refresher = tokens ? refresherFor(tokens, store.refreshers) : undefined;
  if (!tokens || !refresher) {
    throw new LinearIssuerRefusal(
      'token-refused',
      reinstallWords('The Linear refresh token is no longer held.'),
    );
  }
  const outcome = await refreshHeld(ctx, tokens, refresher, store);
  if (outcome.ok) return outcome.accessToken;
  throw new LinearIssuerRefusal('token-refused', reinstallWords(outcome.refusal));
}

/**
 * {@link renewLinearTokenAfterRefusal} for an action in another module. Internal.
 *
 * @throws LinearIssuerRefusal's words when no new token can be had.
 */
export const renewAfterRefusal = internalAction({
  args: { credentialId: v.id('credentials'), generation: v.number() },
  handler: async (ctx, args): Promise<string> =>
    await renewLinearTokenAfterRefusal(ctx, args.credentialId, args.generation),
});

/** A card's Linear bearer as the probe holds it: the value and the generation it was read at. */
export interface HeldBearer {
  readonly bearer: string;
  readonly generation: number;
}

/**
 * What the probe's Linear identity region asks of the issuer (the probe's dependency; a test
 * scripts it): the card's bearer, renewed when due; the one new token after a refusal; and the app
 * user a token acts as.
 */
export interface LinearProbeIdentity {
  bearer(credentialId: Id<'credentials'>): Promise<HeldBearer>;
  renewAfterRefusal(credentialId: Id<'credentials'>, generation: number): Promise<string>;
  appUser(bearer: string): Promise<LinearViewer>;
}

/**
 * The issuer as the probe's Linear identity region uses it, in the probe's own action.
 *
 * @param ctx - The probe's action context.
 */
export function linearProbeIdentity(
  ctx: ActionCtx,
  deps: LinearIdentityDeps = linearIdentityDeps(),
): LinearProbeIdentity {
  return {
    async bearer(credentialId) {
      const bearer = await bearerAsLinearReadsIt(ctx, credentialId, deps);
      const held = await ctx.runQuery(internal.linearIdentity.heldToken, { credentialId });
      return { bearer, generation: held?.access.generation ?? 0 };
    },
    renewAfterRefusal: async (credentialId, generation) =>
      await renewLinearTokenAfterRefusal(ctx, credentialId, generation, deps),
    appUser: async (bearer) => await appUserOf(deps, bearer),
  };
}

/** Whether a card acts as a Linear app user, its own or the organisation's shared one. */
export function actsAsLinearApp(card: Doc<'surfaces'>): boolean {
  return isAppIdentity(card) && organisationSystemOf(card) === LINEAR_SYSTEM;
}

/** What the probe's Linear identity region found: the discovery and the app user, or the refusal. */
export type LinearProbeResult<Discovery> =
  | { readonly ok: true; readonly discovery: Discovery; readonly appUser: LinearViewer }
  | { readonly ok: false; readonly reason: string };

/**
 * Probe a card acting as a Linear app with its identity's own token (the access plan, section 4.10):
 * the bearer read through the issuer (renewed when due), the server's tools discovered with it, a
 * refusal of it (a 401) answered with one new token before the card ends (L2), a second refusal
 * ending it on no other rung, and the app user the token acts as read, for `providerIdentityId` and the ticket rule (D6). Linear withdrawing the
 * authority answers the refusal for the card; any other failure is the caller's to judge.
 *
 * @param discover - The probe's discovery with a bearer, which also tells the caller the bearer.
 */
export async function probeLinearApp<Discovery>(
  identity: LinearProbeIdentity,
  credentialId: Id<'credentials'>,
  discover: (bearer: string) => Promise<Discovery>,
): Promise<LinearProbeResult<Discovery>> {
  try {
    const held = await identity.bearer(credentialId);
    let bearer = held.bearer;
    let discovery: Discovery;
    try {
      discovery = await discover(bearer);
    } catch (error) {
      if (!isTokenRefusal(error)) throw error;
      bearer = await identity.renewAfterRefusal(credentialId, held.generation);
      try {
        discovery = await discover(bearer);
      } catch (again) {
        // Refused twice: Linear has withdrawn the authority, which no lower rung stands in for.
        if (!isTokenRefusal(again)) throw again;
        return { ok: false, reason: clipped(again, 'Linear refused the new token too.', [bearer]) };
      }
    }
    return { ok: true, discovery, appUser: await identity.appUser(bearer) };
  } catch (error) {
    if (isAuthorityRefusal(error)) return { ok: false, reason: error.message.slice(0, REASON_MAX) };
    throw error;
  }
}

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
 * Refresh an employee's own token ahead of its expiry, so every reader finds a live one: the token
 * store's scheduled refresh (`runScheduledRefresh`) through {@link linearTokenRefresher}. Does
 * nothing when another refresh has moved the pair on. Linear unreachable is tried again with a
 * growing wait; a refusal, or the retries running out, goes on the record of every card holding the
 * token, and each card is checked at once and ends with the reason when Linear refuses its access
 * token (at once after a revoke in Linear's settings, R41V-9). Internal; scheduled by
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
    const store = linearTokenStore(deps);
    await runScheduledRefresh(ctx, args, {
      ...store,
      retryAfter: async (delayMs: number, attempt: number): Promise<void> => {
        await ctx.scheduler.runAfter(delayMs, internal.linearIdentityActions.refreshScheduled, {
          ...args,
          attempt,
        });
      },
      recordRefusal: async (reason: string): Promise<void> => {
        const held = await store.keeper.read(ctx, args.credentialId);
        await ctx.runMutation(internal.linearIdentity.recordRefusal, {
          credentialId: args.credentialId,
          reason: reinstallWords(reason).slice(0, REASON_MAX),
          ...(held?.expiresAt === undefined ? {} : { endsAt: held.expiresAt }),
          now: deps.now(),
        });
      },
    });
  },
});

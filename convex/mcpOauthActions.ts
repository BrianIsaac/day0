'use node';

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { credentialKeyring } from './credentialCryptoActions';
import {
  MCP_READ_REFRESH_MARGIN_MS,
  type ClaimedAuthorisation,
  type PendingClaimFailure,
} from './mcpOauth';
import { assertOwnsAgentAction, getCaller, getCallerOrThrow } from './ownership';
import { openOwnedCredential, sealForOwner } from '../src/lib/credential-crypto';
import { log } from '../src/lib/logger';
import {
  newOauthNonce,
  OAUTH_STATE_TTL_MS,
  signOauthState,
  verifyOauthState,
  type OauthStateFailure,
} from '../src/lib/oauth-state';
import { assertRealMode } from '../src/lib/surface-mode';
import type { CredentialGrant } from '../src/surfaces/access-identity';
import {
  linearIdentityDeps,
  linearTokenRefresher,
  readLinearBearer,
} from './linearIdentityActions';
import { MCP_SYSTEM_PREFIX, mcpSystemKey } from '../src/surfaces/access-request';
import { decryptCredential, type DecryptCredential } from '../src/surfaces/credentials';
import { McpAddressRefusal } from '../src/surfaces/mcp-address';
import {
  addressCheckedFetch,
  authorisationUrl,
  canonicalResource,
  checkResponseIssuer,
  clientAuthentication,
  discoverAuthorisation,
  fetchAuthorisationServerMetadata,
  McpOauthRefusal,
  newPkcePair,
  requestTokens,
  revokeToken,
  type AuthorisationServerMetadata,
  type ClientAuthentication,
  type IssuedTokens,
  type McpAuthorisationTarget,
  type McpOauthRefusalReason,
  type OauthFetch,
} from '../src/surfaces/mcp-oauth';
import { safeFailureMessage } from '../src/surfaces/redact';
import {
  nangoConfigFrom,
  nangoTokenBackend,
  type NangoConfig,
} from '../src/surfaces/nango-token-store';
import {
  accessTokenFor,
  nativeTokenKeeper,
  runScheduledRefresh,
  TokenRefreshRefused,
  type HeldTokens,
  type LandTokens,
  type RefreshPreparation,
  type RotateTokens,
  type TokenKeeper,
  type TokenRefresher,
  type TokenStoreDeps,
} from '../src/surfaces/token-store';

/*
 * The MCP rung's OAuth 2.1 client in the deployment (wave 11, 11-AM; the access plan, section
 * 4.6): the manager starts an authorisation from the card, the authorisation server sends the
 * manager's own browser back to `app/api/oauth/mcp` (Q13: no inbound endpoint), the redirect
 * completes it, and the tokens are kept fresh by a scheduled refresh with rotation and by a
 * refresh at read time. Tokens are kept, read, refreshed and rotated by the token store (11-AT,
 * `src/surfaces/token-store.ts`); this module supplies the MCP issuer's half of a refresh.
 */

/** The route the authorisation server sends the person's browser back to. */
export const MCP_OAUTH_REDIRECT_PATH = '/api/oauth/mcp';

/** The credential an MCP authorisation landed, as the token store is told to keep it. */
export type LandMcpTokens = LandTokens;

/** A held access token, as a read or a refresh needs it; never its value. */
export type HeldMcpTokens = HeldTokens;

/** A refresh's tokens, to be written only while the pair is still at `expectedGeneration`. */
export type RotateMcpTokens = RotateTokens;

/**
 * Where an MCP authorisation's tokens are kept and read: the token store's native keeper
 * (`src/surfaces/token-store.ts`), `credentials` rows sealed for the employee's owner.
 */
export type McpTokenStore = TokenKeeper;

function sealed(
  value: string,
  ownerKey: string,
): { ciphertext: string; iv: string; keyId: string } {
  return sealForOwner(value, credentialKeyring(), ownerKey);
}

/** The native token store's keeper, sealing under this deployment's credential keyring. */
export const nativeMcpTokenStore: McpTokenStore = nativeTokenKeeper(credentialKeyring);

/** What the client's actions depend on: the fetch every OAuth request goes through, the clock, the token store. */
export interface McpOauthDeps {
  readonly fetch: OauthFetch;
  readonly now: () => number;
  readonly store: McpTokenStore;
}

let depsForTest: Partial<McpOauthDeps> | undefined;

/** Replace the client's dependencies in a test; undefined restores the deployment's. */
export function __setMcpOauthDepsForTest(deps: Partial<McpOauthDeps> | undefined): void {
  depsForTest = deps;
}

/** The deployment's dependencies: the MCP rung's address-checked fetch, the wall clock, the native store. */
function mcpOauthDeps(): McpOauthDeps {
  return {
    fetch: addressCheckedFetch(),
    now: (): number => Date.now(),
    store: nativeMcpTokenStore,
    ...depsForTest,
  };
}

/** Why an authorisation could not start, beyond the refusals of the protocol itself. */
export type StartRefusalReason =
  | McpOauthRefusalReason
  | 'not-approved'
  | 'not-mcp'
  | 'no-connection'
  | 'ambiguous-connection'
  | 'shared-connection'
  | 'no-client'
  | 'resource-mismatch'
  | 'issuer-unregistered'
  | 'address-refused'
  | 'unreachable';

/** What starting an authorisation answers the card. */
export type StartOutcome =
  | { readonly ok: true; readonly authoriseUrl: string }
  | { readonly ok: false; readonly reason: StartRefusalReason; readonly message: string };

/**
 * The longest reason Day0 stores or shows for an authorisation: a refusal can carry a URL a
 * server chose, and it lands on the record and on the redirect.
 */
const REASON_LENGTH = 300;

function clipped(text: string): string {
  return text.length > REASON_LENGTH ? text.slice(0, REASON_LENGTH) : text;
}

function refused(reason: StartRefusalReason, message: string): StartOutcome {
  return { ok: false, reason, message: clipped(message) };
}

/** The public origin the redirect is registered under. */
function redirectUrlFor(connection: Doc<'organisationConnections'>): string {
  if (connection.redirectUrl) return connection.redirectUrl;
  const origin = process.env.DAY0_PUBLIC_URL?.trim();
  if (!origin) {
    throw new ConvexError(
      'DAY0_PUBLIC_URL is not set, so the authorisation server has nowhere to send the browser back to.',
    );
  }
  return new URL(MCP_OAUTH_REDIRECT_PATH, origin).href;
}

/** A card cleared to authorise: its endpoint, its employee's owner and the organisation's client. */
interface StartingClient {
  readonly endpoint: URL;
  readonly ownerKey: string;
  readonly connection: Doc<'organisationConnections'>;
  readonly clientId: string;
}

/**
 * The card's endpoint, owner and organisation client, once the caller is shown to own the employee
 * and every rule that keeps the card out has passed; otherwise the refusal the card shows.
 *
 * @throws ConvexError when the card is gone or has no owner; the ownership guard's error otherwise.
 */
async function startingClient(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
): Promise<StartingClient | StartOutcome> {
  const found = await ctx.runQuery(internal.orientationData.surfaceForOrientation, { surfaceId });
  if (!found) throw new ConvexError('Surface not found.');
  await assertOwnsAgentAction(ctx, found.surface.agentId);
  assertRealMode('MCP authorisation');
  if (found.surface.managerApprovedAt === undefined) {
    return refused('not-approved', 'Approve the card before authorising it.');
  }
  if (found.surface.path !== 'mcp' || !found.surface.endpoint) {
    return refused('not-mcp', 'Only an MCP card is authorised this way.');
  }
  const endpoint = new URL(found.surface.endpoint);
  const context = await ctx.runQuery(internal.mcpOauth.authorisationContext, {
    surfaceId,
    system: mcpSystemKey(endpoint),
  });
  if (!context) throw new ConvexError('Surface not found.');
  const { connection, agent } = context;
  if (context.ambiguous) {
    return refused(
      'ambiguous-connection',
      'More than one organisation connection is registered for this server; an administrator keeps one.',
    );
  }
  if (!connection) {
    return refused(
      'no-connection',
      'No organisation connection is registered for this server yet; IT registers Day0 as a client at install.',
    );
  }
  if (connection.mode === 'shared') {
    return refused(
      'shared-connection',
      "This server's connection is shared across employees, so it is not authorised per card.",
    );
  }
  if (!connection.clientId) {
    return refused('no-client', "The organisation's connection for this server has no client id.");
  }
  if (connection.resource && connection.resource !== canonicalResource(endpoint)) {
    return refused(
      'resource-mismatch',
      "The organisation's connection for this server names another resource.",
    );
  }
  // A client secret is unique to the server that issued it: it is sent only to the server it was
  // registered with, never to whichever one the MCP server's own metadata names first. A public
  // client's server is IT's to record as well: a manager's first authorisation never chooses it
  // for every employee (the wave 11 review's m4), so a connection landed before that rule waits.
  if (!connection.issuer) {
    return refused(
      'issuer-unregistered',
      connection.secretCredentialId
        ? "The organisation's client has a secret but no authorisation server registered with it; IT records the issuer at install."
        : "The organisation's connection for this server names no authorisation server; IT records the issuer at install.",
    );
  }
  if (!agent.userId) throw new ConvexError('The employee has no owner.');
  return { endpoint, ownerKey: agent.userId, connection, clientId: connection.clientId };
}

/** Discovery for one card, its failures as the card's refusals. */
async function discoverFor(
  deps: McpOauthDeps,
  client: StartingClient,
  surfaceId: Id<'surfaces'>,
): Promise<McpAuthorisationTarget | StartOutcome> {
  try {
    return await discoverAuthorisation(deps.fetch, client.endpoint, {
      ...(client.connection.issuer ? { issuer: client.connection.issuer } : {}),
    });
  } catch (error) {
    if (error instanceof McpOauthRefusal) return refused(error.reason, error.message);
    if (error instanceof McpAddressRefusal) return refused('address-refused', error.message);
    const message = safeFailureMessage(error, '', 'The server could not be reached.');
    log.warn('mcp authorisation discovery failed', { surfaceId, reason: message });
    return refused('unreachable', `Discovery could not reach the server: ${message}`);
  }
}

/**
 * Seal a fresh PKCE verifier for the employee's owner, record the pending authorisation with the
 * issuer it must come back from and what that issuer's metadata said (whether it sends `iss`, its
 * token endpoint and how it takes a client, R-S), record the discovered endpoints, and build the
 * URL the browser goes to.
 */
async function recordStart(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
  client: StartingClient,
  target: McpAuthorisationTarget,
  now: number,
): Promise<StartOutcome> {
  const pkce = newPkcePair();
  const nonce = newOauthNonce();
  const stateExpiresAt = now + OAUTH_STATE_TTL_MS;
  const state = signOauthState(
    { surfaceId, nonce, expiresAt: stateExpiresAt },
    process.env.DAY0_CREDENTIAL_KEY,
  );
  const verifier = sealed(pkce.verifier, client.ownerKey);
  const redirectUrl = redirectUrlFor(client.connection);
  const { server, resource } = target;
  await ctx.runMutation(internal.mcpOauth.recordPendingAuthorisation, {
    surfaceId,
    ownerKey: client.ownerKey,
    pending: {
      stateNonce: nonce,
      stateExpiresAt,
      clientId: client.clientId,
      verifierCiphertext: verifier.ciphertext,
      verifierIv: verifier.iv,
      verifierKeyId: verifier.keyId,
      issuer: server.issuer,
      resource,
      redirectUrl,
      organisationConnectionId: client.connection._id,
      startedAt: now,
      issuerMetadata: {
        issParameterSupported: server.issParameterSupported,
        tokenEndpoint: server.tokenEndpoint,
        tokenEndpointAuthMethods: [...server.tokenEndpointAuthMethods],
      },
    },
    discovered: {
      issuer: server.issuer,
      resource,
      authorisation: server.authorisationEndpoint,
      token: server.tokenEndpoint,
      ...(server.revocationEndpoint ? { revocation: server.revocationEndpoint } : {}),
      ...(server.registrationEndpoint ? { registration: server.registrationEndpoint } : {}),
      discoveredAt: now,
    },
  });
  const scopes = client.connection.scopes.length > 0 ? client.connection.scopes : target.scopes;
  return {
    ok: true,
    authoriseUrl: authorisationUrl({
      server,
      clientId: client.clientId,
      redirectUrl,
      state,
      challenge: pkce.challenge,
      resource,
      scopes,
    }).href,
  };
}

/**
 * Start an authorisation for one card: discover the server's authorisation server, seal a PKCE
 * verifier in the card's row with the issuer it must come back from, and hand back the URL the
 * manager's browser is sent to. The caller must own the employee; real mode only.
 *
 * @throws ConvexError when the card is gone; the ownership guard's error for another caller.
 */
export async function runStartAuthorisation(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
  deps: McpOauthDeps,
): Promise<StartOutcome> {
  const client = await startingClient(ctx, surfaceId);
  if ('ok' in client) return client;
  const target = await discoverFor(deps, client, surfaceId);
  if ('ok' in target) return target;
  return await recordStart(ctx, surfaceId, client, target, deps.now());
}

/**
 * Start an MCP card's authorisation. Public; the caller must own the employee
 * (`assertOwnsAgentAction`); real mode only. Writes the card's `pendingAuthorisation` and the
 * organisation connection's discovered endpoints.
 */
export const startAuthorisation = action({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<StartOutcome> => {
    await getCallerOrThrow(ctx);
    return await runStartAuthorisation(ctx, args.surfaceId, mcpOauthDeps());
  },
});

/** What the redirect route is told: where to send the browser, and what the card should say. */
export type CompleteOutcome =
  | { readonly ok: true; readonly agentId: Id<'agents'>; readonly surfaceSlug: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly agentId?: Id<'agents'>;
      readonly surfaceSlug?: string;
    };

/** What the redirect page says about a state this deployment refuses. */
const STATE_MESSAGES: Readonly<Record<OauthStateFailure | PendingClaimFailure, string>> = {
  malformed: 'That authorisation link is not one this deployment issued.',
  signature: 'That authorisation link is not one this deployment issued.',
  expired: 'That authorisation link has expired. Start the authorisation again from the card.',
  none: 'That authorisation has already been used or was cancelled. Start it again from the card.',
  used: 'That authorisation has already been used or was cancelled. Start it again from the card.',
  'not-the-manager':
    "Only the employee's manager, signed in to Day0, can finish this authorisation, so nothing was connected. The manager starts it from the card.",
};

/**
 * What a redirect with no signed-in caller is told (M2): most often the manager's own sign-in that
 * lapsed while they consented at the server, so it says that, and nothing is claimed.
 */
const SIGN_IN_LAPSED =
  'Your Day0 sign-in had lapsed, so nothing was connected. Sign in again, then start the authorisation again from the card.';

/** The redirect's query, as the route passes it on. */
export interface AuthorisationResponse {
  readonly state: string;
  readonly code?: string;
  readonly iss?: string;
  readonly error?: string;
}

/**
 * The longest each response parameter may be: a state this deployment signed, a code, an issuer
 * URL and an error code all fit well within them, so anything longer is refused unread.
 */
const RESPONSE_LIMITS: Readonly<Record<keyof AuthorisationResponse, number>> = {
  state: 2048,
  code: 2048,
  iss: 2048,
  error: 256,
};

function oversized(response: AuthorisationResponse): boolean {
  return (Object.keys(RESPONSE_LIMITS) as (keyof AuthorisationResponse)[]).some(
    (name) => (response[name]?.length ?? 0) > RESPONSE_LIMITS[name],
  );
}

/** A failure after the claim: on the card's record, and back to the route with the card named. */
async function failClaimed(
  ctx: ActionCtx,
  claim: ClaimedAuthorisation,
  surfaceId: Id<'surfaces'>,
  reason: string,
  now: number,
): Promise<CompleteOutcome> {
  const said = clipped(reason);
  await ctx.runMutation(internal.mcpOauth.recordAuthorisationFailure, {
    surfaceId,
    reason: said,
    now,
  });
  return { ok: false, reason: said, agentId: claim.agentId, surfaceSlug: claim.slug };
}

/** Why an authorisation response's issuer was refused, as the card says it. */
const ISSUER_REFUSALS = {
  'iss-mismatch':
    'The response came from another authorisation server than the one the authorisation started with, so its code was not used.',
  'iss-missing':
    'The authorisation server did not say who answered, which it advertises it does, so its code was not used.',
} as const;

/** The organisation connection the authorisation started under, if it is still the active one. */
async function connectionStill(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
  pending: ClaimedAuthorisation['pending'],
): Promise<Doc<'organisationConnections'> | null> {
  const context = await ctx.runQuery(internal.mcpOauth.authorisationContext, {
    surfaceId,
    system: mcpSystemKey(new URL(pending.resource)),
  });
  const connection = context?.connection ?? null;
  return connection && connection._id === pending.organisationConnectionId ? connection : null;
}

/** What the callback acts on of the issuer's metadata. */
type CallbackMetadata = NonNullable<ClaimedAuthorisation['pending']['issuerMetadata']>;

/**
 * What the issuer's metadata said when the authorisation started, as the start recorded it with
 * the pending authorisation (R-S): the callback holds the response to the issuer the start was
 * checked against, whatever the metadata says now. An authorisation started before the record
 * reads the metadata again.
 */
async function callbackMetadata(
  deps: McpOauthDeps,
  pending: ClaimedAuthorisation['pending'],
): Promise<CallbackMetadata> {
  if (pending.issuerMetadata !== undefined) return pending.issuerMetadata;
  const server = await fetchAuthorisationServerMetadata(deps.fetch, pending.issuer);
  return {
    issParameterSupported: server.issParameterSupported,
    tokenEndpoint: server.tokenEndpoint,
    tokenEndpointAuthMethods: [...server.tokenEndpointAuthMethods],
  };
}

/**
 * Check the response against the claimed authorisation and, when it holds, exchange its code and
 * land the tokens. The issuer check comes first: on a mismatch nothing the response carries is
 * acted on or shown, an error included (the revision).
 *
 * @returns The card's reason when the response is refused, else undefined once the tokens landed.
 * @throws Error with every secret it held (the code, the client secret, the verifier) removed.
 */
async function exchangeAndLand(
  ctx: ActionCtx,
  claim: ClaimedAuthorisation,
  surfaceId: Id<'surfaces'>,
  response: AuthorisationResponse,
  deps: McpOauthDeps,
): Promise<string | undefined> {
  const { pending } = claim;
  const held: string[] = response.code ? [response.code] : [];
  try {
    const server = await callbackMetadata(deps, pending);
    const issuer = checkResponseIssuer({
      iss: response.iss ?? null,
      recordedIssuer: pending.issuer,
      issParameterSupported: server.issParameterSupported,
    });
    if (!issuer.ok) return ISSUER_REFUSALS[issuer.reason];
    if (response.error !== undefined) {
      return 'The authorisation was declined at the authorisation server.';
    }
    if (!response.code) return 'The authorisation server sent no code.';
    const connection = await connectionStill(ctx, surfaceId, pending);
    if (!connection) {
      return "The organisation's connection for this server was revoked or replaced while the authorisation was under way.";
    }
    const secret = connection.secretCredentialId
      ? await decryptCredential(ctx, connection.secretCredentialId)
      : undefined;
    if (secret) held.push(secret);
    const verifier = openOwnedCredential(
      {
        ciphertext: pending.verifierCiphertext,
        iv: pending.verifierIv,
        userId: claim.ownerKey,
        ...(pending.verifierKeyId === undefined ? {} : { keyId: pending.verifierKeyId }),
      },
      credentialKeyring(),
      { allowUnbound: false },
    );
    held.push(verifier);
    const tokens = await requestTokens(
      deps.fetch,
      {
        tokenEndpoint: server.tokenEndpoint,
        clientId: pending.clientId,
        auth: clientAuthentication(server, secret),
        resource: pending.resource,
        grant: {
          grant: 'authorization_code',
          code: response.code,
          redirectUrl: pending.redirectUrl,
          verifier,
        },
      },
      deps.now(),
    );
    held.push(tokens.accessToken, ...(tokens.refreshToken ? [tokens.refreshToken] : []));
    const grant: CredentialGrant = 'authorisation-code';
    await deps.store.land(ctx, {
      surfaceId,
      ownerKey: claim.ownerKey,
      tokens,
      issuedBy: {
        system: mcpSystemKey(new URL(pending.resource)),
        grant,
        organisationConnectionId: connection._id,
        clientId: pending.clientId,
        ...(connection.secretCredentialId
          ? { clientSecretCredentialId: connection.secretCredentialId }
          : {}),
      },
      actsAs: { kind: 'delegated', label: claim.managerAddress },
      issuer: pending.issuer,
      now: deps.now(),
    });
    return undefined;
  } catch (error) {
    const [first = '', ...rest] = held;
    throw new Error(
      safeFailureMessage(
        error,
        first,
        'The authorisation could not be completed.',
        REASON_LENGTH,
        rest,
      ),
    );
  }
}

/**
 * Complete an authorisation from the redirect: verify the signed state, consume the card's pending
 * authorisation for the card's manager alone, apply the RFC 9207 check before the code goes
 * anywhere, exchange the code with the sealed verifier and the resource, and land the tokens. The
 * signed, single-use state names the card; the caller's owner key must be the employee's owner's
 * (the wave 11 review's M2, decision 3 (a)), so a consent given in another person's browser never
 * lands on the manager's card as the manager.
 *
 * @param callerOwnerKey - The signed-in caller's owner key, or undefined with no caller.
 */
export async function runCompleteAuthorisation(
  ctx: ActionCtx,
  response: AuthorisationResponse,
  callerOwnerKey: string | undefined,
  deps: McpOauthDeps,
): Promise<CompleteOutcome> {
  if (oversized(response)) return { ok: false, reason: STATE_MESSAGES.malformed };
  if (callerOwnerKey === undefined) return { ok: false, reason: SIGN_IN_LAPSED };
  const now = deps.now();
  const verified = verifyOauthState(response.state, process.env.DAY0_CREDENTIAL_KEY, now);
  if (!verified.ok) return { ok: false, reason: STATE_MESSAGES[verified.reason] };
  const surfaceId = verified.surfaceId as Id<'surfaces'>;
  const claim: ClaimedAuthorisation | { ok: false; reason: PendingClaimFailure } =
    await ctx.runMutation(internal.mcpOauth.claimPendingAuthorisation, {
      surfaceId,
      stateNonce: verified.nonce,
      callerOwnerKey,
      now,
    });
  if (!claim.ok) return { ok: false, reason: STATE_MESSAGES[claim.reason] };
  let refusal: string | undefined;
  try {
    refusal = await exchangeAndLand(ctx, claim, surfaceId, response, deps);
  } catch (error) {
    refusal = error instanceof Error ? error.message : 'The authorisation could not be completed.';
  }
  if (refusal !== undefined) return await failClaimed(ctx, claim, surfaceId, refusal, deps.now());
  return { ok: true, agentId: claim.agentId, surfaceSlug: claim.slug };
}

/**
 * Complete an MCP card's authorisation from the redirect `app/api/oauth/mcp` received, as the
 * browser's signed-in caller. Public: the signed, single-use state names the card, and only its
 * employee's manager completes it (M2, decision 3 (a)); real mode only. Writes the card's
 * credential, its `actsAs` and `organisationConnectionId`, two credential rows and the record's
 * `surface.authorised` or `surface.authorisation-failed`.
 */
export const completeAuthorisation = action({
  args: {
    state: v.string(),
    code: v.optional(v.string()),
    iss: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CompleteOutcome> => {
    assertRealMode('MCP authorisation');
    const caller = await getCaller(ctx);
    return await runCompleteAuthorisation(ctx, args, caller?.ownerKey, mcpOauthDeps());
  },
});

/** How a transport failure reads: a timeout, a refused or reset connection, a resolver's miss. */
const TRANSPORT_FAILURE =
  /(timed? ?out|timeout|aborted|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|socket hang up|fetch failed|closed the connection)/i;

/**
 * Whether a failed refresh may succeed later: a transport failure, a busy server, or metadata that
 * could not be read. A refusal of the client, a mismatched issuer, a malformed answer, an address
 * the rules refuse or a secret no longer held cannot, and is recorded at once.
 */
function retryable(error: unknown): boolean {
  if (error instanceof McpOauthRefusal) {
    return error.reason === 'token-unavailable' || error.reason === 'no-authorisation-server';
  }
  if (error instanceof McpAddressRefusal || error instanceof ConvexError) return false;
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      TRANSPORT_FAILURE.test(error.message))
  );
}

/** What a refresh revokes when it cannot keep what it was issued. */
interface UnkeptTokens {
  readonly server: AuthorisationServerMetadata;
  readonly clientId: string;
  readonly auth: ClientAuthentication;
  /** The refresh token the refresh presented. */
  readonly presented: string;
  readonly issued: IssuedTokens;
  readonly credentialId: Id<'credentials'>;
}

/**
 * Revoke at the server a refresh token Day0 was issued for a credential revoked meanwhile, so it
 * does not stay live at the vendor unrecorded. Only a rotated one: a server that does not rotate
 * handed back the very token the pair held. Best effort; a failure is logged.
 */
async function revokeUnkept(deps: McpOauthDeps, unkept: UnkeptTokens): Promise<void> {
  const issued = unkept.issued.refreshToken;
  if (!issued || issued === unkept.presented || !unkept.server.revocationEndpoint) return;
  try {
    await revokeToken(deps.fetch, {
      revocationEndpoint: unkept.server.revocationEndpoint,
      clientId: unkept.clientId,
      auth: unkept.auth,
      token: issued,
      tokenTypeHint: 'refresh_token',
    });
  } catch (error) {
    log.warn('mcp unkept refresh token not revoked', {
      credentialId: unkept.credentialId,
      reason: safeFailureMessage(error, issued, 'The revocation failed.'),
    });
  }
}

/**
 * The MCP client's half of a native refresh (the token store owns when, the generation and the
 * rotation-safe write): an MCP authorisation's tokens, refreshed at a read within
 * {@link MCP_READ_REFRESH_MARGIN_MS} of their expiry, by exchanging the refresh token with the
 * resource at the recorded issuer's token endpoint.
 */
export function mcpTokenRefresher(deps: McpOauthDeps): TokenRefresher {
  return {
    name: 'mcp',
    owns: (issuedBy): boolean => issuedBy.system.startsWith(MCP_SYSTEM_PREFIX),
    readRefreshMarginMs: MCP_READ_REFRESH_MARGIN_MS,
    retryable,
    prepare: async (ctx, held): Promise<RefreshPreparation> => {
      const connection = held.connection;
      const clientId = held.issuedBy?.clientId ?? connection?.clientId;
      if (!connection?.issuer || !connection.resource || !clientId) {
        return {
          ok: false,
          refusal:
            "The organisation's connection no longer says where this authorisation is refreshed.",
        };
      }
      const resource = connection.resource;
      const server = await fetchAuthorisationServerMetadata(deps.fetch, connection.issuer);
      // The connection's current secret first: a rotation revokes the one a token was issued
      // under, and the server takes only the new one (the wave 11 review's M9).
      const secretId = connection.secretCredentialId ?? held.issuedBy?.clientSecretCredentialId;
      const auth = clientAuthentication(
        server,
        secretId ? await decryptCredential(ctx, secretId) : undefined,
      );
      return {
        ok: true,
        refresh: {
          exchange: async (presented: string): Promise<IssuedTokens> => {
            try {
              return await requestTokens(
                deps.fetch,
                {
                  tokenEndpoint: server.tokenEndpoint,
                  clientId,
                  auth,
                  resource,
                  grant: { grant: 'refresh_token', refreshToken: presented },
                },
                deps.now(),
              );
            } catch (error) {
              if (error instanceof McpOauthRefusal && error.reason === 'token-refused') {
                throw new TokenRefreshRefused(error.message);
              }
              throw error;
            }
          },
          discard: async (presented: string, issued: IssuedTokens): Promise<void> =>
            await revokeUnkept(deps, {
              server,
              clientId,
              auth,
              presented,
              issued,
              credentialId: held.credentialId,
            }),
        },
      };
    },
  };
}

/**
 * The token store's Nango backend on this deployment: the configured Nango (read at each ask, so
 * a deployment without it refuses only the credentials Nango would hold), reached with the plain
 * fetch, since it is the operator's own service on the compose file's private network.
 */
const nangoBackend = nangoTokenBackend({
  fetch: async (input: URL, init: RequestInit): Promise<Response> => await fetch(input, init),
  config: (): NangoConfig => nangoConfigFrom(process.env),
  location: async (ctx, credentialId): Promise<string> =>
    await decryptCredential(ctx, credentialId),
});

/**
 * The token store as this deployment composes it: the native keeper with the MCP client's
 * refresher and Linear's (an employee's own app's tokens, 11-AL), and Nango.
 */
function tokenStoreDeps(deps: McpOauthDeps): TokenStoreDeps {
  return {
    keeper: deps.store,
    refreshers: [mcpTokenRefresher(deps), linearTokenRefresher(linearIdentityDeps())],
    now: deps.now,
    backends: [nangoBackend],
  };
}

/**
 * The bearer to send for a credential, from the token store (`accessTokenFor`): its stored value,
 * refreshed first when it is an MCP authorisation's access token within
 * {@link MCP_READ_REFRESH_MARGIN_MS} of its expiry. A refresh that fails while the stored token
 * still lives hands that token back; any other credential is read exactly as `credentials.decrypt`
 * reads it.
 *
 * @throws Error when the credential is unavailable, or an expired authorisation could not be
 *   refreshed (the manager authorises again).
 */
export async function readMcpBearer(
  ctx: ActionCtx,
  credentialId: Id<'credentials'>,
  deps: McpOauthDeps = mcpOauthDeps(),
): Promise<string> {
  return await accessTokenFor(ctx, credentialId, tokenStoreDeps(deps));
}

/**
 * The runtime's one read of a surface's bearer, in the shape the surface adapters and the re-read
 * take a decrypt (every rung, the probe and intake): the organisation's shared Linear app-actor
 * token from its issuer, which requests it again in its last day (`readLinearBearer`, AL6), and
 * every other credential from the token store ({@link readMcpBearer}), which refreshes an MCP
 * authorisation's and an employee's own Linear app's tokens when due.
 */
export const readSurfaceBearer: DecryptCredential = async (ctx, credentialId) =>
  (await readLinearBearer(ctx, credentialId)) ??
  (await readMcpBearer(ctx, credentialId as Id<'credentials'>));

/**
 * The bearer to send for a credential, renewed first when due ({@link readSurfaceBearer}).
 * Internal, for an action in another module that holds a credential id (the probe); records the
 * credential's use, as `credentials.decrypt` does.
 */
export const currentBearer = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> => await readSurfaceBearer(ctx, args.credentialId),
});

/**
 * Refresh an authorisation ahead of its expiry, so every reader of the stored token (the probe
 * included) finds a live one: the token store's scheduled refresh (`runScheduledRefresh`), retried
 * here and recorded on the record of every card holding the token. Internal; scheduled by
 * `mcpOauth` at each landing and rotation.
 */
export const refreshScheduled = internalAction({
  args: {
    credentialId: v.id('credentials'),
    generation: v.number(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const deps = mcpOauthDeps();
    await runScheduledRefresh(ctx, args, {
      ...tokenStoreDeps(deps),
      retryAfter: async (delayMs: number, attempt: number): Promise<void> => {
        await ctx.scheduler.runAfter(delayMs, internal.mcpOauthActions.refreshScheduled, {
          ...args,
          attempt,
        });
      },
      recordRefusal: async (reason: string): Promise<void> => {
        await ctx.runMutation(internal.mcpOauth.recordRefreshRefusal, {
          credentialId: args.credentialId,
          reason: clipped(reason),
          now: deps.now(),
        });
      },
    });
  },
});

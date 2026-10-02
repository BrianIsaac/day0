'use node';

import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { credentialKeyring } from './credentialCryptoActions';
import {
  MCP_READ_REFRESH_MARGIN_MS,
  type ClaimedAuthorisation,
  type HeldTokenRows,
  type PendingClaimFailure,
  type RotationOutcome,
} from './mcpOauth';
import { assertOwnsAgentAction } from './ownership';
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
import type { ActsAs, CredentialGrant } from '../src/surfaces/access-identity';
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
  MCP_SYSTEM_PREFIX,
  McpOauthRefusal,
  mcpSystemKey,
  newPkcePair,
  requestTokens,
  type IssuedTokens,
  type McpOauthRefusalReason,
  type OauthFetch,
} from '../src/surfaces/mcp-oauth';
import { safeFailureMessage } from '../src/surfaces/redact';

/*
 * The MCP rung's OAuth 2.1 client in the deployment (wave 11, 11-AM; the access plan, section
 * 4.6): the manager starts an authorisation from the card, the authorisation server sends the
 * manager's own browser back to `app/api/oauth/mcp` (Q13: no inbound endpoint), the redirect
 * completes it, and the tokens are kept fresh by a scheduled refresh with rotation and by a
 * refresh at read time. Tokens are read and written through one seam, {@link McpTokenStore},
 * which the token store (11-AT, `src/surfaces/token-store.ts`) re-points.
 */

/** The route the authorisation server sends the person's browser back to. */
export const MCP_OAUTH_REDIRECT_PATH = '/api/oauth/mcp';

/** How many times a scheduled refresh that could not reach the server is tried again. */
const SCHEDULED_REFRESH_RETRIES = 5;

/** How long a refresh that lost to a concurrent one waits, each time, for the winner's write. */
const ROTATION_WAIT_MS = 200;

/** How many times it waits. */
const ROTATION_WAITS = 3;

/** The credential an MCP authorisation landed, as the token store is told to keep it. */
export interface LandMcpTokens {
  readonly surfaceId: Id<'surfaces'>;
  /** The employee's owner when the authorisation started; the landing refuses another. */
  readonly ownerKey: string;
  readonly tokens: IssuedTokens;
  readonly issuedBy: NonNullable<Doc<'credentials'>['issuedBy']>;
  readonly actsAs: ActsAs;
  readonly issuer: string;
  readonly now: number;
}

/** A held access token, as a read or a refresh needs it; never its value. */
export interface HeldMcpTokens {
  readonly credentialId: Id<'credentials'>;
  readonly ownerKey: string;
  /** Absent on the row reads as 0. */
  readonly generation: number;
  readonly expiresAt?: number;
  readonly issuedBy?: Doc<'credentials'>['issuedBy'];
  /** Whether a live refresh token is paired with it. */
  readonly refreshable: boolean;
  readonly connection: Doc<'organisationConnections'> | null;
}

/** A refresh's tokens, to be written only while the pair is still at `expectedGeneration`. */
export interface RotateMcpTokens {
  readonly credentialId: Id<'credentials'>;
  readonly ownerKey: string;
  readonly expectedGeneration: number;
  readonly tokens: IssuedTokens;
  readonly now: number;
}

/**
 * Where an MCP authorisation's tokens are kept and read: the seam the token store (11-AT)
 * re-points. The native store keeps them in `credentials` rows sealed for the employee's owner.
 */
export interface McpTokenStore {
  /** Land a new authorisation's tokens on the card, replacing what it held. */
  land(ctx: ActionCtx, landing: LandMcpTokens): Promise<Id<'credentials'>>;
  /** The held pair's metadata, or null when the access token's row is gone. */
  read(ctx: ActionCtx, credentialId: Id<'credentials'>): Promise<HeldMcpTokens | null>;
  /** The access token's value, recording its use; refused once it is revoked. */
  accessToken(ctx: ActionCtx, credentialId: Id<'credentials'>): Promise<string>;
  /** The paired refresh token's value; refused when there is none or it is revoked. */
  refreshToken(ctx: ActionCtx, credentialId: Id<'credentials'>): Promise<string>;
  /** Write a refresh's tokens atomically, refusing a stale generation. */
  rotate(ctx: ActionCtx, rotation: RotateMcpTokens): Promise<RotationOutcome>;
}

function sealed(
  value: string,
  ownerKey: string,
): { ciphertext: string; iv: string; keyId: string } {
  return sealForOwner(value, credentialKeyring(), ownerKey);
}

/** The native token store: `credentials` rows, sealed for the employee's owner. */
export const nativeMcpTokenStore: McpTokenStore = {
  land: async (ctx, landing) =>
    await ctx.runMutation(internal.mcpOauth.landAuthorisedTokens, {
      surfaceId: landing.surfaceId,
      ownerKey: landing.ownerKey,
      access: sealed(landing.tokens.accessToken, landing.ownerKey),
      ...(landing.tokens.refreshToken
        ? { refresh: sealed(landing.tokens.refreshToken, landing.ownerKey) }
        : {}),
      ...(landing.tokens.expiresAt === undefined ? {} : { expiresAt: landing.tokens.expiresAt }),
      issuedBy: landing.issuedBy,
      actsAs: landing.actsAs,
      issuer: landing.issuer,
      now: landing.now,
    }),
  read: async (ctx, credentialId) => {
    const rows: HeldTokenRows | null = await ctx.runQuery(internal.mcpOauth.heldTokens, {
      credentialId,
    });
    if (!rows) return null;
    const { access, refresh, connection } = rows;
    return {
      credentialId,
      ownerKey: access.userId,
      generation: access.generation ?? 0,
      ...(access.expiresAt === undefined ? {} : { expiresAt: access.expiresAt }),
      ...(access.issuedBy === undefined ? {} : { issuedBy: access.issuedBy }),
      refreshable:
        refresh !== null && refresh.revokedAt === undefined && refresh.ciphertext !== undefined,
      connection,
    };
  },
  accessToken: async (ctx, credentialId) => await decryptCredential(ctx, credentialId),
  refreshToken: async (ctx, credentialId) => {
    const rows: HeldTokenRows | null = await ctx.runQuery(internal.mcpOauth.heldTokens, {
      credentialId,
    });
    if (!rows?.refresh) throw new Error('No refresh token is held for this authorisation.');
    return await decryptCredential(ctx, rows.refresh._id);
  },
  rotate: async (ctx, rotation) =>
    await ctx.runMutation(internal.mcpOauth.rotateTokens, {
      credentialId: rotation.credentialId,
      expectedGeneration: rotation.expectedGeneration,
      access: sealed(rotation.tokens.accessToken, rotation.ownerKey),
      ...(rotation.tokens.refreshToken
        ? { refresh: sealed(rotation.tokens.refreshToken, rotation.ownerKey) }
        : {}),
      ...(rotation.tokens.expiresAt === undefined ? {} : { expiresAt: rotation.tokens.expiresAt }),
      now: rotation.now,
    }),
};

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
  | 'address-refused'
  | 'unreachable';

/** What starting an authorisation answers the card. */
export type StartOutcome =
  | { readonly ok: true; readonly authoriseUrl: string }
  | { readonly ok: false; readonly reason: StartRefusalReason; readonly message: string };

function refused(reason: StartRefusalReason, message: string): StartOutcome {
  return { ok: false, reason, message };
}

/** The public origin the redirect is registered under. */
function redirectUrlFor(connection: Doc<'organisationConnections'>): string {
  if (connection.redirectUrl) return connection.redirectUrl;
  const origin = process.env.DAY0_PUBLIC_URL?.trim();
  if (!origin) {
    throw new Error(
      'DAY0_PUBLIC_URL is not set, so the authorisation server has nowhere to send the browser back to.',
    );
  }
  return new URL(MCP_OAUTH_REDIRECT_PATH, origin).href;
}

/**
 * Start an authorisation for one card: discover the server's authorisation server, seal a PKCE
 * verifier in the card's row with the issuer it must come back from, and hand back the URL the
 * manager's browser is sent to. The caller must own the employee; real mode only.
 *
 * @throws Error when the card is gone or the caller does not own the employee.
 */
export async function runStartAuthorisation(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
  deps: McpOauthDeps,
): Promise<StartOutcome> {
  const found = await ctx.runQuery(internal.orientationData.surfaceForOrientation, { surfaceId });
  if (!found) throw new Error('Surface not found.');
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
  if (!context) throw new Error('Surface not found.');
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
  const resource = canonicalResource(endpoint);
  if (connection.resource && connection.resource !== resource) {
    return refused(
      'resource-mismatch',
      "The organisation's connection for this server names another resource.",
    );
  }
  if (!agent.userId) throw new Error('The employee has no owner.');

  let target;
  try {
    target = await discoverAuthorisation(deps.fetch, endpoint, {
      ...(connection.issuer ? { issuer: connection.issuer } : {}),
    });
  } catch (error) {
    if (error instanceof McpOauthRefusal) return refused(error.reason, error.message);
    if (error instanceof McpAddressRefusal) return refused('address-refused', error.message);
    const message = safeFailureMessage(error, '', 'The server could not be reached.');
    log.warn('mcp authorisation discovery failed', { surfaceId, reason: message });
    return refused('unreachable', `Discovery could not reach the server: ${message}`);
  }

  const now = deps.now();
  const pkce = newPkcePair();
  const nonce = newOauthNonce();
  const stateExpiresAt = now + OAUTH_STATE_TTL_MS;
  const state = signOauthState(
    { surfaceId, nonce, expiresAt: stateExpiresAt },
    process.env.DAY0_CREDENTIAL_KEY,
  );
  const verifier = sealed(pkce.verifier, agent.userId);
  const redirectUrl = redirectUrlFor(connection);
  const scopes = connection.scopes.length > 0 ? connection.scopes : target.scopes;
  await ctx.runMutation(internal.mcpOauth.recordPendingAuthorisation, {
    surfaceId,
    ownerKey: agent.userId,
    pending: {
      stateNonce: nonce,
      stateExpiresAt,
      clientId: connection.clientId,
      verifierCiphertext: verifier.ciphertext,
      verifierIv: verifier.iv,
      verifierKeyId: verifier.keyId,
      issuer: target.server.issuer,
      resource: target.resource,
      redirectUrl,
      organisationConnectionId: connection._id,
      startedAt: now,
    },
    discovered: {
      issuer: target.server.issuer,
      resource: target.resource,
      authorisation: target.server.authorisationEndpoint,
      token: target.server.tokenEndpoint,
      ...(target.server.revocationEndpoint ? { revocation: target.server.revocationEndpoint } : {}),
      ...(target.server.registrationEndpoint
        ? { registration: target.server.registrationEndpoint }
        : {}),
      discoveredAt: now,
    },
  });
  return {
    ok: true,
    authoriseUrl: authorisationUrl({
      server: target.server,
      clientId: connection.clientId,
      redirectUrl,
      state,
      challenge: pkce.challenge,
      resource: target.resource,
      scopes,
    }).href,
  };
}

/**
 * Start an MCP card's authorisation. Public; the caller must own the employee
 * (`assertOwnsAgentAction`); real mode only. Writes the card's `pendingAuthorisation` and the
 * organisation connection's discovered endpoints.
 */
export const startAuthorisation = action({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<StartOutcome> =>
    await runStartAuthorisation(ctx, args.surfaceId, mcpOauthDeps()),
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
};

/** The redirect's query, as the route passes it on. */
export interface AuthorisationResponse {
  readonly state: string;
  readonly code?: string;
  readonly iss?: string;
  readonly error?: string;
}

/** A failure after the claim: on the card's record, and back to the route with the card named. */
async function failClaimed(
  ctx: ActionCtx,
  claim: ClaimedAuthorisation,
  surfaceId: Id<'surfaces'>,
  reason: string,
  now: number,
): Promise<CompleteOutcome> {
  await ctx.runMutation(internal.mcpOauth.recordAuthorisationFailure, { surfaceId, reason, now });
  return { ok: false, reason, agentId: claim.agentId, surfaceSlug: claim.slug };
}

/** Why an authorisation response's issuer was refused, as the card says it. */
const ISSUER_REFUSALS = {
  'iss-mismatch':
    'The response came from another authorisation server than the one the authorisation started with, so its code was not used.',
  'iss-missing':
    'The authorisation server did not say who answered, which it advertises it does, so its code was not used.',
} as const;

/**
 * Complete an authorisation from the redirect: verify the signed state, consume the card's pending
 * authorisation, apply the RFC 9207 check before the code goes anywhere, exchange the code with the
 * sealed verifier and the resource, and land the tokens. No caller identity: the signed,
 * single-use state is the authority, as for the Slack install.
 */
export async function runCompleteAuthorisation(
  ctx: ActionCtx,
  response: AuthorisationResponse,
  deps: McpOauthDeps,
): Promise<CompleteOutcome> {
  const now = deps.now();
  const verified = verifyOauthState(response.state, process.env.DAY0_CREDENTIAL_KEY, now);
  if (!verified.ok) return { ok: false, reason: STATE_MESSAGES[verified.reason] };
  const surfaceId = verified.surfaceId as Id<'surfaces'>;
  const claim: ClaimedAuthorisation | { ok: false; reason: PendingClaimFailure } =
    await ctx.runMutation(internal.mcpOauth.claimPendingAuthorisation, {
      surfaceId,
      stateNonce: verified.nonce,
      now,
    });
  if (!claim.ok) return { ok: false, reason: STATE_MESSAGES[claim.reason] };
  const { pending } = claim;

  let secret = '';
  let verifier = '';
  try {
    const server = await fetchAuthorisationServerMetadata(deps.fetch, pending.issuer);
    const issuer = checkResponseIssuer({
      iss: response.iss ?? null,
      recordedIssuer: pending.issuer,
      issParameterSupported: server.issParameterSupported,
    });
    // The revision: on an issuer mismatch nothing the response carries is acted on or shown, an
    // error included, so this check comes before the error is read.
    if (!issuer.ok)
      return await failClaimed(ctx, claim, surfaceId, ISSUER_REFUSALS[issuer.reason], now);
    if (response.error !== undefined) {
      return await failClaimed(
        ctx,
        claim,
        surfaceId,
        'The authorisation was declined at the authorisation server.',
        now,
      );
    }
    if (!response.code) {
      return await failClaimed(
        ctx,
        claim,
        surfaceId,
        'The authorisation server sent no code.',
        now,
      );
    }
    const system = mcpSystemKey(new URL(pending.resource));
    const context = await ctx.runQuery(internal.mcpOauth.authorisationContext, {
      surfaceId,
      system,
    });
    const connection = context?.connection ?? null;
    if (!connection || connection._id !== pending.organisationConnectionId) {
      return await failClaimed(
        ctx,
        claim,
        surfaceId,
        "The organisation's connection for this server was revoked or replaced while the authorisation was under way.",
        now,
      );
    }
    secret = connection.secretCredentialId
      ? await decryptCredential(ctx, connection.secretCredentialId)
      : '';
    verifier = openOwnedCredential(
      {
        ciphertext: pending.verifierCiphertext,
        iv: pending.verifierIv,
        userId: claim.ownerKey,
        ...(pending.verifierKeyId === undefined ? {} : { keyId: pending.verifierKeyId }),
      },
      credentialKeyring(),
      { allowUnbound: false },
    );
    const tokens = await requestTokens(
      deps.fetch,
      {
        tokenEndpoint: server.tokenEndpoint,
        clientId: pending.clientId,
        auth: clientAuthentication(server, secret === '' ? undefined : secret),
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
    const grant: CredentialGrant = 'authorisation-code';
    await deps.store.land(ctx, {
      surfaceId,
      ownerKey: claim.ownerKey,
      tokens,
      issuedBy: {
        system,
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
    return { ok: true, agentId: claim.agentId, surfaceSlug: claim.slug };
  } catch (error) {
    const reason =
      error instanceof McpOauthRefusal || error instanceof McpAddressRefusal
        ? error.message
        : safeFailureMessage(
            error,
            response.code ?? '',
            'The authorisation could not be completed.',
            300,
            [secret, verifier].filter((value) => value !== ''),
          );
    return await failClaimed(ctx, claim, surfaceId, reason, deps.now());
  } finally {
    secret = '';
    verifier = '';
  }
}

/**
 * Complete an MCP card's authorisation from the redirect `app/api/oauth/mcp` received. Public and
 * without a caller identity: the signed, single-use state names the card; real mode only. Writes
 * the card's credential, its `actsAs` and `organisationConnectionId`, two credential rows and the
 * record's `surface.authorised` or `surface.authorisation-failed`.
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
    return await runCompleteAuthorisation(ctx, args, mcpOauthDeps());
  },
});

/** Whether a held token is an MCP authorisation's that this client can refresh. */
function refreshable(held: HeldMcpTokens): boolean {
  return (
    held.issuedBy?.system.startsWith(MCP_SYSTEM_PREFIX) === true &&
    held.refreshable &&
    held.expiresAt !== undefined &&
    held.connection !== null
  );
}

/** What a refresh answers. */
type RefreshOutcome =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly refusal: string };

/** The held pair after a concurrent refresh's write, or null when none lands while it waits. */
async function rotatedSince(
  ctx: ActionCtx,
  held: HeldMcpTokens,
  deps: McpOauthDeps,
): Promise<HeldMcpTokens | null> {
  for (let attempt = 0; attempt < ROTATION_WAITS; attempt += 1) {
    const again = await deps.store.read(ctx, held.credentialId);
    if (again && again.generation !== held.generation) return again;
    await new Promise((resolve) => setTimeout(resolve, ROTATION_WAIT_MS));
  }
  return null;
}

/**
 * Refresh a held authorisation with rotation: exchange its refresh token, with the resource, at the
 * issuer's token endpoint, and write the new pair only while the pair is still at the generation
 * read. A refresh that loses to a concurrent one (its write refused as stale, or its spent refresh
 * token refused) takes the winner's token.
 *
 * @throws McpOauthRefusal or a transport error when the server cannot be reached; a refusal of
 *   the refresh by the server is the typed outcome instead.
 */
async function refreshHeld(
  ctx: ActionCtx,
  held: HeldMcpTokens,
  deps: McpOauthDeps,
): Promise<RefreshOutcome> {
  const connection = held.connection;
  const clientId = held.issuedBy?.clientId ?? connection?.clientId;
  if (!connection?.issuer || !connection.resource || !clientId) {
    return {
      ok: false,
      refusal:
        "The organisation's connection no longer says where this authorisation is refreshed.",
    };
  }
  const server = await fetchAuthorisationServerMetadata(deps.fetch, connection.issuer);
  const secret = connection.secretCredentialId
    ? await decryptCredential(ctx, connection.secretCredentialId)
    : undefined;
  let tokens: IssuedTokens;
  try {
    tokens = await requestTokens(
      deps.fetch,
      {
        tokenEndpoint: server.tokenEndpoint,
        clientId,
        auth: clientAuthentication(server, secret),
        resource: connection.resource,
        grant: {
          grant: 'refresh_token',
          refreshToken: await deps.store.refreshToken(ctx, held.credentialId),
        },
      },
      deps.now(),
    );
  } catch (error) {
    if (!(error instanceof McpOauthRefusal) || error.reason !== 'token-refused') throw error;
    if (await rotatedSince(ctx, held, deps)) {
      return { ok: true, accessToken: await deps.store.accessToken(ctx, held.credentialId) };
    }
    return { ok: false, refusal: `Refreshing the authorisation was refused: ${error.message}` };
  }
  const rotation = await deps.store.rotate(ctx, {
    credentialId: held.credentialId,
    ownerKey: held.ownerKey,
    expectedGeneration: held.generation,
    tokens,
    now: deps.now(),
  });
  if (rotation.ok) return { ok: true, accessToken: tokens.accessToken };
  if (rotation.reason === 'stale') {
    return { ok: true, accessToken: await deps.store.accessToken(ctx, held.credentialId) };
  }
  return { ok: false, refusal: 'The authorisation was revoked while it was being refreshed.' };
}

/**
 * The bearer to send for a credential: its stored value, refreshed first when it is an MCP
 * authorisation's access token within {@link MCP_READ_REFRESH_MARGIN_MS} of its expiry. Any other
 * credential is read exactly as `credentials.decrypt` reads it.
 *
 * @throws Error when the credential is unavailable, or an expiring authorisation's refresh was
 *   refused (the manager authorises again).
 */
export async function readMcpBearer(
  ctx: ActionCtx,
  credentialId: Id<'credentials'>,
  deps: McpOauthDeps = mcpOauthDeps(),
): Promise<string> {
  const held = await deps.store.read(ctx, credentialId);
  if (
    !held ||
    !refreshable(held) ||
    (held.expiresAt ?? 0) - deps.now() > MCP_READ_REFRESH_MARGIN_MS
  ) {
    return await deps.store.accessToken(ctx, credentialId);
  }
  const outcome = await refreshHeld(ctx, held, deps);
  if (outcome.ok) return outcome.accessToken;
  if ((held.expiresAt ?? 0) > deps.now()) return await deps.store.accessToken(ctx, credentialId);
  throw new Error(`${outcome.refusal} Authorise the card again.`);
}

/**
 * {@link readMcpBearer} in the shape the surface adapters and the re-read take a decrypt: the
 * runtime's one read of a surface's bearer.
 */
export const readSurfaceBearer: DecryptCredential = async (ctx, credentialId) =>
  await readMcpBearer(ctx, credentialId as Id<'credentials'>);

/**
 * The bearer to send for a credential, refreshed first when due (see {@link readMcpBearer}).
 * Internal, for an action in another module that holds a credential id (the probe); records the
 * credential's use, as `credentials.decrypt` does.
 */
export const currentBearer = internalAction({
  args: { credentialId: v.id('credentials') },
  handler: async (ctx, args): Promise<string> => await readMcpBearer(ctx, args.credentialId),
});

/**
 * Refresh an authorisation ahead of its expiry, so every reader of the stored token (the probe
 * included) finds a live one. Does nothing when another refresh has moved the pair on. A refusal by
 * the server goes on the record of every card holding the token; a server that cannot be reached
 * is tried again with a growing wait. Internal; scheduled by `mcpOauth` at each landing and rotation.
 */
export const refreshScheduled = internalAction({
  args: {
    credentialId: v.id('credentials'),
    generation: v.number(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const deps = mcpOauthDeps();
    const held = await deps.store.read(ctx, args.credentialId);
    if (!held || held.generation !== args.generation || !refreshable(held)) return;
    let outcome: RefreshOutcome;
    try {
      outcome = await refreshHeld(ctx, held, deps);
    } catch (error) {
      const attempt = args.attempt ?? 0;
      const reason = safeFailureMessage(
        error,
        '',
        'The authorisation server could not be reached.',
      );
      log.warn('mcp scheduled refresh failed', {
        credentialId: args.credentialId,
        attempt,
        reason,
      });
      if (attempt < SCHEDULED_REFRESH_RETRIES) {
        await ctx.scheduler.runAfter(
          60_000 * 2 ** attempt,
          internal.mcpOauthActions.refreshScheduled,
          { ...args, attempt: attempt + 1 },
        );
      }
      return;
    }
    if (outcome.ok) return;
    await ctx.runMutation(internal.mcpOauth.recordRefreshRefusal, {
      credentialId: args.credentialId,
      reason: outcome.refusal,
      now: deps.now(),
    });
  },
});

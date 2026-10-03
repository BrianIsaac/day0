import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { ActionCtx } from '../../convex/_generated/server';
import {
  openOwnedCredential,
  sealForOwner,
  type CredentialKeyring,
  type SealedCredential,
} from '../lib/credential-crypto';
import { log } from '../lib/logger';
import type { ActsAs, TokenStore } from './access-identity';
import { decryptCredential } from './credentials';
import type { IssuedTokens } from './mcp-oauth';
import { safeFailureMessage } from './redact';
import {
  awaitLeaseHolder,
  LEASE_CLAIMS,
  LIVE_TOKEN_POLLS_PER_CLAIM,
  RefreshInProgress,
  sleepFor,
} from './refresh-lease';

/*
 * The token store behind the access rungs (wave 11, 11-AT; the access plan, section 4.7; B15):
 * every rung asks it for a live access token and none of them ever reads a refresh token. Two
 * places keep tokens. The native store keeps them in `credentials` rows sealed for their owner,
 * refreshes them at read time and on a schedule, and writes a rotation only while the pair is at
 * the generation it read (11-AM's seam, moved here unchanged); a refresh presents the refresh token
 * only under the row's refresh lease (R-S, `./refresh-lease.ts`), so two refreshes never present
 * one token. Nango's free self-hosted edition
 * keeps the tokens of the API-rung providers Day0 has no native issuer for, and refreshes them
 * itself (gated on V-A4). A row's `tokenStore` says which.
 */

/** How many times a scheduled refresh that could not reach the server is tried again. */
export const SCHEDULED_REFRESH_RETRIES = 5;

/** How long a refresh that lost to a concurrent one waits, each time, for the winner's write. */
const ROTATION_WAIT_MS = 200;

/** How many times it waits. */
const ROTATION_WAITS = 3;

/** The credential an authorisation landed, as the native store is told to keep it. */
export interface LandTokens {
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
export interface HeldTokens {
  readonly credentialId: Id<'credentials'>;
  readonly ownerKey: string;
  /** Absent on the row reads as 0. */
  readonly generation: number;
  readonly expiresAt?: number;
  readonly issuedBy?: Doc<'credentials'>['issuedBy'];
  /** Whether a live refresh token is paired with it. */
  readonly refreshable: boolean;
  readonly connection: Doc<'organisationConnections'> | null;
  /** Where the token lives; absent reads as `native`, as on the row. */
  readonly tokenStore?: TokenStore;
  /** The end of the refresh lease another refresh holds on the row, when one does. */
  readonly refreshingUntil?: number;
}

/** A refresh's tokens, to be written only while the pair is still at `expectedGeneration`. */
export interface RotateTokens {
  readonly credentialId: Id<'credentials'>;
  readonly ownerKey: string;
  readonly expectedGeneration: number;
  readonly tokens: IssuedTokens;
  readonly now: number;
}

/** One access token's rows, as the native store reads them in one snapshot. */
export interface HeldTokenRows {
  readonly access: Doc<'credentials'>;
  readonly refresh: Doc<'credentials'> | null;
  readonly connection: Doc<'organisationConnections'> | null;
}

/** Which lease a refresh asks for: the access token's row at the generation it read. */
export interface RefreshTokenClaim {
  readonly credentialId: Id<'credentials'>;
  readonly expectedGeneration: number;
  readonly now: number;
}

/** What asking for the lease answers. */
export type ClaimedRefreshToken =
  | {
      readonly kind: 'claimed';
      /** The refresh token of the generation the claim read, to present once. */
      readonly presented: string;
      readonly leaseUntil: number;
    }
  | { readonly kind: 'moved' }
  | { readonly kind: 'leased'; readonly until: number }
  | { readonly kind: 'gone' };

/** What a rotation's write answers. */
export type RotationOutcome =
  | { readonly ok: true; readonly generation: number }
  | { readonly ok: false; readonly reason: 'stale' | 'gone' };

/**
 * Where the native store keeps an authorisation's tokens and reads them back: `credentials` rows,
 * the access token's carrying `generation`, `expiresAt` and the paired refresh token's id.
 */
export interface TokenKeeper {
  /** Land a new authorisation's tokens on the card, replacing what it held. */
  land(ctx: ActionCtx, landing: LandTokens): Promise<Id<'credentials'>>;
  /** The held pair's metadata, or null when the access token's row is gone. */
  read(ctx: ActionCtx, credentialId: Id<'credentials'>): Promise<HeldTokens | null>;
  /** The access token's value, recording its use; refused once it is revoked. */
  accessToken(ctx: ActionCtx, credentialId: Id<'credentials'>): Promise<string>;
  /**
   * Take the refresh lease on the access token's row and the paired refresh token's value, in one
   * transaction, while the pair is still at the generation the claim read and no other refresh
   * holds the lease: a refresh exchanges only the token of the generation it read, and only one
   * refresh presents it. Only the refresh itself calls it; no rung does.
   *
   * @returns `claimed` with the token and the lease's end; `moved` once a rotation moved the pair
   *   on; `leased` with the end of another refresh's lease; `gone` when the access token is revoked.
   * @throws Error when no live refresh token is paired with the access token.
   */
  claimRefreshToken(ctx: ActionCtx, claim: RefreshTokenClaim): Promise<ClaimedRefreshToken>;
  /** End the lease a claim took, unless a rotation or another holder already has. */
  releaseRefreshLease(
    ctx: ActionCtx,
    lease: { readonly credentialId: Id<'credentials'>; readonly leaseUntil: number },
  ): Promise<void>;
  /** Write a refresh's tokens atomically, refusing a stale generation. */
  rotate(ctx: ActionCtx, rotation: RotateTokens): Promise<RotationOutcome>;
}

/** The held metadata of one snapshot of an access token's rows. */
export function heldFromRows(credentialId: Id<'credentials'>, rows: HeldTokenRows): HeldTokens {
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
    tokenStore: access.tokenStore ?? 'native',
    ...(access.refreshingUntil === undefined ? {} : { refreshingUntil: access.refreshingUntil }),
  };
}

/**
 * The native keeper: `credentials` rows sealed for the employee's owner under the keyring the
 * hosting action reads (`credentialKeyring` in `convex/credentialCryptoActions.ts`), written by
 * `mcpOauth`'s internal mutations.
 */
export function nativeTokenKeeper(keyring: () => CredentialKeyring): TokenKeeper {
  const sealed = (value: string, ownerKey: string): SealedCredential =>
    sealForOwner(value, keyring(), ownerKey);
  return {
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
      return rows ? heldFromRows(credentialId, rows) : null;
    },
    accessToken: async (ctx, credentialId) => await decryptCredential(ctx, credentialId),
    claimRefreshToken: async (ctx, claim) => {
      const claimed = await ctx.runMutation(internal.refreshLease.claim, claim);
      switch (claimed.kind) {
        case 'claimed': {
          let presented: string;
          try {
            presented = openRefreshToken(claimed.refresh, keyring());
          } catch (error) {
            // Nothing was presented: the lease is ended here, or the next refresh waits it out.
            await releaseUnpresented(ctx, claim.credentialId, claimed.leaseUntil);
            throw error;
          }
          return { kind: 'claimed', leaseUntil: claimed.leaseUntil, presented };
        }
        case 'no-refresh-token':
          throw new Error('No live refresh token is held for this authorisation.');
        case 'moved':
        case 'leased':
        case 'gone':
          return claimed;
        default: {
          const unknown: never = claimed;
          throw new Error(`unhandled lease claim ${String(unknown)}`);
        }
      }
    },
    releaseRefreshLease: async (ctx, lease) => {
      await ctx.runMutation(internal.refreshLease.release, lease);
    },
    rotate: async (ctx, rotation) =>
      await ctx.runMutation(internal.mcpOauth.rotateTokens, {
        credentialId: rotation.credentialId,
        expectedGeneration: rotation.expectedGeneration,
        access: sealed(rotation.tokens.accessToken, rotation.ownerKey),
        ...(rotation.tokens.refreshToken
          ? { refresh: sealed(rotation.tokens.refreshToken, rotation.ownerKey) }
          : {}),
        ...(rotation.tokens.expiresAt === undefined
          ? {}
          : { expiresAt: rotation.tokens.expiresAt }),
        now: rotation.now,
      }),
  };
}

/**
 * End a lease whose refresh token was never presented. A release that fails is logged, so the
 * caller rethrows why the token could not be opened rather than the release's failure; the lease
 * lapses by itself at its end.
 */
async function releaseUnpresented(
  ctx: ActionCtx,
  credentialId: Id<'credentials'>,
  leaseUntil: number,
): Promise<void> {
  try {
    await ctx.runMutation(internal.refreshLease.release, { credentialId, leaseUntil });
  } catch (error) {
    log.warn('refresh lease not released after an unreadable refresh token; it lapses at its end', {
      credentialId,
      leaseUntil,
      reason: safeFailureMessage(error, '', 'no detail'),
    });
  }
}

/**
 * A refresh token's value, opened from the very snapshot the lease was claimed in: a second read
 * could return the token a concurrent rotation has just written into the same row.
 */
function openRefreshToken(refresh: Doc<'credentials'>, keyring: CredentialKeyring): string {
  if (refresh.ciphertext === undefined || refresh.iv === undefined) {
    throw new Error('No live refresh token is held for this authorisation.');
  }
  return openOwnedCredential(
    {
      ciphertext: refresh.ciphertext,
      iv: refresh.iv,
      userId: refresh.userId,
      ...(refresh.keyId === undefined ? {} : { keyId: refresh.keyId }),
    },
    keyring,
    { allowUnbound: false },
  );
}

/** The server refused to exchange the refresh token (not a transport failure). */
export class TokenRefreshRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRefreshRefused';
  }
}

/**
 * How an issuer words a refresh's failures, on the card and in its record. The store's own words
 * ({@link STORE_REFRESH_WORDS}) serve an issuer that names none.
 */
export interface RefreshWords {
  /** The safe, clipped reason a failed refresh carries, from what it threw. */
  reason(error: unknown): string;
  /** The refusal when the issuer refused the refresh token. */
  refused(message: string): string;
  /** The refusal when the credential was revoked while the refresh was being made. */
  readonly revokedMeanwhile: string;
  /** What a read throws for an expired token whose issuer could not be reached. */
  unreachableWhenExpired(reason: string): Error;
  /** What a read throws for an expired token whose refresh was refused. */
  refusedWhenExpired(refusal: string): Error;
  /** The refusal a scheduled refresh records once its retries ran out. */
  unreachableAfter(attempts: number, reason: string): string;
  /** The refusal a scheduled refresh records for a failure no retry would mend. */
  failed(reason: string): string;
}

/** The store's own words for a refresh's failures (the MCP client's, 11-AM). */
export const STORE_REFRESH_WORDS: RefreshWords = {
  reason: (error: unknown): string =>
    safeFailureMessage(error, '', 'The authorisation server could not be reached.'),
  refused: (message: string): string => `Refreshing the authorisation was refused: ${message}`,
  revokedMeanwhile: 'The authorisation was revoked while it was being refreshed.',
  unreachableWhenExpired: (reason: string): Error =>
    new Error(`The authorisation server could not be reached to refresh the token: ${reason}`),
  refusedWhenExpired: (refusal: string): Error => new Error(`${refusal} Authorise the card again.`),
  unreachableAfter: (attempts: number, reason: string): string =>
    `The authorisation server could not be reached to refresh the token after ${attempts} attempts: ${reason}`,
  failed: (reason: string): string => `Refreshing the authorisation failed: ${reason}`,
};

/** Why a read refuses a token past its expiry when no refresh token or refresher is held for it. */
const EXPIRED_UNRENEWABLE = 'The token has expired and nothing Day0 holds can renew it.';

/** An issuer's refresh, ready to exchange the refresh token once the store has read it. */
export interface PreparedRefresh {
  /**
   * Exchange the presented refresh token for new tokens at the issuer.
   *
   * @throws TokenRefreshRefused when the issuer refuses the token; any other error when it cannot
   *   be reached or answers unusably.
   */
  exchange(presented: string): Promise<IssuedTokens>;
  /**
   * Revoke at the issuer what a refresh was issued for a credential revoked meanwhile, so it does
   * not stay live at the vendor unrecorded. Best effort: a failure is the issuer's to log.
   */
  discard(presented: string, issued: IssuedTokens): Promise<void>;
}

/** What preparing a refresh answers: the exchange, or why this credential cannot be refreshed. */
export type RefreshPreparation =
  | { readonly ok: true; readonly refresh: PreparedRefresh }
  | { readonly ok: false; readonly refusal: string };

/**
 * One issuer's half of a native refresh: which held tokens are its, how close to expiry a read
 * refreshes them, and the exchange itself. The store owns the rest (when, the generation, the
 * rotation-safe write, the loser taking the winner's token). 11-AM's MCP client is one; 11-AL's
 * Linear issuer joins as another.
 */
export interface TokenRefresher {
  /** The issuer's name at the head of the store's log lines about its tokens (`mcp`). */
  readonly name: string;
  /** Whether a held token was issued by this refresher's issuer. */
  owns(issuedBy: NonNullable<Doc<'credentials'>['issuedBy']>): boolean;
  /** How close to its expiry a token read for use is refreshed first. */
  readonly readRefreshMarginMs: number;
  /**
   * Everything the exchange needs that is not the refresh token (the issuer's endpoints, the
   * client's authentication), read before the refresh token so the gap before it is sent is short.
   */
  prepare(ctx: ActionCtx, held: HeldTokens): Promise<RefreshPreparation>;
  /** Whether a failed refresh may succeed later (a transport failure, a busy server). */
  retryable(error: unknown): boolean;
  /** How the issuer words a refresh's failures; the store's own ({@link STORE_REFRESH_WORDS}) when absent. */
  readonly words?: RefreshWords;
  /**
   * The issuer's own rotation-safe write, for an issuer whose rows queue its own next scheduled
   * refresh (Linear's, 11-AL); the keeper's `rotate` when absent.
   */
  rotate?(ctx: ActionCtx, rotation: RotateTokens): Promise<RotationOutcome>;
}

/** The words a refresher's failures are given in. */
function wordsOf(refresher: TokenRefresher): RefreshWords {
  return refresher.words ?? STORE_REFRESH_WORDS;
}

/** What the native store depends on: its keeper, the issuers it refreshes for, the clock. */
export interface NativeTokenStoreDeps {
  readonly keeper: TokenKeeper;
  readonly refreshers: readonly TokenRefresher[];
  readonly now: () => number;
  /** How a refresh waiting for another's lease sleeps; the runtime's timer when absent. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** How a refresh treats another refresh's lease. */
export interface RefreshOptions {
  /**
   * The caller's stored token still lives: behind another refresh's lease the refresh waits only
   * {@link LIVE_TOKEN_LEASE_POLLS} reads in all, and after its last claim hands the stored
   * token back rather than waiting out a lease whose holder may have died.
   */
  readonly storedTokenLives?: boolean;
}

/** What a refresh answers. */
export type RefreshOutcome =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly refusal: string };

/** The refresher whose issuer issued a held token, when it is one the store can refresh. */
export function refresherFor(
  held: HeldTokens,
  refreshers: readonly TokenRefresher[],
): TokenRefresher | undefined {
  const issuedBy = held.issuedBy;
  if (
    !issuedBy ||
    !held.refreshable ||
    held.expiresAt === undefined ||
    held.connection === null ||
    (held.tokenStore ?? 'native') !== 'native'
  ) {
    return undefined;
  }
  return refreshers.find((refresher): boolean => refresher.owns(issuedBy));
}

/** The held pair after a concurrent refresh's write, or null when none lands while it waits. */
async function rotatedSince(
  ctx: ActionCtx,
  held: HeldTokens,
  keeper: TokenKeeper,
): Promise<HeldTokens | null> {
  for (let attempt = 0; ; attempt += 1) {
    const again = await keeper.read(ctx, held.credentialId);
    if (again && again.generation !== held.generation) return again;
    if (attempt === ROTATION_WAITS) return null;
    await new Promise((resolve) => setTimeout(resolve, ROTATION_WAIT_MS));
  }
}

/**
 * Refresh a held token with rotation, under the row's refresh lease: take the lease and the refresh
 * token of the generation read in one transaction, exchange it, and write the new pair only while
 * the pair is still at that generation. A refresh that finds the lease held waits for its holder
 * and takes the winner's token, so two refreshes never present one refresh token (R-S; the wave 11
 * review's m11); one that finds the pair moved on takes the winner's token at once. A refresh whose
 * spent token is refused after a rotation it did not see takes the winner's token; one whose
 * credential was revoked meanwhile has the issuer revoke what it was issued. The write is the
 * issuer's own where it has one ({@link TokenRefresher.rotate}), else the keeper's; refusals are
 * in the issuer's words.
 *
 * @param options - Whether the caller's stored token still lives, which bounds a wait on a lease.
 * @throws a transport error, or the issuer's own, when the server cannot be reached or answers
 *   unusably; {@link RefreshInProgress} when other refreshes held the lease throughout; a refusal
 *   of the refresh by the server is the typed outcome instead.
 */
export async function refreshHeld(
  ctx: ActionCtx,
  held: HeldTokens,
  refresher: TokenRefresher,
  deps: NativeTokenStoreDeps,
  options: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const { keeper } = deps;
  const preparation = await refresher.prepare(ctx, held);
  if (!preparation.ok) return { ok: false, refusal: preparation.refusal };
  for (let claims = 1; ; claims += 1) {
    // Claimed last, just before the token is sent, so the lease is held no longer than the exchange.
    const claim = await keeper.claimRefreshToken(ctx, {
      credentialId: held.credentialId,
      expectedGeneration: held.generation,
      now: deps.now(),
    });
    switch (claim.kind) {
      case 'claimed':
        return await exchangeUnderLease(ctx, held, refresher, preparation.refresh, claim, deps);
      case 'moved':
        return { ok: true, accessToken: await keeper.accessToken(ctx, held.credentialId) };
      case 'gone':
        return { ok: false, refusal: wordsOf(refresher).revokedMeanwhile };
      case 'leased': {
        const waited = await awaitLeaseHolder(
          {
            read: async () => await keeper.read(ctx, held.credentialId),
            now: deps.now,
            sleep: deps.sleep ?? sleepFor,
          },
          { generation: held.generation, until: claim.until },
          options.storedTokenLives === true ? LIVE_TOKEN_POLLS_PER_CLAIM : undefined,
        );
        if (waited === 'moved') {
          return { ok: true, accessToken: await keeper.accessToken(ctx, held.credentialId) };
        }
        if (claims === LEASE_CLAIMS) {
          // The stored token's life is read again after the wait: one that died meanwhile is
          // never handed back (the round review's m8).
          if (options.storedTokenLives !== true || (held.expiresAt ?? 0) <= deps.now()) {
            throw new RefreshInProgress();
          }
          return { ok: true, accessToken: await keeper.accessToken(ctx, held.credentialId) };
        }
        break;
      }
      default: {
        const unknown: never = claim;
        throw new Error(`unhandled lease claim ${String(unknown)}`);
      }
    }
  }
}

/**
 * The exchange and the rotation-safe write a refresh makes once it holds the lease, the lease
 * ended afterwards whatever came of them (a successful rotation has cleared it already).
 */
async function exchangeUnderLease(
  ctx: ActionCtx,
  held: HeldTokens,
  refresher: TokenRefresher,
  refresh: PreparedRefresh,
  lease: Extract<ClaimedRefreshToken, { kind: 'claimed' }>,
  deps: NativeTokenStoreDeps,
): Promise<RefreshOutcome> {
  try {
    return await exchangeAndRotate(ctx, held, refresher, refresh, lease.presented, deps);
  } finally {
    await releaseLease(ctx, deps.keeper, refresher, {
      credentialId: held.credentialId,
      leaseUntil: lease.leaseUntil,
    });
  }
}

/** End a lease; a release that fails is logged, since the lease lapses by itself at its end. */
async function releaseLease(
  ctx: ActionCtx,
  keeper: TokenKeeper,
  refresher: TokenRefresher,
  lease: { readonly credentialId: Id<'credentials'>; readonly leaseUntil: number },
): Promise<void> {
  try {
    await keeper.releaseRefreshLease(ctx, lease);
  } catch (error) {
    log.warn(`${refresher.name} refresh lease not released; it lapses at its end`, {
      credentialId: lease.credentialId,
      leaseUntil: lease.leaseUntil,
      reason: safeFailureMessage(error, '', 'no detail'),
    });
  }
}

/** Exchange the presented refresh token and write the new pair at the generation read. */
async function exchangeAndRotate(
  ctx: ActionCtx,
  held: HeldTokens,
  refresher: TokenRefresher,
  refresh: PreparedRefresh,
  presented: string,
  deps: NativeTokenStoreDeps,
): Promise<RefreshOutcome> {
  const { keeper } = deps;
  let issued: IssuedTokens;
  try {
    issued = await refresh.exchange(presented);
  } catch (error) {
    if (!(error instanceof TokenRefreshRefused)) throw error;
    if (await rotatedSince(ctx, held, keeper)) {
      return { ok: true, accessToken: await keeper.accessToken(ctx, held.credentialId) };
    }
    return { ok: false, refusal: wordsOf(refresher).refused(error.message) };
  }
  const written: RotateTokens = {
    credentialId: held.credentialId,
    ownerKey: held.ownerKey,
    expectedGeneration: held.generation,
    tokens: issued,
    now: deps.now(),
  };
  const rotation = refresher.rotate
    ? await refresher.rotate(ctx, written)
    : await keeper.rotate(ctx, written);
  if (rotation.ok) return { ok: true, accessToken: issued.accessToken };
  if (rotation.reason === 'stale') {
    // The winner's pair shares this grant: revoking the loser's sibling token could end the whole
    // grant at a server that revokes by family (RFC 7009 section 2.1), so it is left to lapse.
    return { ok: true, accessToken: await keeper.accessToken(ctx, held.credentialId) };
  }
  await refresh.discard(presented, issued);
  return { ok: false, refusal: wordsOf(refresher).revokedMeanwhile };
}

/**
 * The native store's live access token for a credential: its stored value, refreshed first when
 * it is a token an issuer refreshes and it is within that issuer's margin of its expiry. A refresh
 * that fails while the stored token still lives hands that token back; any other credential is
 * read exactly as `credentials.decrypt` reads it, save a token past its expiry, which is refused.
 *
 * @param held - The credential's held metadata, read by the caller; null when no row answers.
 * @throws Error when the credential is unavailable, or an expired token could not be refreshed
 *   or has nothing to refresh it with (the manager authorises again).
 */
export async function nativeAccessToken(
  ctx: ActionCtx,
  credentialId: Id<'credentials'>,
  held: HeldTokens | null,
  deps: NativeTokenStoreDeps,
): Promise<string> {
  const refresher = held ? refresherFor(held, deps.refreshers) : undefined;
  if (held && !refresher && held.expiresAt !== undefined && held.expiresAt <= deps.now()) {
    // A dead token sent on reads as the vendor's refusal of the card; say why it is dead instead
    // (the wave 11 review's m12).
    throw STORE_REFRESH_WORDS.refusedWhenExpired(EXPIRED_UNRENEWABLE);
  }
  if (!held || !refresher || (held.expiresAt ?? 0) - deps.now() > refresher.readRefreshMarginMs) {
    return await deps.keeper.accessToken(ctx, credentialId);
  }
  // Read again after the refresh, which may wait on a lease or an exchange for longer than the
  // stored token has left: a token that died meanwhile is never sent (the round review's m8).
  const alive = (): boolean => (held.expiresAt ?? 0) > deps.now();
  const words = wordsOf(refresher);
  let outcome: RefreshOutcome;
  try {
    outcome = await refreshHeld(ctx, held, refresher, deps, { storedTokenLives: alive() });
  } catch (error) {
    const reason = words.reason(error);
    if (!alive()) throw words.unreachableWhenExpired(reason);
    log.warn(`${refresher.name} read-time refresh failed; the stored token still lives`, {
      credentialId,
      reason,
    });
    return await deps.keeper.accessToken(ctx, credentialId);
  }
  if (outcome.ok) return outcome.accessToken;
  if (alive()) {
    log.warn(`${refresher.name} read-time refresh refused; the stored token still lives`, {
      credentialId,
      reason: outcome.refusal,
    });
    return await deps.keeper.accessToken(ctx, credentialId);
  }
  throw words.refusedWhenExpired(outcome.refusal);
}

/**
 * One place Day0 keeps tokens (B15). Asked only for a live access token: no rung, and nothing
 * outside a native refresh, ever reads a refresh token.
 */
export interface TokenStoreBackend {
  readonly kind: TokenStore;
  /**
   * A live access token for a credential this backend keeps, refreshed first when due.
   *
   * @throws Error when the credential is unavailable or its refresh was refused.
   */
  accessTokenFor(ctx: ActionCtx, credentialId: Id<'credentials'>): Promise<string>;
}

/** The token store: every backend, and the keeper whose read says which one holds a credential. */
export interface TokenStoreDeps extends NativeTokenStoreDeps {
  /** The backends other than the native one, by the `tokenStore` a row names. */
  readonly backends: readonly TokenStoreBackend[];
}

/**
 * The live access token for a credential, from whichever store keeps it: the native store for a
 * row with no `tokenStore` or `native`, the named backend otherwise. The rungs' one read of a
 * bearer (the adapters' decrypt, the re-read, the probe and intake).
 *
 * @throws Error when the credential is unavailable, its store is not configured, or its refresh
 *   was refused once the token expired.
 */
export async function accessTokenFor(
  ctx: ActionCtx,
  credentialId: Id<'credentials'>,
  deps: TokenStoreDeps,
): Promise<string> {
  const held = await deps.keeper.read(ctx, credentialId);
  const kind = held?.tokenStore ?? 'native';
  if (!held || kind === 'native') {
    return await nativeAccessToken(ctx, credentialId, held, deps);
  }
  const backend = deps.backends.find((candidate): boolean => candidate.kind === kind);
  if (!backend) {
    throw new Error(`The ${kind} token store is not configured on this deployment.`);
  }
  return await backend.accessTokenFor(ctx, credentialId);
}

/** What a scheduled refresh does beyond the store: queue its retry and record its refusal. */
export interface ScheduledRefreshDeps extends NativeTokenStoreDeps {
  /** Run the scheduled refresh again after `delayMs`, as attempt `attempt`. */
  retryAfter(delayMs: number, attempt: number): Promise<void>;
  /** Record a refresh that was refused or could not be made, on every card holding the token. */
  recordRefusal(reason: string): Promise<void>;
}

/** Which scheduled refresh to run: the token, the generation it was queued for, its attempt. */
export interface ScheduledRefresh {
  readonly credentialId: Id<'credentials'>;
  readonly generation: number;
  readonly attempt?: number;
}

/**
 * Refresh a token ahead of its expiry, so every reader of the stored token finds a live one. Does
 * nothing when another refresh has moved the pair on. A server that cannot be reached is tried
 * again with a growing wait, {@link SCHEDULED_REFRESH_RETRIES} times; a refusal, or the retries
 * running out, is recorded.
 */
export async function runScheduledRefresh(
  ctx: ActionCtx,
  scheduled: ScheduledRefresh,
  deps: ScheduledRefreshDeps,
): Promise<void> {
  const held = await deps.keeper.read(ctx, scheduled.credentialId);
  const refresher = held ? refresherFor(held, deps.refreshers) : undefined;
  if (!held || held.generation !== scheduled.generation || !refresher) return;
  const attempt = scheduled.attempt ?? 0;
  let refusal: string;
  try {
    const outcome = await refreshHeld(ctx, held, refresher, deps);
    if (outcome.ok) return;
    refusal = outcome.refusal;
  } catch (error) {
    const words = wordsOf(refresher);
    const reason = words.reason(error);
    // Another refresh holding the lease throughout is no refusal: its own rotation queues the next.
    const retryable = error instanceof RefreshInProgress || refresher.retryable(error);
    if (retryable && attempt < SCHEDULED_REFRESH_RETRIES) {
      log.warn(`${refresher.name} scheduled refresh failed`, {
        credentialId: scheduled.credentialId,
        attempt,
        reason,
      });
      await deps.retryAfter(60_000 * 2 ** attempt, attempt + 1);
      return;
    }
    refusal = retryable ? words.unreachableAfter(attempt + 1, reason) : words.failed(reason);
  }
  await deps.recordRefusal(refusal);
}

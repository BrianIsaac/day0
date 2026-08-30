import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The `state` parameter carried through an OAuth install and back.
 *
 * The redirect handler is the one route reachable from off this machine without
 * the no-auth key, so it cannot lean on a session to say who the caller is. The
 * state is what it authenticates instead, and it has to survive being written on
 * a URL by a third party: it is signed, so a value this deployment did not mint
 * is refused before any lookup; it expires, so a link left in a browser history
 * stops working; and it carries a nonce the surface stores, so the first use
 * consumes it and a replay finds nothing to claim.
 *
 * The signing key is derived from `DAY0_CREDENTIAL_KEY` rather than configured
 * separately: one secret to install, and a distinct derived key per purpose so a
 * state signature can never be confused with credential ciphertext.
 */

/** How long an install link stays valid. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1_000;

const VERSION = 'v1';
const NONCE_BYTES = 32;
const DERIVATION_LABEL = 'day0-oauth-state-v1';

export type OauthStateFailure = 'malformed' | 'signature' | 'expired';

export interface OauthStateClaim {
  expiresAt: number;
  nonce: string;
  surfaceId: string;
}

export type OauthStateResult =
  | ({ ok: true } & OauthStateClaim)
  | { ok: false; reason: OauthStateFailure };

/**
 * Derive the state-signing key from the deployment's credential key.
 *
 * Args:
 *   credentialKey: The configured `DAY0_CREDENTIAL_KEY`.
 *
 * Returns:
 *   A 32-byte key used only for state signatures.
 *
 * Raises:
 *   Error: If no credential key is configured.
 */
function signingKey(credentialKey: string | undefined): Buffer {
  if (!credentialKey) {
    throw new Error('DAY0_CREDENTIAL_KEY is not set, so an install link cannot be signed.');
  }
  return createHmac('sha256', credentialKey).update(DERIVATION_LABEL).digest();
}

/** A fresh single-use nonce for one install link. */
export function newOauthNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url');
}

function payloadOf(claim: OauthStateClaim): string {
  return [VERSION, claim.surfaceId, claim.nonce, String(claim.expiresAt)].join('.');
}

/**
 * Sign one install link's state.
 *
 * Args:
 *   claim: The surface the link belongs to, its nonce and its expiry.
 *   credentialKey: The configured `DAY0_CREDENTIAL_KEY`.
 *
 * Returns:
 *   The opaque state value to put on the authorize URL.
 */
export function signOauthState(claim: OauthStateClaim, credentialKey: string | undefined): string {
  const payload = payloadOf(claim);
  const signature = createHmac('sha256', signingKey(credentialKey)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Verify a state value returned by the provider.
 *
 * Args:
 *   state: The `state` query parameter as received.
 *   credentialKey: The configured `DAY0_CREDENTIAL_KEY`.
 *   now: Current epoch milliseconds.
 *
 * Returns:
 *   The claim when the signature holds and the link has not expired, else the
 *   reason it was refused. The reason never distinguishes an unknown surface
 *   from a bad signature, because both are simply "not minted here".
 */
export function verifyOauthState(
  state: string | undefined | null,
  credentialKey: string | undefined,
  now: number,
): OauthStateResult {
  if (typeof state !== 'string' || state === '') return { ok: false, reason: 'malformed' };
  const parts = state.split('.');
  if (parts.length !== 5) return { ok: false, reason: 'malformed' };
  const [version, surfaceId, nonce, expiry, signature] = parts;
  if (version !== VERSION || !surfaceId || !nonce || !signature) {
    return { ok: false, reason: 'malformed' };
  }
  const expiresAt = Number(expiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return { ok: false, reason: 'malformed' };

  const expected = createHmac('sha256', signingKey(credentialKey))
    .update(payloadOf({ expiresAt, nonce, surfaceId }))
    .digest('base64url');
  const offered = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (offered.length !== wanted.length || !timingSafeEqual(offered, wanted)) {
    return { ok: false, reason: 'signature' };
  }
  if (expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true, expiresAt, nonce, surfaceId };
}

/** What the card and the redirect page say about each refusal. */
export const OAUTH_STATE_MESSAGES: Readonly<Record<OauthStateFailure, string>> = {
  malformed: 'That install link is not one this deployment issued.',
  signature: 'That install link is not one this deployment issued.',
  expired: 'That install link has expired. Provision the app again to get a fresh one.',
};

import { oauthTokenRevocation, readOAuthRevocationAnswer } from './oauth';
import type { RevocationAnswer, RevocationRequest, TokenTypeHint } from './types';

/*
 * Linear's revoker (the wave 11 file, section 8, L3): `POST https://api.linear.app/oauth/revoke`
 * with `token` and an optional `token_type_hint`. Whether revoking an access token also ends its
 * refresh token is not documented, so each is revoked by its own call. On real Linear the first
 * revoke of a pair ends the whole grant, and the second is answered "Token has already been
 * revoked." (the real-vendor walk, 3 October 2026, R41V-8), which is read as already gone, as is
 * "Token not found" for a token Linear does not know (the re-walk, R41X-1). A
 * client-credentials app-actor token is revoked the same way with no client authentication (the
 * walk, R41V-1), but only by its connection's own revoke (`convex/organisationSecrets.ts`): one
 * employee's end never sends it, since the app's other employees share it (L2; `plan.ts`).
 */

/** Linear's one revoke address. */
export const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';

/**
 * Revoke one Linear OAuth token.
 *
 * @param token - The access or refresh token.
 * @param hint - Which of the pair it is.
 */
export function linearTokenRevocation(token: string, hint: TokenTypeHint): RevocationRequest {
  return oauthTokenRevocation({ endpoint: LINEAR_REVOKE_URL, token, hint });
}

/**
 * Linear's words for a token there is nothing left to revoke for, which it sends as the error where
 * RFC 7009 says 200: one whose grant has already ended (`{"error":"Token has already been
 * revoked."}`, R41V-8), and one it does not know (`401 {"error":"Token not found"}`, the re-walk,
 * R41X-1).
 */
const NOTHING_TO_REVOKE: readonly RegExp[] = [/\balready been revoked\b/i, /^Token not found\.?$/i];

/** Whether a refusal's body says, in Linear's own words, that nothing is left to revoke. */
function saysNothingToRevoke(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { error, error_description: description } = body as Record<string, unknown>;
  return [error, description].some(
    (words: unknown): boolean =>
      typeof words === 'string' && NOTHING_TO_REVOKE.some((pattern) => pattern.test(words)),
  );
}

/**
 * Read Linear's answer by the revocation rules (RFC 7009), naming Linear in the words; a token
 * Linear says was already revoked, or does not know, is gone, as RFC 7009 has a server answer an
 * invalid token.
 *
 * @param status - The HTTP status.
 * @param body - The parsed JSON body, or the raw text when it was not JSON.
 */
export function readLinearAnswer(status: number, body: unknown): RevocationAnswer {
  if (status >= 400 && status < 500 && status !== 429 && saysNothingToRevoke(body)) {
    return { kind: 'gone' };
  }
  return readOAuthRevocationAnswer('Linear', status, body);
}

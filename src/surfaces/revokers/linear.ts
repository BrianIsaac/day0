import { oauthTokenRevocation, readOAuthRevocationAnswer } from './oauth';
import type { RevocationAnswer, RevocationRequest, TokenTypeHint } from './types';

/*
 * Linear's revoker (the wave 11 file, section 8, L3): `POST https://api.linear.app/oauth/revoke`
 * with `token` and an optional `token_type_hint`. Whether revoking an access token also ends its
 * refresh token is not documented, so each is revoked by its own call. A client-credentials
 * app-actor token has no documented revocation and is never sent here (L2; `plan.ts`).
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
 * Read Linear's answer by the revocation rules (RFC 7009), naming Linear in the words.
 *
 * @param status - The HTTP status.
 * @param body - The parsed JSON body, or the raw text when it was not JSON.
 */
export function readLinearAnswer(status: number, body: unknown): RevocationAnswer {
  return readOAuthRevocationAnswer('Linear', status, body);
}

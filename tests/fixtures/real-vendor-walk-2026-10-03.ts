/**
 * The answers real Linear (workspace `day00`) and real Slack (workspace `day0`) gave the
 * real-vendor walk of v0.14.0, 3 October 2026 (round 0141, unit R-V), word for word as its
 * handover quotes them. Where the walk quotes the vendor's words but not the HTTP status or the
 * field that carried them, the entry says what it inferred and from which of Day0's lines, and
 * the tests read every shape the quote allows.
 */

/** An HTTP answer as a fake network gives it: the status and the parsed JSON body. */
export interface WalkAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Linear `POST /oauth/revoke` for a token whose grant an earlier revoke ended (R41V-8: the second
 * revoke of a per-employee pair, the first having ended the whole grant). The walk quotes Day0's
 * record: "Linear refused: Token has already been revoked.", which `readOAuthRevocationAnswer`
 * builds as `${vendor} refused: ${error}${description}`, so the words are the body's `error` and
 * no `error_description` came with them. The status is a 4xx other than 429 (the reader took it
 * for a refusal, not a retry); 400 is inferred.
 */
export const LINEAR_REVOKE_ALREADY_REVOKED: WalkAnswer = {
  status: 400,
  body: { error: 'Token has already been revoked.' },
};

/**
 * Linear `POST /oauth/revoke` with `{token}` and no client authentication, for a client-credentials
 * app-actor token (R41V-1): `{"success":true}`, the token then answering 401 at Linear.
 */
export const LINEAR_REVOKE_SUCCESS: WalkAnswer = { status: 200, body: { success: true } };

/**
 * Linear's token endpoint refusing a refresh token after a Linear administrator revoked the app's
 * access in Linear's settings (R41V-9). The walk quotes Day0's record: "Renewing the Linear token
 * failed: Linear answered with something Day0 cannot read: Refresh token revoked.", which
 * `readTokenResponse` builds as `${lead}: ${description ?? error}.` with the `malformed` lead. So
 * the words "Refresh token revoked" came as the `error_description` or as the `error` (never as
 * `invalid_grant`, which reads as `token-refused`), under a status that is neither 401, 429 nor a
 * server failure. Both shapes the quote allows, under the 400 inferred.
 */
export const LINEAR_REFRESH_TOKEN_REVOKED: readonly WalkAnswer[] = [
  { status: 400, body: { error: 'Refresh token revoked' } },
  { status: 400, body: { error: 'Error', error_description: 'Refresh token revoked' } },
];

/**
 * The MCP client's text for a call with an access token Linear revoked (R41V-9), as the walk saw
 * it after "Skipped: intake failed: " on the card: the raw client error, which a card never shows.
 */
export const LINEAR_MCP_REVOKED_TOKEN_ERROR =
  'Failed to connect to MCP server surface: Error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Invalid access token"}';

/**
 * Linear's GraphQL refusal of a ticket delegated or assigned to an app user whose live token lacks
 * `app:assignable` (decision 5), as the walk quotes it (`INPUT_ERROR`, 400 in-band).
 */
export const LINEAR_APP_USER_LACKS_CAPABILITY = {
  message: 'App user not valid',
  userPresentableMessage: 'One or more app users lack the required capability.',
} as const;

/** Slack `auth.revoke` of a live configuration access token (R41V-10): `{"ok":true,"revoked":true}`. */
export const SLACK_CONFIGURATION_REVOKED: WalkAnswer = {
  status: 200,
  body: { ok: true, revoked: true },
};

/**
 * Slack `auth.revoke` of a configuration access token Slack already revoked at a rotation
 * (R41V-10): `{"ok":false,"error":"token_revoked"}`.
 */
export const SLACK_CONFIGURATION_ALREADY_REVOKED: WalkAnswer = {
  status: 200,
  body: { ok: false, error: 'token_revoked' },
};

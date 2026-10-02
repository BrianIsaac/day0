/**
 * The vendors' answers to a revocation, as their reference pages document them (read 1 October
 * 2026; the wave 11 file, section 8, S1, S4, L3). No call was made to a live revocation endpoint:
 * these are the documented shapes, kept here so the revokers' readers are tested against what the
 * vendor says it sends rather than against what the reader expects.
 */

/** Slack `auth.revoke` on a token it revoked: `{"ok": true, "revoked": true}`. */
export const SLACK_AUTH_REVOKE_OK = { ok: true, revoked: true } as const;

/** Slack `auth.revoke` with `test` set, which checks and revokes nothing. */
export const SLACK_AUTH_REVOKE_TEST = { ok: true, revoked: false } as const;

/** Slack's answer for a token that no longer authenticates: already revoked, or never valid. */
export const SLACK_INVALID_AUTH = { ok: false, error: 'invalid_auth' } as const;

/** Slack's answer for a token revoked before this call. */
export const SLACK_TOKEN_REVOKED = { ok: false, error: 'token_revoked' } as const;

/** Slack's answer while the method is rate limited (HTTP 429 with `Retry-After`). */
export const SLACK_RATELIMITED = { ok: false, error: 'ratelimited' } as const;

/** Slack's answer when its own service failed the call. */
export const SLACK_INTERNAL_ERROR = { ok: false, error: 'internal_error' } as const;

/** Slack `apps.manifest.delete` on an app it deleted: `{"ok": true}`. */
export const SLACK_MANIFEST_DELETE_OK = { ok: true } as const;

/** Slack `apps.manifest.delete` for an app id it does not know, or one already deleted. */
export const SLACK_INVALID_APP_ID = { ok: false, error: 'invalid_app_id' } as const;

/**
 * Slack `apps.manifest.delete` with a manager app's token on an app it did not create (S4: "can
 * only delete apps that were created by that manager app").
 */
export const SLACK_NOT_ALLOWED_TOKEN_TYPE = { ok: false, error: 'not_allowed_token_type' } as const;

/** Slack `apps.uninstall` on an installation it removed: `{"ok": true}`. */
export const SLACK_UNINSTALL_OK = { ok: true } as const;

/** Slack `apps.uninstall` with a client secret that does not match the client id. */
export const SLACK_INVALID_CLIENT_SECRET = { ok: false, error: 'bad_client_secret' } as const;

/**
 * An OAuth 2.0 token revocation endpoint's error body (RFC 7009, section 2.2.1): the server does
 * not revoke this type of token.
 */
export const OAUTH_UNSUPPORTED_TOKEN_TYPE = {
  error: 'unsupported_token_type',
  error_description: 'Only access and refresh tokens are revoked here.',
} as const;

/** An OAuth 2.0 error body for a client the server does not authenticate (RFC 6749, 5.2). */
export const OAUTH_INVALID_CLIENT = {
  error: 'invalid_client',
  error_description: 'Client authentication failed.',
} as const;

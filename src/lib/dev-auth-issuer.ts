/**
 * The local no-auth issuer, as both halves know it: the deployment declares
 * it as a JWT provider (`convex/devAuth.ts`) and the Next.js server mints
 * tokens under it (`src/lib/dev-auth-token.ts`). Values only; nothing here
 * reads the environment.
 */

/** The single subject the whole per-user data model hangs off in no-auth mode. */
export const DEV_NO_AUTH_SUBJECT = 'dev-no-auth|local-boss';

/** Names the local issuer. Never resolved over the network by either half. */
export const DEV_NO_AUTH_ISSUER = 'https://dev-no-auth.day0.local';

/** Checked against the token's `aud` claim by the deployment. */
export const DEV_NO_AUTH_AUDIENCE = 'day0-dev-no-auth';

/** The `kid` the local key is published and looked up under. */
export const DEV_NO_AUTH_KEY_ID = 'day0-dev-no-auth';

/**
 * The claim a local token carries its browser's session id in, so the one
 * subject every browser shares can still be told apart per browser. `sid` is
 * the name OIDC session management gives the same fact, so the owner's ledger
 * reads one claim whichever issuer signed the caller in.
 */
export const DEV_NO_AUTH_SESSION_CLAIM = 'sid';

/** The signing algorithm: ECDSA on P-256, the curve the generated keypair uses. */
export const DEV_NO_AUTH_ALGORITHM = 'ES256';

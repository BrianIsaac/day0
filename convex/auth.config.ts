/**
 * Convex auth bridge to Clerk.
 *
 * To wire up:
 *   1. In your Clerk dashboard, create a JWT template named "convex".
 *   2. Copy the Issuer URL ("Issuer" field on the JWT template page).
 *   3. Set CLERK_JWT_ISSUER_DOMAIN in `.env.local` to that URL (no trailing slash).
 *   4. Run `./scripts/sync-convex-env.sh` so the deployment sees it too.
 *
 * After that, `ctx.auth.getUserIdentity()` returns the signed-in Clerk user.
 *
 * In no-auth dev mode Clerk is replaced rather than removed: the deployment
 * accepts tokens signed by a keypair generated on the operator's machine, whose
 * public half arrives as `DEV_NO_AUTH_JWKS`. See `convex/devAuth.ts`. This file
 * is evaluated against the *deployment's* env vars when functions are pushed, so
 * set both on the deployment before pushing — `./scripts/sync-convex-env.sh`
 * does that in the right order.
 */

import { devNoAuthProvider, devNoAuthRequested } from './devAuth';

/**
 * `process.env` inside an auth config throws `AuthConfigMissingEnvironmentVariable`
 * for names the deployment has no value for, which would refuse the push for
 * anyone who has never set the optional names below.
 */
function readEnv(name: string): string | undefined {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
}

const authConfig = {
  providers: devNoAuthRequested()
    ? [devNoAuthProvider()]
    : [
        {
          domain: readEnv('CLERK_JWT_ISSUER_DOMAIN') ?? 'https://example.clerk.accounts.dev',
          applicationID: 'convex',
        },
      ],
};

export default authConfig;

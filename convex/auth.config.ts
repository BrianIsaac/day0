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
 * In no-auth dev mode there is no provider at all: `convex/devAuth.ts` mints the
 * caller identity itself, so declaring a Clerk issuer the deployment can never
 * reach would be a lie. This file is evaluated against the *deployment's* env
 * vars when functions are pushed, so set the flag on the deployment before
 * pushing.
 */

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

const noAuth = readEnv('NEXT_PUBLIC_DEV_NO_AUTH') === 'true';

const authConfig = {
  providers: noAuth
    ? []
    : [
        {
          domain: readEnv('CLERK_JWT_ISSUER_DOMAIN') ?? 'https://example.clerk.accounts.dev',
          applicationID: 'convex',
        },
      ],
};

export default authConfig;

/**
 * The identity providers this deployment accepts tokens from.
 *
 * - The local issuer (`NEXT_PUBLIC_DEV_NO_AUTH=true`): tokens signed with the
 *   key `pnpm dev:no-auth-key` generated on the operator's machine, whose
 *   public half arrives as `DEV_NO_AUTH_JWKS`. See `convex/devAuth.ts`.
 * - The customer's OIDC issuer (`DAY0_OIDC_ISSUER` and `DAY0_OIDC_AUDIENCE`),
 *   the customer-local profile's sign-in (A7). It sits beside the local issuer
 *   rather than replacing it, so a deployment in real mode takes both.
 * - Clerk (`CLERK_JWT_ISSUER_DOMAIN`, the Issuer URL of a Clerk JWT template
 *   named "convex"), the hosted demo's sign-in, declared only when neither of
 *   the other two is configured (Q16).
 *
 * This file is evaluated against the *deployment's* env when functions are
 * pushed, so the values must be on the deployment before the push;
 * `./scripts/sync-convex-env.sh` puts them there. With none configured the
 * push is refused: a placeholder issuer would bring a deployment up on which
 * nobody can sign in, for a reason nothing reports.
 */

import type { AuthConfig } from 'convex/server';
import { customerOidcIssuer } from '../src/lib/customer-oidc';
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

/** The local and customer issuers, else Clerk; throws when none is configured. */
function identityProviders(): AuthConfig['providers'] {
  const customer = customerOidcIssuer(readEnv);
  const providers: AuthConfig['providers'] = [
    ...(devNoAuthRequested() ? [devNoAuthProvider()] : []),
    ...(customer ? [{ domain: customer.issuer, applicationID: customer.audience }] : []),
  ];
  if (providers.length > 0) return providers;

  const clerk = readEnv('CLERK_JWT_ISSUER_DOMAIN')?.trim();
  if (!clerk) {
    throw new Error(
      'This deployment has no identity provider configured, so nobody could sign in. Set one ' +
        'on the deployment, then push again: NEXT_PUBLIC_DEV_NO_AUTH=true with DEV_NO_AUTH_JWKS ' +
        '(local, `pnpm dev:no-auth-key`), DAY0_OIDC_ISSUER with DAY0_OIDC_AUDIENCE (customer-local), ' +
        'or CLERK_JWT_ISSUER_DOMAIN (the hosted demo). ./scripts/sync-convex-env.sh pushes them.',
    );
  }
  return [{ domain: clerk, applicationID: 'convex' }];
}

const authConfig = { providers: identityProviders() } satisfies AuthConfig;

export default authConfig;

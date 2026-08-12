import type { UserIdentity } from 'convex/server';

/**
 * No-auth development mode — the Convex half.
 *
 * When it is on, every caller resolves to one fixed synthetic identity instead
 * of a Clerk one. Nothing downstream changes: `assertOwnsAgent` and friends
 * still compare `agent.userId` against `identity.subject`, rows are still
 * stamped with a `userId`, and the per-user data model is untouched. There is
 * simply only ever one user.
 *
 * Two properties hold it shut on a deployment that matters:
 *
 *   1. It must be asked for explicitly. `NEXT_PUBLIC_DEV_NO_AUTH` must be set on
 *      this deployment (`npx convex env set …`) and equal the exact string
 *      `true`. Deployment env vars are per-deployment, so the flag never travels
 *      with a `convex deploy`.
 *   2. It only works against a backend on loopback — i.e. the self-hosted
 *      backend from `docker-compose.yml`. Convex hands functions the
 *      deployment's own origin as `CONVEX_CLOUD_URL`; anything that is not
 *      127.0.0.1/localhost throws instead of minting, so setting the flag on a
 *      cloud deployment fails loudly and closed rather than opening it up.
 */

const FLAG = 'NEXT_PUBLIC_DEV_NO_AUTH';

/** The single subject the whole per-user data model hangs off in no-auth mode. */
export const DEV_NO_AUTH_SUBJECT = 'dev-no-auth|local-boss';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The synthetic identity, or `null` when no-auth mode is off. Throws when the
 * flag is set on a deployment that is not local.
 */
export function devNoAuthIdentity(): UserIdentity | null {
  if (process.env.NEXT_PUBLIC_DEV_NO_AUTH !== 'true') return null;

  const deploymentUrl = process.env.CONVEX_CLOUD_URL;
  if (!isLoopback(deploymentUrl)) {
    throw new Error(
      `${FLAG}=true disables authentication and is only allowed on a local ` +
        'self-hosted backend, but this deployment is ' +
        `${deploymentUrl ?? 'not reporting a loopback URL'}. Run ` +
        `\`npx convex env remove ${FLAG}\` against it.`,
    );
  }

  return {
    tokenIdentifier: `day0-dev-no-auth|${DEV_NO_AUTH_SUBJECT}`,
    subject: DEV_NO_AUTH_SUBJECT,
    issuer: 'https://dev-no-auth.day0.local',
    name: 'Local boss',
    email: process.env.NEXT_PUBLIC_DEMO_BOSS_EMAIL ?? 'boss@day0.local',
    emailVerified: true,
  };
}

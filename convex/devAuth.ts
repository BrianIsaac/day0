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
 * Because that one subject owns everything, minting it for a caller who is not
 * sitting at this machine hands them every agent, every charter and
 * `reset.deleteMyData`. So the guard has to establish that the backend is
 * unreachable from anywhere else, and three properties are asked for together:
 *
 *   1. It must be asked for explicitly. `NEXT_PUBLIC_DEV_NO_AUTH` must be set on
 *      this deployment (`npx convex env set …`) and equal the exact string
 *      `true`. Deployment env vars are per-deployment, so the flag never travels
 *      with a `convex deploy`.
 *   2. The published bind address must be declared, and must be loopback.
 *      `CONVEX_BIND_ADDR` is the single value `docker-compose.yml` interpolates
 *      into every `ports:` entry, so it is the address the backend's sockets are
 *      actually published on rather than a guess about them. Opening the backend
 *      to the LAN means changing that one variable, which closes this guard in
 *      the same edit. An undeclared binding is refused too - the guard never
 *      assumes loopback on the operator's behalf.
 *   3. Nothing may contradict it. The deployment's own origins must be loopback
 *      and the environment must carry no hosted-platform markers, so a flag that
 *      reaches a cloud deployment fails loudly rather than opening it up.
 *
 * A Convex isolate cannot observe the socket it is served over or the peer
 * address of its caller, so (2) is the strongest available statement about
 * reachability: it is a declaration, but by the file that decides the binding.
 * The Next.js half enforces its own boundary directly - see `proxy.ts`.
 */

const FLAG = 'NEXT_PUBLIC_DEV_NO_AUTH';
const BIND_FLAG = 'CONVEX_BIND_ADDR';

/** The single subject the whole per-user data model hangs off in no-auth mode. */
export const DEV_NO_AUTH_SUBJECT = 'dev-no-auth|local-boss';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/**
 * Env names set by the platforms this could plausibly be deployed to by
 * accident. None of them can be true of a backend running on the operator's own
 * machine, so any of them present is a contradiction of no-auth mode.
 */
const HOSTED_PLATFORM_MARKERS = [
  'VERCEL',
  'VERCEL_ENV',
  'AWS_REGION',
  'AWS_EXECUTION_ENV',
  'KUBERNETES_SERVICE_HOST',
  'FLY_APP_NAME',
  'RENDER',
  'DYNO',
];

/**
 * Reading an unset name can throw rather than return `undefined` depending on
 * where the Convex runtime evaluates a module, and the checks below deliberately
 * read names most deployments will not have set.
 */
function readEnv(name: string): string | undefined {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
}

function isLoopbackHost(host: string): boolean {
  const hostname = host.trim().toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  // The whole of 127.0.0.0/8 is loopback; 127.0.0.1 is only its usual member.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function originIsLoopback(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Why this deployment must not mint the synthetic identity, or null if it may. */
function refusalReason(): string | null {
  const hosted = HOSTED_PLATFORM_MARKERS.filter((name) => !!readEnv(name));
  if (hosted.length > 0) {
    return `this environment carries hosted-platform markers (${hosted.join(', ')})`;
  }

  const bindAddr = readEnv(BIND_FLAG)?.trim();
  if (!bindAddr) {
    return (
      `${BIND_FLAG} is not set on this deployment, so the address the backend's ` +
      'ports are published on has not been declared'
    );
  }
  if (!isLoopbackHost(bindAddr)) {
    return (
      `${BIND_FLAG}=${bindAddr} publishes the backend beyond loopback, so callers ` +
      'off this machine can reach it'
    );
  }

  const cloudUrl = readEnv('CONVEX_CLOUD_URL');
  if (!cloudUrl) return 'this deployment is not reporting its own origin';
  if (!originIsLoopback(cloudUrl)) return `CONVEX_CLOUD_URL=${cloudUrl} is not a loopback origin`;

  const siteUrl = readEnv('CONVEX_SITE_URL');
  if (siteUrl && !originIsLoopback(siteUrl)) {
    return `CONVEX_SITE_URL=${siteUrl} is not a loopback origin`;
  }

  return null;
}

/**
 * The synthetic identity, or `null` when no-auth mode is off. Throws when the
 * flag is set on a deployment that has not established it is local-only.
 */
export function devNoAuthIdentity(): UserIdentity | null {
  if (readEnv(FLAG) !== 'true') return null;

  const refusal = refusalReason();
  if (refusal) {
    throw new Error(
      `${FLAG}=true disables authentication and is refused on this deployment ` +
        `because ${refusal}. It is only allowed on a self-hosted backend whose ` +
        `ports are published on loopback - set ${BIND_FLAG}=127.0.0.1 in ` +
        '`.env.local` and re-run `./scripts/sync-convex-env.sh`, or run ' +
        `\`npx convex env remove ${FLAG}\` against this deployment.`,
    );
  }

  return {
    tokenIdentifier: `day0-dev-no-auth|${DEV_NO_AUTH_SUBJECT}`,
    subject: DEV_NO_AUTH_SUBJECT,
    issuer: 'https://dev-no-auth.day0.local',
    name: 'Local boss',
    email: readEnv('NEXT_PUBLIC_DEMO_BOSS_EMAIL') ?? 'boss@day0.local',
    emailVerified: true,
  };
}

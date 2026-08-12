/**
 * No-auth development mode — the shared definition of the local issuer.
 *
 * When it is on, Clerk is not involved. The deployment accepts one locally
 * issued token instead, and every caller who presents it resolves to one fixed
 * synthetic subject. Nothing downstream changes: `assertOwnsAgent` and friends
 * still compare `agent.userId` against `identity.subject`, rows are still
 * stamped with a `userId`, and the per-user data model is untouched. There is
 * simply only ever one user.
 *
 * Because that one subject owns everything, the question is what a caller must
 * have before it may present as it. Two earlier versions of this file answered
 * "the backend must be unreachable from anywhere else", and inferred that from
 * a declared bind address. A Convex isolate cannot observe the socket it is
 * served over or the peer address of its caller, so that answer was an
 * inference from a declaration, and a declaration can diverge from the thing it
 * describes. Twice it did: the socket is opened by a different file, in a
 * different process, from a different variable.
 *
 * So reachability is no longer the question, and this file no longer mints
 * anything. The deployment holds only the public half of a keypair generated on
 * the operator's machine (`DEV_NO_AUTH_JWKS`), declared here as a custom JWT
 * provider. Convex then accepts a caller only if it presents a token signed by
 * the private half, which never leaves `.env.local`. A caller who reaches the
 * socket from anywhere at all still cannot present as the local boss without
 * that key, so the backend is checking a fact it can observe — a signature —
 * rather than inferring one it cannot.
 *
 * The Next.js half mints those tokens and gates who may ask for one; see
 * `src/lib/dev-auth-server.ts`.
 */

const FLAG = 'NEXT_PUBLIC_DEV_NO_AUTH';
const JWKS_VAR = 'DEV_NO_AUTH_JWKS';

/** The single subject the whole per-user data model hangs off in no-auth mode. */
export const DEV_NO_AUTH_SUBJECT = 'dev-no-auth|local-boss';

/** Names the local issuer. Never resolved over the network by either half. */
export const DEV_NO_AUTH_ISSUER = 'https://dev-no-auth.day0.local';

/** Checked against the token's `aud` claim by the deployment. */
export const DEV_NO_AUTH_AUDIENCE = 'day0-dev-no-auth';

export const DEV_NO_AUTH_KEY_ID = 'day0-dev-no-auth';

export const DEV_NO_AUTH_ALGORITHM = 'ES256';

/**
 * Env names set by the platforms this could plausibly be deployed to by
 * accident. None of them can be true of a backend running on the operator's own
 * machine, so any of them present is a contradiction of no-auth mode. Possession
 * already holds without this check; it exists so a flag that reaches a hosted
 * deployment fails the push loudly instead of quietly configuring an issuer
 * nobody meant to run there.
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

/** Whether this deployment has been asked to run without Clerk. */
export function devNoAuthRequested(): boolean {
  return readEnv(FLAG) === 'true';
}

/**
 * The auth provider no-auth mode runs on. Throws rather than returning a
 * provider-less config, so a deployment that has been asked for no-auth mode
 * without a key refuses the push instead of coming up with authentication
 * silently disabled.
 */
export function devNoAuthProvider(): {
  type: 'customJwt';
  applicationID: string;
  issuer: string;
  jwks: string;
  algorithm: string;
} {
  const hosted = HOSTED_PLATFORM_MARKERS.filter((name) => !!readEnv(name));
  if (hosted.length > 0) {
    throw new Error(
      `${FLAG}=true serves every caller as one fixed user and is refused on this ` +
        `deployment because it carries hosted-platform markers (${hosted.join(', ')}). ` +
        `Run \`npx convex env remove ${FLAG}\` against this deployment.`,
    );
  }

  const jwks = readEnv(JWKS_VAR)?.trim();
  if (!jwks) {
    throw new Error(
      `${FLAG}=true requires ${JWKS_VAR} on this deployment: it is the public half ` +
        'of the local key that no-auth callers must sign their token with. Run ' +
        '`pnpm dev:no-auth-key` and then `./scripts/sync-convex-env.sh`.',
    );
  }
  if (!jwks.startsWith('data:') && !jwks.startsWith('https://') && !jwks.startsWith('http://')) {
    throw new Error(
      `${JWKS_VAR} must be a JWKS URI - either a data: URI holding the key set or a ` +
        'URL serving one. Re-run `pnpm dev:no-auth-key` to regenerate it.',
    );
  }

  return {
    type: 'customJwt',
    applicationID: DEV_NO_AUTH_AUDIENCE,
    issuer: DEV_NO_AUTH_ISSUER,
    jwks,
    algorithm: DEV_NO_AUTH_ALGORITHM,
  };
}

/**
 * What to tell a caller the deployment could not identify. In no-auth mode the
 * usual cause is a browser that never presented a local token, which is the
 * boundary doing its job rather than a fault.
 */
export function notAuthenticatedMessage(): string {
  if (!devNoAuthRequested()) return 'not authenticated';
  return (
    'not authenticated: no-auth dev mode accepts only callers holding this ' +
    "machine's local key. Start the app with `pnpm dev` and open the unlock URL " +
    'it prints.'
  );
}

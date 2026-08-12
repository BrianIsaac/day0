/// <reference types="node" />

/**
 * No-auth development mode — the Next.js half.
 *
 * When it is on, Clerk is skipped end to end: no `ClerkProvider`, no Clerk JWT
 * minting in the API routes. Convex resolves every caller to one fixed synthetic
 * user instead, so ownership checks and the per-user data model are unchanged —
 * there is simply only ever one user. It exists so the project can be run from a
 * fresh clone with no third-party accounts.
 *
 * Three properties hold it shut in production, and none of them can be
 * overridden by an environment variable:
 *
 *   1. It must be asked for explicitly. `NEXT_PUBLIC_DEV_NO_AUTH` must equal the
 *      exact string `true`; unset, empty, `1` and `TRUE` all mean off.
 *   2. It only ever resolves on under `next dev`. `NODE_ENV === 'development'`
 *      is a hard requirement, so every `next build` and `next start` — which is
 *      all Vercel ever runs — has it off, in the server bundle and the browser
 *      bundle alike.
 *   3. Asking for it anywhere production-like throws at module load. A stray
 *      `NEXT_PUBLIC_DEV_NO_AUTH=true` in a Vercel project fails the build with
 *      this message rather than shipping an open deployment.
 *
 * Those three decide whether the mode may run at all. Who may then use it is a
 * separate question with a separate answer, because a dev server that is running
 * can be reached through a tunnel, a reverse proxy or a relay no matter what
 * address it binds: a caller must hold this machine's local key. That check, and
 * the key itself, live in `src/lib/dev-auth-server.ts` — deliberately not here,
 * because this module is imported by client components and secrets must not be.
 */

const FLAG = 'NEXT_PUBLIC_DEV_NO_AUTH';

const requested = process.env.NEXT_PUBLIC_DEV_NO_AUTH === 'true';
const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * `VERCEL` is set on every Vercel build and every Vercel runtime, previews
 * included. It is server-only — the browser bundle is covered by the NODE_ENV
 * check, which Vercel can never make `development`.
 */
const onVercel = !!process.env.VERCEL || !!process.env.NEXT_PUBLIC_VERCEL_ENV;

if (requested && (!isDevelopment || onVercel)) {
  throw new Error(
    `${FLAG}=true is a local-development-only flag and was found in a ` +
      `production-like environment (NODE_ENV=${process.env.NODE_ENV}` +
      `${onVercel ? ', running on Vercel' : ''}). It disables authentication ` +
      'entirely, so it is refused outside `next dev`. Remove ' +
      `${FLAG} from this environment and redeploy.`,
  );
}

/** True only under `next dev` with the flag explicitly set to `true`. */
export const DEV_NO_AUTH: boolean = requested && isDevelopment && !onVercel;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

/**
 * Whether a `Host` header names this machine. The header is caller-controlled
 * and a forwarder rewrites it freely, so this establishes nothing on its own and
 * nothing depends on it: it is a cheap refusal for the accidental cases (a
 * colleague browsing your LAN address, a page that rebound DNS to loopback)
 * ahead of the check that does hold, which is possession of the local key.
 */
export function isLoopbackHostHeader(host: string | null | undefined): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  // `[::1]:3000` - an IPv6 literal keeps its brackets, so the port is what
  // follows the closing one.
  const hostname = trimmed.startsWith('[')
    ? trimmed.slice(1, trimmed.indexOf(']'))
    : trimmed.split(':')[0];
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  // The whole of 127.0.0.0/8 is loopback; 127.0.0.1 is only its usual member.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The boss the synthetic user presents as. Mirrors the identity
 * `convex/devAuth.ts` mints, so the deploy form and the Convex row agree.
 */
export const DEV_BOSS_EMAIL = process.env.NEXT_PUBLIC_DEMO_BOSS_EMAIL || 'boss@day0.local';
export const DEV_BOSS_FIRST_NAME = 'Boss';

/// <reference types="node" />

/**
 * No-auth development mode — the Next.js half.
 *
 * When it is on, Clerk is skipped end to end: no `ClerkProvider`, no proxy
 * protection, no JWT minting in the API routes. Convex resolves every caller to
 * one fixed synthetic user instead (see `convex/devAuth.ts`), so ownership
 * checks and the per-user data model are unchanged — there is simply only ever
 * one user. It exists so the project can be run from a fresh clone with no
 * third-party accounts.
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

/**
 * The boss the synthetic user presents as. Mirrors the identity
 * `convex/devAuth.ts` mints, so the deploy form and the Convex row agree.
 */
export const DEV_BOSS_EMAIL = process.env.NEXT_PUBLIC_DEMO_BOSS_EMAIL || 'boss@day0.local';
export const DEV_BOSS_FIRST_NAME = 'Boss';

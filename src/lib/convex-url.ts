import 'server-only';

/**
 * The address a server route dials the backend on.
 *
 * `NEXT_PUBLIC_CONVEX_URL` is the browser's address and is inlined into the
 * bundle at build. A server process may need a different one (a compose
 * service name, a private address), so `CONVEX_URL` names it when set. Kept
 * apart from `convex-caller.ts` so a module that needs only the address (the
 * company sign-in's routes) never loads Clerk, which the customer-local
 * profile never runs.
 *
 * @param values - Environment values to read.
 * @returns `CONVEX_URL`, else `NEXT_PUBLIC_CONVEX_URL`.
 * @throws Error when neither is set.
 */
export function serverConvexUrl(values: Partial<Record<string, string>> = process.env): string {
  const url = values.CONVEX_URL?.trim() || values.NEXT_PUBLIC_CONVEX_URL?.trim();
  if (!url) throw new Error('Neither CONVEX_URL nor NEXT_PUBLIC_CONVEX_URL is set.');
  return url;
}

/**
 * Clerk's client cookie, `__client_uat` (suffixed per instance in newer SDKs), holds the time of
 * the browser's last sign-in and `0` once it has signed out. It is set by Clerk on this origin and
 * readable by script; with none above zero, this browser has no session for Clerk to resolve.
 */
const CLIENT_UAT = String.raw`(?:^|;\s*)__client_uat(?:_[^=]*)?=(\d+)`;

/**
 * Whether a document's cookies hold a Clerk session for Clerk to resolve.
 *
 * @param cookie - The document's cookie string.
 */
export function holdsClerkSession(cookie: string): boolean {
  const stamps = [...cookie.matchAll(new RegExp(CLIENT_UAT, 'g'))].map((match) => Number(match[1]));
  return stamps.some((stamp) => stamp > 0);
}

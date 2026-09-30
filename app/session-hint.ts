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

/** The attribute on `<html>` the head's script writes: `present` or `none`. */
export const SESSION_HINT_ATTRIBUTE = 'data-session-hint';

/**
 * The root layout's inline head script: it reads the session cookie before the first paint, which
 * no static page's server can, and writes the answer onto `<html>`, so the header's account slot
 * holds room for the control Clerk will mount from the first frame (`app/globals.css`). It is
 * `holdsClerkSession` in the page's own words, over the same pattern.
 */
export const SESSION_HINT_SCRIPT = `(function () {
  var pattern = new RegExp(${JSON.stringify(CLIENT_UAT)}, 'g');
  var hint = 'none';
  var match;
  while ((match = pattern.exec(document.cookie)) !== null) if (Number(match[1]) > 0) hint = 'present';
  document.documentElement.setAttribute(${JSON.stringify(SESSION_HINT_ATTRIBUTE)}, hint);
})();`;

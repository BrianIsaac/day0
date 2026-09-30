/**
 * Clerk's client cookie, `__client_uat`, holds the time of the browser's last sign-in and `0` once
 * it has signed out. It is set by Clerk on this origin and readable by script. Newer SDKs write it
 * twice, bare and suffixed per instance (the suffix is the first group); the bare one is shared by
 * every Clerk application on the host, which is any developer's localhost, so it can be another
 * application's. A suffixed stamp therefore decides when there is one, and the bare one only when
 * there is none; with no deciding stamp above zero, this browser has no session to resolve.
 */
const CLIENT_UAT = String.raw`(?:^|;\s*)__client_uat(_[^=;]*)?=(\d+)`;

/**
 * Whether a document's cookies hold a Clerk session for Clerk to resolve.
 *
 * @param cookie - The document's cookie string.
 */
export function holdsClerkSession(cookie: string): boolean {
  const stamps = [...cookie.matchAll(new RegExp(CLIENT_UAT, 'g'))];
  const suffixed = stamps.filter((match) => match[1] !== undefined);
  const deciding = suffixed.length > 0 ? suffixed : stamps;
  return deciding.some((match) => Number(match[2]) > 0);
}

/** The attribute on `<html>` the head's script writes: `present` or `none`. */
export const SESSION_HINT_ATTRIBUTE = 'data-session-hint';

/**
 * The root layout's inline head script: it reads the session cookie before the first paint, which
 * no static page's server can, and writes the answer onto `<html>`, so the header's account slot
 * holds room for the control Clerk will mount from the first frame (`app/globals.css`). It is
 * `holdsClerkSession` in the page's own words, over the same pattern and the same rule.
 */
export const SESSION_HINT_SCRIPT = `(function () {
  var pattern = new RegExp(${JSON.stringify(CLIENT_UAT)}, 'g');
  var bare = false;
  var suffixed = false;
  var anySuffixed = false;
  var match;
  while ((match = pattern.exec(document.cookie)) !== null) {
    var live = Number(match[2]) > 0;
    if (match[1]) {
      anySuffixed = true;
      if (live) suffixed = true;
    } else if (live) bare = true;
  }
  var hint = (anySuffixed ? suffixed : bare) ? 'present' : 'none';
  document.documentElement.setAttribute(${JSON.stringify(SESSION_HINT_ATTRIBUTE)}, hint);
})();`;

/** The pages a sign-in that returns there leads to the deploy form from: the home, by either name. */
const HOME_PATHS: ReadonlySet<string> = new Set(['/', '/home']);

/** The sign-in's heading for a new visitor, whom the home then asks to deploy an employee. */
export const DEPLOY_HEADING = 'Sign in to deploy an employee';

/** The sign-in's heading for a visitor sent there from a page they asked for. */
export const CONTINUE_HEADING = 'Sign in to continue';

/**
 * The sign-in page's heading by where the sign-in returns to (the round review's m23): a visitor
 * Clerk sent there from a page they asked for (`redirect_url`, an employee's page, the
 * organisation page) continues there; anyone else, and an address that is not one, is asked to
 * deploy an employee, as the home then does.
 *
 * @param redirectUrl - Clerk's `redirect_url` search value, absolute or a path, if any.
 */
export function signInHeading(redirectUrl: string | string[] | undefined): string {
  if (typeof redirectUrl !== 'string' || redirectUrl === '') return DEPLOY_HEADING;
  // An absolute address, or a path alone, read against a placeholder origin: only its path is
  // compared. Anything else names no page the sign-in returns to.
  const base = redirectUrl.startsWith('/') ? 'https://day0.invalid' : undefined;
  if (!URL.canParse(redirectUrl, base)) return DEPLOY_HEADING;
  const path = new URL(redirectUrl, base).pathname.replace(/\/+$/, '') || '/';
  return HOME_PATHS.has(path) ? DEPLOY_HEADING : CONTINUE_HEADING;
}

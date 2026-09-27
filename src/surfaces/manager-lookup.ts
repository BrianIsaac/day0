/**
 * A probe failure caused by the manager's chat identity, not by the credential.
 *
 * The Slack probe looks the manager up by email on every run. When that lookup
 * fails (the account is deactivated, left the workspace, is a bot, or no email
 * is set) the credential still works: the fix is a different manager, not a
 * new credential. The texts matched here are the ones `probeSlackSurface` and
 * `managerUserId` in `convex/surfaceActions.ts` raise; their mirror test pins
 * that each one is recognised.
 */
const MANAGER_LOOKUP_FAILURE =
  /\bthe manager email\b|\bhas no manager email\b|\breturned no manager identity\b/i;

/**
 * Whether a surface's failure reason is the manager lookup rather than the access.
 *
 * Args:
 *   reason: The stored or safe failure text, possibly undefined on a healthy row.
 *
 * Returns:
 *   True when changing the manager, not the credential, is what would fix it.
 */
export function isManagerLookupFailure(reason: string | undefined): boolean {
  return reason !== undefined && MANAGER_LOOKUP_FAILURE.test(reason);
}

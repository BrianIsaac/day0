/*
 * A documentation sync the deployment's pause held (12-J; W12V-2). From 0.17.0 the hold is the
 * source's own `held` status and its run's `held` state, with this reason as the source's last
 * error; a release before recorded it as `error` with the same reason, which the page and the
 * resume still read as held: nothing was tried, so nothing failed.
 */

/** How every held sync's reason opens, this release's words and the one before alike. */
const SYNC_HELD_OPENING = "Held: this deployment's scheduled work is paused";

/**
 * Why a sync stopped short with nothing read: the deployment's scheduled work is paused. Shown on
 * the documentation page under the source's "Held".
 */
export const SYNC_HELD_REASON = `${SYNC_HELD_OPENING}. The sync goes on from where it stopped at its next scheduled turn after the work resumes (within 15 minutes), or at once with Re-sync.`;

/** Whether a source's last error is a held sync's reason, as this release or the one before wrote it. */
export function isSyncHeldReason(reason: string | undefined): boolean {
  return reason?.startsWith(SYNC_HELD_OPENING) === true;
}

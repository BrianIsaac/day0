/**
 * Whether a new documentation sync takes over a run that ended short, from its cursor.
 *
 * A sync that fails at page 300 of 500, or whose action the runtime killed,
 * used to start again at page one with nothing recorded (P10-1, step 17). A
 * run that ended short keeps the cursor it reached, the refs and credential
 * refs of the pages it read, and its counts; the next sync carries them
 * forward and reads on from there. It starts again from page one when there
 * is nothing to carry, when the carried pages would be stale, or when the
 * run it would carry was itself a resume that got no further, since a cursor
 * a provider no longer accepts would otherwise fail at the same place for ever.
 *
 * Only a cursor a resume can check is carried (D D5): an offset bound to the
 * digest of the listing it continues, which restarts the run when the listing
 * moved, or the finish's own checkpoint. A provider's cursor (Notion's
 * `start_cursor`, Drive's `pageToken`, Confluence's) is the provider's, and a
 * page deleted mid-walk may shift what it returns; a bare offset, as runs
 * begun before 0.6.0 kept, names no listing at all. Both start from page one
 * until a provider's cursor is measured to hold.
 */

import type { Doc } from '../../convex/_generated/dataModel';
import { finishingStep } from './finishing';
import { isListingCursor } from './readers/batch';
import { isSyncHeldReason } from './sync-held';

/** A run older than this is not resumed: its pages were read too long ago to finish a generation with. */
export const RESUMABLE_RUN_MS = 24 * 60 * 60 * 1000;

/** The run fields the resume decision reads. */
export type ResumeCandidate = Pick<
  Doc<'docSyncRuns'>,
  '_id' | 'state' | 'cursor' | 'listing' | 'pageCount' | 'createdAt'
> &
  Partial<Pick<Doc<'docSyncRuns'>, 'reason'>>;

/**
 * Whether the deployment's pause ended the run before it read anything: `held`, or, as a release
 * before 0.17.0 recorded a hold, `error` with the held reason (which a takeover keeps first).
 */
function heldRun(run: ResumeCandidate): boolean {
  return run.state === 'held' || (run.state === 'error' && isSyncHeldReason(run.reason));
}

/**
 * The run a new sync carries forward, if any.
 *
 * @param latest - The source's newest run.
 * @param previous - The run before it.
 * @param now - The clock, in epoch milliseconds.
 * @returns The newest run when it ended short with a cursor a resume can check, carries its
 *   listing, is recent, and was not a resume that got nowhere; undefined when the new sync reads
 *   from page one.
 */
export function runToResume<R extends ResumeCandidate>(
  latest: R | undefined,
  previous: ResumeCandidate | undefined,
  now: number,
): R | undefined {
  if (latest === undefined || latest.state === 'completed' || latest.cursor === undefined) {
    return undefined;
  }
  // Only a run begun before 0.6.0 has no listing; its batches cannot be stamped under one (13-K).
  if (latest.listing === undefined) return undefined;
  if (!isListingCursor(latest.cursor) && finishingStep(latest.cursor) === undefined) {
    return undefined;
  }
  if (now - latest.createdAt > RESUMABLE_RUN_MS) return undefined;
  // A held run tried nothing, so two runs at one cursor are a resume that got nowhere only when
  // both read and failed there (W12-R27).
  const gotNowhere =
    previous !== undefined &&
    previous.state !== 'completed' &&
    !heldRun(previous) &&
    !heldRun(latest) &&
    previous.cursor === latest.cursor &&
    previous.pageCount === latest.pageCount;
  return gotNowhere ? undefined : latest;
}

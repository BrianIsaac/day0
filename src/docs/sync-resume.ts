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
 */

import type { Doc } from '../../convex/_generated/dataModel';

/** A run older than this is not resumed: its pages were read too long ago to finish a generation with. */
export const RESUMABLE_RUN_MS = 24 * 60 * 60 * 1000;

/** The run fields the resume decision reads. */
export type ResumeCandidate = Pick<
  Doc<'docSyncRuns'>,
  '_id' | 'state' | 'cursor' | 'pageCount' | 'createdAt'
>;

/**
 * The run a new sync carries forward, if any.
 *
 * @param latest - The source's newest run.
 * @param previous - The run before it.
 * @param now - The clock, in epoch milliseconds.
 * @returns The newest run when it ended short with a cursor, is recent, and was not a resume
 *   that got nowhere; undefined when the new sync reads from page one.
 */
export function runToResume<R extends ResumeCandidate>(
  latest: R | undefined,
  previous: ResumeCandidate | undefined,
  now: number,
): R | undefined {
  if (latest === undefined || latest.state === 'completed' || latest.cursor === undefined) {
    return undefined;
  }
  if (now - latest.createdAt > RESUMABLE_RUN_MS) return undefined;
  const gotNowhere =
    previous !== undefined &&
    previous.state !== 'completed' &&
    previous.cursor === latest.cursor &&
    previous.pageCount === latest.pageCount;
  return gotNowhere ? undefined : latest;
}

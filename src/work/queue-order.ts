/**
 * The order the work loop serves the waiting queue, and the limits it parks
 * a row by, for every reader outside the loop: the dashboard lists the queue
 * in the order the loop will take it (U3 D5) and says why a row waits.
 *
 * `convex/workLoop.ts` holds the same rule for its own reads;
 * `tests/src/work/queue-order.test.ts` holds the two to one answer until the
 * loop imports it from here.
 */

/** How many evaluations of one row may begin without a verdict before the loop parks it. */
export const MAX_EVALUATION_ATTEMPTS = 3;

/** The deferral reason of a row parked after `MAX_EVALUATION_ATTEMPTS`; the manager's Retry takes it back. */
export const EVALUATION_ATTEMPTS_SPENT = 'evaluation-attempts-spent';

/**
 * The rank a provider priority gives a waiting row; lower is served first.
 *
 * Args:
 *   priority: The provider's priority label, as intake stored it.
 *
 * Returns:
 *   0 for urgent, 1 high, 2 medium, 3 low, 4 for none or a label it does not know.
 */
export function queueRank(priority: string | undefined): number {
  const lower = (priority ?? '').toLowerCase();
  if (/\b(?:p0|urgent)\b|production-down/.test(lower)) return 0;
  if (/\b(?:p1|high)\b/.test(lower)) return 1;
  if (/\b(?:p2|medium)\b/.test(lower)) return 2;
  if (/\b(?:p3|low)\b/.test(lower)) return 3;
  return 4;
}

/** What the queue order reads of a waiting row. */
export interface WaitingRow {
  readonly _creationTime: number;
  readonly priority?: string;
  readonly evaluationAttempts?: number;
}

/**
 * The loop's order for rows waiting for a free slot: a row no evaluation has
 * begun on before one whose evaluation died, then the most urgent, then the
 * oldest.
 *
 * Returns:
 *   Negative when `left` is served first, as `Array.prototype.sort` reads it.
 */
export function compareWaitingRows(left: WaitingRow, right: WaitingRow): number {
  const attempted = (row: WaitingRow): number => ((row.evaluationAttempts ?? 0) > 0 ? 1 : 0);
  return (
    attempted(left) - attempted(right) ||
    queueRank(left.priority) - queueRank(right.priority) ||
    left._creationTime - right._creationTime
  );
}

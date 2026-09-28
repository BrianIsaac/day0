/**
 * The order the work loop serves the waiting queue, and the limits it parks
 * a row by: the one rule the loop (`convex/workLoop.ts`) runs and every reader
 * outside it shows, so the dashboard lists the queue in the order the loop
 * will take it (U3 D5) and says why a row waits.
 */

/**
 * How many evaluations of one row may begin without a verdict. A row whose
 * evaluation dies after its claim (an action killed at the time limit, a
 * throw) keeps the claim until the lease passes, then ranks behind every
 * unattempted row; after this many it is parked, so one dying evaluation at a
 * cap of one never holds the queue (wave 2 review M23).
 */
export const MAX_EVALUATION_ATTEMPTS = 3;

/**
 * The deferral reason of a row parked after `MAX_EVALUATION_ATTEMPTS`
 * evaluations died; the manager's Retry takes it back. A row whose last
 * evaluation found the scope judgement unreachable is parked as
 * `scope-judgement-unavailable` instead, which the charter trigger and Check
 * for new work re-admit, because half an hour of provider outage is three
 * attempts (E-70 D2).
 */
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

import type { WorkVerdict } from '@/work/types';

/**
 * What the evaluator judged a piece of work, in the manager's words, after "judged": the verdict's
 * own name ("claim", "needs-skill") is the evaluator's, not the manager's (the hosted walk's m15).
 */
const JUDGED = {
  claim: 'part of the job',
  queue: 'part of the job, queued behind its open work',
  skip: 'not part of the job',
  defer: 'part of the job, waiting on a connection or a permission',
  'needs-skill': 'part of the job, needs a skill first',
} as const satisfies Record<WorkVerdict['decision'], string>;

/** The decision a registered skill writes on the items that waited on it, to judge them again. */
export const REEVALUATION = 'pending-reevaluation';

/**
 * A verdict's words after "judged", or undefined for one no release makes any more.
 *
 * @param decision - The verdict's decision, as the event stored it.
 */
export function judgedAs(decision: string): string | undefined {
  return Object.hasOwn(JUDGED, decision) ? JUDGED[decision as keyof typeof JUDGED] : undefined;
}

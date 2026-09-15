/**
 * The manager's written word on a work item: a rejection reason or a note
 * given with Retry. One value lives on the item at a time; it is the
 * direction the next run reads, and once a run has completed with it the
 * record stays on the item marked as addressed so the card keeps telling the
 * story and no later run mistakes it for a live instruction.
 */

export type ManagerFeedbackKind = 'rejection' | 'retry-note';

export interface ManagerFeedback {
  reason: string;
  at: number;
  /** Absent on rows written before the kind existed; those were all rejection reasons. */
  kind?: ManagerFeedbackKind;
  /** When a run completed with this feedback as its direction. */
  addressedAt?: number;
}

/**
 * The feedback a run about to start should read, if any.
 *
 * Args:
 *   feedback: The item's stored feedback.
 *
 * Returns:
 *   The reason while no completed run has addressed it; otherwise undefined.
 */
export function liveManagerFeedback(feedback: ManagerFeedback | undefined): string | undefined {
  if (!feedback || feedback.addressedAt !== undefined) return undefined;
  const reason = feedback.reason.trim();
  return reason === '' ? undefined : reason;
}

/**
 * The card's name for a piece of feedback.
 *
 * Args:
 *   feedback: The stored feedback.
 *
 * Returns:
 *   `Retry note` for a note given with Retry, else `Rejection reason`.
 */
export function managerFeedbackLabel(feedback: Pick<ManagerFeedback, 'kind'>): string {
  return feedback.kind === 'retry-note' ? 'Retry note' : 'Rejection reason';
}

import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

/**
 * The server-driven work loop, real mode only.
 *
 * Each employee's work moves because the server schedules its next step, not
 * because a dashboard page happens to be open: evaluation, drafting and
 * execution run as scheduled internal actions, one claim per step.
 */

/**
 * How long a step's claim is honoured. The backend kills a Node action after
 * ten minutes, so a claim this old belongs to a step that is gone; the skills'
 * authoring lease (`src/lib/skill-authoring.ts`) is the precedent.
 */
export const STEP_LEASE_MS = 10 * 60 * 1000;

/** A step the loop claims on the row before spending a model call on it. */
export type LoopStep = 'evaluation' | 'draft';

const CLAIM_FIELD = {
  evaluation: 'evaluationClaimedAt',
  draft: 'draftClaimedAt',
} as const satisfies Record<LoopStep, keyof Doc<'workItems'>>;

/**
 * Whether a step of this row is held by a run that could still come back.
 *
 * Args:
 *   row: The work item's claim fields.
 *   step: Which step's claim to read.
 *   now: The instant to judge the claim against.
 *
 * Returns:
 *   True while the claim is younger than the lease.
 */
export function holdsLiveStepClaim(
  row: Pick<Doc<'workItems'>, 'evaluationClaimedAt' | 'draftClaimedAt'>,
  step: LoopStep,
  now: number,
): boolean {
  const claimedAt = row[CLAIM_FIELD[step]];
  return claimedAt !== undefined && now - claimedAt < STEP_LEASE_MS;
}

/** Why a step was not claimed: the row moved on, or another run holds it. */
export type StepClaim = { claimed: true } | { claimed: false; reason: string };

/**
 * Claim one step of one row, or report why not.
 *
 * The state check and the stamp share one transaction, so of two runs that
 * both read the row ready, exactly one proceeds to the model. The claim is
 * released by the step's own result (`applyVerdict`, `setPlan`); a run that
 * throws or dies leaves it to lapse, so a failing step is retried by the
 * sweep no sooner than the lease.
 *
 * Args:
 *   ctx: Mutation context.
 *   workItemId: The row.
 *   step: The step about to run.
 *   now: The claim time.
 *
 * Returns:
 *   Whether this run holds the step, and the reason when it does not.
 */
export async function claimLoopStepInTransaction(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  step: LoopStep,
  now: number,
): Promise<StepClaim> {
  const row = await ctx.db.get(workItemId);
  if (!row) return { claimed: false, reason: 'workItem not found' };
  const ready = step === 'evaluation' ? 'discovered' : 'claimed';
  if (row.state !== ready) return { claimed: false, reason: `state=${row.state}` };
  if (holdsLiveStepClaim(row, step, now)) return { claimed: false, reason: 'claimed' };
  await ctx.db.patch(workItemId, { [CLAIM_FIELD[step]]: now });
  return { claimed: true };
}

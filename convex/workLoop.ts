import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { isRevocationTrialRow } from './revocationEvaluation';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { autonomousActionsOn } from '../src/work/autonomy';
import { AUTONOMOUS_WIP_LIMIT, COLD_START_WIP_LIMIT } from '../src/work/types';

/**
 * The server-driven work loop, real mode only.
 *
 * Each employee's work moves because the server schedules its next step, not
 * because a dashboard page happens to be open: evaluation, drafting and
 * execution run as scheduled internal actions, one claim per step. Every
 * transition either schedules the row's next step, waits on the manager or a
 * running step, or is terminal and hands a freed slot to the work queued at
 * the cap. Mock mode schedules nothing: the hosted demo and the frozen
 * harness drive the same actions from the page and the harness.
 *
 * Two kinds of row are driven by someone else and never scheduled here: the
 * revocation driver's trial rows, which it seeds, evaluates and finishes
 * itself, and every mock row.
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

/** The states that hold one of the employee's work-in-progress slots. */
export const OPEN_WORK_STATES = [
  'claimed',
  'plan-pending',
  'plan-approved',
  'executing',
  'actions-pending',
] as const satisfies ReadonlyArray<Doc<'workItems'>['state']>;

/** Discovered rows read when looking for the one a freed slot goes to. */
const WAKE_SCAN = 100;

/** What `scheduleNextStep` reads of a row, after its transition. */
export type LoopRow = Pick<
  Doc<'workItems'>,
  '_id' | 'agentId' | 'state' | 'externalId' | 'plan' | 'verdict'
>;

/**
 * Count the employee's rows holding a slot, stopping once the cap is reached.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 *   cap: The employee's current work-in-progress limit.
 *
 * Returns:
 *   The open rows counted, at most `cap`.
 */
export async function openSlotCount(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  cap: number,
): Promise<number> {
  let open = 0;
  for (const state of OPEN_WORK_STATES) {
    const remaining = cap - open;
    if (remaining <= 0) break;
    open += (
      await ctx.db
        .query('workItems')
        .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
        .take(remaining)
    ).length;
  }
  return open;
}

/**
 * The discovered row a free slot goes to: the oldest one no evaluation holds.
 *
 * A row whose evaluation is running lands its own verdict and wakes the next
 * one itself, and a row whose evaluation died keeps its claim until the lease
 * passes, so neither blocks the rows behind it.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 *   now: The instant to judge claims against.
 *
 * Returns:
 *   The row to evaluate, or undefined when the employee is at its cap or
 *   nothing is waiting.
 */
export async function nextRowForFreeSlot(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<Id<'workItems'> | undefined> {
  const agent = await ctx.db.get(agentId);
  if (!agent) return undefined;
  const cap = autonomousActionsOn(agent) ? AUTONOMOUS_WIP_LIMIT : COLD_START_WIP_LIMIT;
  if ((await openSlotCount(ctx, agentId, cap)) >= cap) return undefined;
  const discovered = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'discovered'))
    .take(WAKE_SCAN);
  return discovered.find(
    (row) => !isRevocationTrialRow(row) && !holdsLiveStepClaim(row, 'evaluation', now),
  )?._id;
}

async function scheduleEvaluation(ctx: MutationCtx, workItemId: Id<'workItems'>): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.workActions.evaluateWorkItemInternal, { workItemId });
}

async function wakeQueuedWork(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  const next = await nextRowForFreeSlot(ctx, agentId, Date.now());
  if (next) await scheduleEvaluation(ctx, next);
}

/**
 * Schedule what a row needs next, in the transaction that moved it.
 *
 * A row entering `discovered` is evaluated, unless its verdict queued it at
 * the cap; entering `claimed` without a plan, drafted; entering
 * `plan-approved`, executed. A row the manager or a running step moves next
 * schedules nothing. Every other transition may have freed a slot or left
 * one free, so the oldest discovered row is evaluated when the employee is
 * under its cap; that is how work queued at the cap resumes. Scheduling in
 * the same transaction as the move means a crash cannot separate the two;
 * a scheduled step that dies is the sweep's (`resumeStalledStepsInTransaction`).
 *
 * Args:
 *   ctx: Mutation context of the transition.
 *   row: The row as the transition left it.
 */
export async function scheduleNextStep(ctx: MutationCtx, row: LoopRow): Promise<void> {
  if (SURFACE_MODE !== 'real' || isRevocationTrialRow(row)) return;
  switch (row.state) {
    case 'discovered':
      if ((row.verdict as { decision?: unknown } | undefined)?.decision === 'queue') {
        await wakeQueuedWork(ctx, row.agentId);
      } else {
        await scheduleEvaluation(ctx, row._id);
      }
      return;
    case 'claimed':
      if (row.plan === undefined) {
        await ctx.scheduler.runAfter(0, internal.workActions.draftPlanInternal, {
          workItemId: row._id,
        });
      }
      await wakeQueuedWork(ctx, row.agentId);
      return;
    case 'plan-approved':
      await ctx.scheduler.runAfter(0, internal.workActions.executeApprovedPlanInternal, {
        workItemId: row._id,
      });
      return;
    case 'plan-pending':
    case 'executing':
    case 'actions-pending':
      return;
    default:
      await wakeQueuedWork(ctx, row.agentId);
  }
}

/** Rows of one state read per employee in one sweep; the rest wait for the next. */
const SWEEP_BATCH = 100;

/**
 * Reschedule every step the loop lost, for every employee.
 *
 * Scheduling shares the transaction of each transition, so what is lost is
 * a step that ran and died: an action killed at its time limit, a model call
 * that threw, a backend restarted mid-run. Such a step holds its claim until
 * the lease passes, so a live run is never doubled. A ready row with no live
 * claim gets its step again: a discovered row not queued at the cap is
 * evaluated, a claimed row without a plan is drafted, an approved plan is
 * executed. A row that is ready but has no claim at all may only be waiting
 * in the scheduler; the claim or the state check turns the duplicate into a
 * few reads. Last, when nothing was evaluated and the employee has a free
 * slot, the oldest discovered row gets it, which recovers a wake-up lost with
 * a step that died after freeing the slot.
 *
 * Args:
 *   ctx: Mutation context.
 *   now: The instant to judge claims against.
 *
 * Returns:
 *   How many steps were scheduled.
 */
export async function resumeStalledStepsInTransaction(
  ctx: MutationCtx,
  now: number,
): Promise<{ rescheduled: number }> {
  if (SURFACE_MODE !== 'real') return { rescheduled: 0 };
  let rescheduled = 0;
  for (const agent of await ctx.db.query('agents').collect()) {
    const ready = async (state: 'discovered' | 'claimed' | 'plan-approved') =>
      (
        await ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id).eq('state', state))
          .take(SWEEP_BATCH)
      ).filter((row) => !isRevocationTrialRow(row));
    let evaluated = false;
    for (const row of await ready('discovered')) {
      if (holdsLiveStepClaim(row, 'evaluation', now)) continue;
      if ((row.verdict as { decision?: unknown } | undefined)?.decision === 'queue') continue;
      await scheduleEvaluation(ctx, row._id);
      evaluated = true;
      rescheduled += 1;
    }
    for (const row of await ready('claimed')) {
      if (row.plan !== undefined || holdsLiveStepClaim(row, 'draft', now)) continue;
      await ctx.scheduler.runAfter(0, internal.workActions.draftPlanInternal, {
        workItemId: row._id,
      });
      rescheduled += 1;
    }
    for (const row of await ready('plan-approved')) {
      await ctx.scheduler.runAfter(0, internal.workActions.executeApprovedPlanInternal, {
        workItemId: row._id,
      });
      rescheduled += 1;
    }
    if (!evaluated) {
      const next = await nextRowForFreeSlot(ctx, agent._id, now);
      if (next) {
        await scheduleEvaluation(ctx, next);
        rescheduled += 1;
      }
    }
  }
  return { rescheduled };
}

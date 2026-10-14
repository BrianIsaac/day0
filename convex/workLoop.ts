import { ConvexError, getConvexSize, getDocumentSize, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { isRevocationTrialRow } from './revocationEvaluation';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { autonomousActionsOn } from '../src/work/autonomy';
import {
  AUTONOMOUS_WIP_LIMIT,
  COLD_START_WIP_LIMIT,
  SCOPE_JUDGEMENT_UNAVAILABLE,
} from '../src/work/types';
import { normaliseActionVerdict } from '../src/surfaces/policy';
import {
  compareWaitingRows,
  EVALUATION_ATTEMPTS_SPENT,
  MAX_EVALUATION_ATTEMPTS,
} from '../src/work/queue-order';

import { appendEvent, eventsOfType } from './eventLog';
import { isBeingHandedOver } from './transferInFlight';
import type { EventType } from '../src/events/contract';
import { cronsPauseReason } from '../src/lib/crons-pause';
import { isPaused, stepHoldReason } from '../src/work/pause';
import { runHoldOf, type RunHold } from '../src/work/item-display';
import { pausedCheckRefusal } from '../src/work/held-starts';
import { resumeHeldStartsInTransaction } from './heldStarts';
import { scheduleDueHoldChecks } from './workingAgreements';

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
export const EXECUTION_STALL_MS = STEP_LEASE_MS + 2 * 60 * 1000;

/**
 * How many times the sweep restarts a draft that claimed its row and died.
 *
 * A draft that throws on a transport or provider failure keeps its claim, and
 * each restart repeats the grounding read and the model call. During an
 * outage that would go on for as long as the outage; after this many the row
 * stops for the manager's Retry instead.
 */
export const MAX_DRAFT_RESUMES = 3;

/** The event each restart of a dead draft writes; the cap is counted from it. */
const DRAFT_RESUMED = 'work.draft-resumed' satisfies EventType;

/**
 * A connected chat surface the manager can be asked through and answered from.
 *
 * The DM channel alone is not enough: intake reads replies only from a
 * surface whose probe also recorded the manager's provider user id, so a
 * request sent without it would ask for a reply nobody reads.
 */
export function isManagerChannel(surface: Doc<'surfaces'>): boolean {
  return (
    surface.class === 'chat' &&
    surface.verdict === 'connected' &&
    surface.credentialLanded &&
    !!surface.credentialId &&
    !!surface.managerDmChannelId &&
    !!surface.managerUserId
  );
}

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

/** Why a step was not claimed: the row moved on, or another run holds it; when claimed, the claim's time. */
export type StepClaim = { claimed: true; claimedAt: number } | { claimed: false; reason: string };

/** Whether a step of an employee may start now, and why not when it may not. */
export type StepPermission = { readonly mayRun: true } | { readonly mayRun: false; reason: string };

/**
 * Whether a step of this employee may start now (wave 12, 12-P): not while the manager has paused
 * the employee, and not while the deployment's scheduled work is paused (`DAY0_CRONS_PAUSED`).
 *
 * Read at both ends of every step. Where a step is queued (`queueStep`, `wakeQueuedWork`), a
 * refusal schedules nothing; where a step starts (each claim), a refusal holds a step queued
 * before either pause, so neither pause leaves a queued chain running (the gap `crons.ts` named).
 * The row stays in the state it was ready in, as a handover in flight leaves it, and the
 * stalled-step sweep, or the resume's own pass, queues it again. Real mode only: in mock mode the
 * page drives every step and nothing is held.
 *
 * @param db - Any reader.
 * @param agentId - The employee whose step it is.
 */
export async function stepMayRun(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
): Promise<StepPermission> {
  if (SURFACE_MODE !== 'real') return { mayRun: true };
  const reason = stepHoldReason(await db.get(agentId), cronsPauseReason());
  return reason === undefined ? { mayRun: true } : { mayRun: false, reason };
}

/**
 * What holds this employee's next step, as a card or an acknowledgement names it: the manager's
 * pause of the employee, then the deployment's pause of its scheduled work, as {@link stepMayRun}
 * reads them; undefined while a step may start, and always in mock mode.
 *
 * @param db - The reader.
 * @param agentId - The employee.
 */
export async function stepHoldOf(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
): Promise<RunHold | undefined> {
  const agent = await db.get(agentId);
  return runHoldOf({
    real: SURFACE_MODE === 'real',
    employeeName: agent?.name ?? 'the employee',
    employeePaused: agent !== null && isPaused(agent),
    scheduledWorkPaused: cronsPauseReason() !== undefined,
  });
}

/**
 * Internal: {@link stepMayRun} for a step that starts in an action, read before it does anything
 * a claim would otherwise have refused (the executor picks a skill, and parks the row behind a
 * missing one, before its claim). Writes nothing.
 */
export const stepPermission = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, { agentId }): Promise<StepPermission> => await stepMayRun(ctx.db, agentId),
});

/**
 * Claim one step of one row, or report why not.
 *
 * The state check and the stamp share one transaction, so of two runs that
 * both read the row ready, exactly one proceeds to the model. The claim is
 * released by the step's own result (`applyVerdict`, `setPlan`); a run that
 * throws or dies leaves it to lapse, so a failing step is retried by the
 * sweep no sooner than the lease. A discovered row is evaluated only while
 * the employee has a free slot, an evaluation already in flight holding one:
 * the slot is checked before the scope model call, not after it, so a poll
 * that seeds two hundred tickets spends at most the cap's worth of calls.
 * A paused employee, or a paused deployment, claims nothing (`stepMayRun`):
 * the row stays ready, with no claim and no attempt counted.
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
  const permission = await stepMayRun(ctx.db, row.agentId);
  if (!permission.mayRun) return { claimed: false, reason: permission.reason };
  if (step === 'evaluation') {
    if ((await queueState(ctx, row.agentId, now, row._id)).free === 0) {
      return { claimed: false, reason: 'queued' };
    }
    await ctx.db.patch(workItemId, {
      evaluationClaimedAt: now,
      evaluationAttempts: (row.evaluationAttempts ?? 0) + 1,
    });
    return { claimed: true, claimedAt: now };
  }
  await ctx.db.patch(workItemId, { [CLAIM_FIELD[step]]: now });
  return { claimed: true, claimedAt: now };
}

/** The states that hold one of the employee's work-in-progress slots. */
export const OPEN_WORK_STATES = [
  'claimed',
  'plan-pending',
  'plan-approved',
  'executing',
  'actions-pending',
] as const satisfies ReadonlyArray<Doc<'workItems'>['state']>;

/**
 * The states that park a row outside the slots until something it waits on
 * arrives: a connection or a grant, or a skill. A row an earlier verdict
 * queued at the work-in-progress cap is parked too, but in `discovered`, where
 * it waits like any unevaluated row.
 */
export const PARKED_WORK_STATES = ['deferred', 'needs-skill'] as const satisfies ReadonlyArray<
  Doc<'workItems'>['state']
>;

/** What `scheduleNextStep` reads of a row, after its transition. */
export type LoopRow = Pick<
  Doc<'workItems'>,
  '_id' | 'agentId' | 'state' | 'sourceSystem' | 'externalId' | 'plan' | 'verdict'
>;

/**
 * Discovered rows read per employee to find the evaluations in flight and the
 * next row; it matches intake's bound on the waiting queue
 * (`WAITING_WORK_LIMIT`), so the window is normally the whole queue.
 */
export const QUEUE_WINDOW = 50;

/**
 * How many discovered rows one employee may have waiting before intake stops
 * seeding more for it (N7's bound on seeding). The tickets stay where they are
 * in the provider and are read once the queue drains.
 */
export const WAITING_WORK_LIMIT = 50;

/**
 * How many rows wait to be evaluated for one employee, and the bound intake keeps.
 *
 * Internal; the intake sweep's. The count stops at the bound, so it reads at
 * most `WAITING_WORK_LIMIT` rows.
 */
export const waitingWork = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ waiting: number; limit: number }> => {
    const waiting = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'discovered'))
      .take(WAITING_WORK_LIMIT);
    return { waiting: waiting.length, limit: WAITING_WORK_LIMIT };
  },
});

/**
 * Which of a poll's listed items already have a row for this employee.
 *
 * Internal; the intake sweep's. A re-listed item updates its row and adds
 * nothing to the waiting queue, so only the others count against the bound
 * on seeding. One index lookup per listed item.
 */
export const seededItems = internalQuery({
  args: {
    agentId: v.id('agents'),
    sourceSystem: v.string(),
    externalIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<string[]> => {
    const seeded: string[] = [];
    for (const externalId of new Set(args.externalIds)) {
      const row = await ctx.db
        .query('workItems')
        .withIndex('by_agent_extId', (q) =>
          q
            .eq('agentId', args.agentId)
            .eq('sourceSystem', args.sourceSystem)
            .eq('externalId', externalId),
        )
        .first();
      if (row) seeded.push(externalId);
    }
    return seeded;
  },
});

/**
 * Count the employee's rows holding a slot, stopping once the cap is reached.
 *
 * Args:
 *   ctx: Query or mutation context.
 *   agentId: The employee.
 *   cap: The employee's current work-in-progress limit.
 *
 * Returns:
 *   The open rows counted, at most `cap`.
 */
export async function openSlotCount(
  ctx: Pick<QueryCtx, 'db'>,
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
 * Discovered rows read at most to fill the window: the revocation driver's
 * retained trial rows (a hundred ids at most) are passed over, not counted.
 */
const QUEUE_SCAN_LIMIT = QUEUE_WINDOW + 100;

/**
 * The employee's waiting rows the loop reads at once, oldest first.
 *
 * Trial rows are passed over without taking a place in the window, so work
 * queued behind the retained trials is still reached.
 */
async function queueWindow(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<Doc<'workItems'>[]> {
  const rows: Doc<'workItems'>[] = [];
  let scanned = 0;
  for await (const row of ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'discovered'))) {
    scanned += 1;
    if (!isRevocationTrialRow(row)) rows.push(row);
    if (rows.length === QUEUE_WINDOW || scanned === QUEUE_SCAN_LIMIT) break;
  }
  return rows;
}

/** The employee's free slots, and the waiting rows read to count them. */
interface QueueState {
  readonly free: number;
  readonly waiting: readonly Doc<'workItems'>[];
}

/**
 * How many more evaluations the employee may start now.
 *
 * The cap less the rows holding a slot, less the evaluations already in
 * flight: an evaluation that ends in a claim takes a slot, so it holds one
 * from the moment it is claimed. The waiting rows are read only when the cap
 * leaves room.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 *   now: The instant to judge claims against.
 *   except: A row whose own claim is being decided, not counted as in flight.
 *
 * Returns:
 *   The free slots, never below zero, and the waiting rows read.
 */
async function queueState(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
  except?: Id<'workItems'>,
): Promise<QueueState> {
  const agent = await ctx.db.get(agentId);
  if (!agent) return { free: 0, waiting: [] };
  const cap = autonomousActionsOn(agent) ? AUTONOMOUS_WIP_LIMIT : COLD_START_WIP_LIMIT;
  const open = await openSlotCount(ctx, agentId, cap);
  if (open >= cap) return { free: 0, waiting: [] };
  const waiting = await queueWindow(ctx, agentId);
  const inFlight = waiting.filter(
    (row) => row._id !== except && holdsLiveStepClaim(row, 'evaluation', now),
  ).length;
  return { free: Math.max(0, cap - open - inFlight), waiting };
}

/**
 * The waiting row a free slot goes to: a row no evaluation has begun before
 * one whose evaluation died, then the most urgent, then the oldest.
 *
 * A row whose evaluation is running lands its own verdict and wakes the next
 * one itself, and a row whose evaluation died keeps its claim until the lease
 * passes and then waits behind every unattempted row, so neither blocks the
 * rows behind it. Only `QUEUE_WINDOW` rows are read, so an urgent row behind a
 * longer queue waits its turn into the window.
 *
 * @param waiting - The window of waiting rows, oldest first.
 * @param now - The instant to judge claims against.
 * @returns The row to evaluate, or undefined when every row is in flight.
 */
function nextWaitingRow(
  waiting: readonly Doc<'workItems'>[],
  now: number,
): Doc<'workItems'> | undefined {
  let next: Doc<'workItems'> | undefined;
  for (const row of waiting) {
    if (holdsLiveStepClaim(row, 'evaluation', now)) continue;
    if (next === undefined || compareWaitingRows(row, next) < 0) next = row;
  }
  return next;
}

/**
 * Park each waiting row whose evaluation died `MAX_EVALUATION_ATTEMPTS`
 * times, each with a `work.evaluation-parked` event.
 *
 * A row is parked only once its last claim has lapsed, so an evaluation still
 * running is never cut short. The last attempt decides the reason: one that
 * found the scope judgement unreachable parks as `scope-judgement-unavailable`,
 * which the charter trigger and Check for new work re-admit; any other as
 * `EVALUATION_ATTEMPTS_SPENT`, which waits for the manager's Retry.
 *
 * @param waiting - The window of waiting rows.
 * @param now - The instant to judge claims against.
 * @returns The rows parked.
 */
async function parkSpentEvaluations(
  ctx: MutationCtx,
  waiting: readonly Doc<'workItems'>[],
  now: number,
): Promise<Set<Id<'workItems'>>> {
  const parked = new Set<Id<'workItems'>>();
  for (const row of waiting) {
    const attempts = row.evaluationAttempts ?? 0;
    if (attempts < MAX_EVALUATION_ATTEMPTS || holdsLiveStepClaim(row, 'evaluation', now)) continue;
    const unavailable =
      row.evaluationUnavailableAt !== undefined &&
      row.evaluationClaimedAt !== undefined &&
      row.evaluationUnavailableAt >= row.evaluationClaimedAt;
    const reason = unavailable ? SCOPE_JUDGEMENT_UNAVAILABLE : EVALUATION_ATTEMPTS_SPENT;
    await ctx.db.patch(row._id, {
      state: 'deferred',
      waitingSince: now,
      verdict: { decision: 'defer', reason, attempts, missingPermissions: [] },
      evaluationClaimedAt: undefined,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.evaluation-parked',
      payload: { workItemId: row._id, attempts, reason },
      createdAt: now,
    });
    parked.add(row._id);
  }
  return parked;
}

async function scheduleEvaluation(ctx: MutationCtx, workItemId: Id<'workItems'>): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.workActions.evaluateWorkItemInternal, { workItemId });
}

/** A step of a row's run that the loop queues and Stop can cancel. */
export type QueuedStep = 'draft' | 'execute' | 'apply';

/**
 * Queue one step of a row's run and record it on the row (`stepJobId`, wave 12; V12-3), so a Stop
 * can cancel it before it starts. One id is kept, the latest: an earlier step still pending is held
 * off by the fences Stop clears. Nothing is queued while the employee or the deployment is paused
 * (`stepMayRun`, 12-P): the row waits in its ready state for the resume's pass or the sweep.
 *
 * @param ctx - The transition's mutation context.
 * @param workItemId - The row.
 * @param step - The draft, the execution or the apply.
 * @param delayMs - How long the step waits before it runs.
 * @returns Whether the step was queued.
 */
export async function queueStep(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  step: QueuedStep,
  delayMs = 0,
): Promise<boolean> {
  const row = await ctx.db.get(workItemId);
  if (row === null || !(await stepMayRun(ctx.db, row.agentId)).mayRun) return false;
  const args = { workItemId };
  const stepJobId =
    step === 'draft'
      ? await ctx.scheduler.runAfter(delayMs, internal.workActions.draftPlanInternal, args)
      : step === 'execute'
        ? await ctx.scheduler.runAfter(
            delayMs,
            internal.workActions.executeApprovedPlanInternal,
            args,
          )
        : await ctx.scheduler.runAfter(delayMs, internal.workActions.applyApprovedActions, args);
  await ctx.db.patch(workItemId, { stepJobId });
  return true;
}

/**
 * How long an apply may go unfinished before the recovery timer acts on it: an
 * approved set whose apply never claimed is rescheduled, and one whose apply
 * claimed has this phase's outcomes recorded unknown and is never replayed.
 */
export const APPLY_RECOVERY_MS = 6 * 60 * 1000;

/**
 * Schedule the apply for the row's current approved set, with its recovery timer.
 *
 * This timer reschedules an apply that never started. An apply that started
 * is covered by the timer its claim arms (`armApplySwitch`), so a start that
 * comes late is measured from the claim, not from here. While the employee or
 * the deployment is paused nothing is scheduled, the timer included, so a held
 * set does not reschedule itself every few minutes; the resume's pass or the
 * sweep schedules it (12-P).
 *
 * @param ctx - Mutation context.
 * @param workItemId - The work item.
 * @param pendingRunId - The run the approval belongs to.
 * @param phase - Which apply phase is scheduled.
 * @returns Whether the apply was scheduled.
 */
export async function scheduleApply(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  pendingRunId: Id<'events'>,
  phase: 'auto' | 'approved',
): Promise<boolean> {
  if (!(await queueStep(ctx, workItemId, 'apply'))) return false;
  await armApplySwitch(ctx, workItemId, pendingRunId, phase);
  return true;
}

/**
 * Arm the apply's dead-man switch: `recoverInterruptedApply` after `APPLY_RECOVERY_MS`.
 *
 * @param ctx - Mutation context.
 * @param workItemId - The work item.
 * @param pendingRunId - The run the approval belongs to.
 * @param phase - Which apply phase the switch guards.
 */
export async function armApplySwitch(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  pendingRunId: Id<'events'>,
  phase: 'auto' | 'approved',
): Promise<void> {
  await ctx.scheduler.runAfter(APPLY_RECOVERY_MS, internal.work.recoverInterruptedApply, {
    workItemId,
    pendingRunId,
    phase,
    fromTimer: true,
  });
}

/** The deferral reason of a row parked because the employee's charter awaits approval. */
export const AWAITING_CHARTER = 'awaiting-charter';

/**
 * Whether the employee's latest charter is a draft awaiting approval, which
 * evaluation refuses to read.
 *
 * An employee with no charter at all has not had its 1:1: none of its
 * surfaces has connected, so intake has seeded nothing for it, and it is not
 * parked here.
 */
async function charterAwaitsApproval(ctx: MutationCtx, agentId: Id<'agents'>): Promise<boolean> {
  const latest = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .first();
  return latest !== null && !latest.approved;
}

/**
 * Park the employee's waiting rows until its charter is approved.
 *
 * Evaluation refuses without an approved charter, after taking its claim, so
 * a row handed to it would throw once a lease for as long as the charter
 * waits, with nothing on the card or in the feed. Each waiting row is
 * deferred as `awaiting-charter` with a `work.waiting-for-charter` event
 * instead; the approval's `charter` re-evaluation returns it to the queue.
 *
 * Returns:
 *   How many rows were parked.
 */
async function parkForCharter(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<number> {
  let parked = 0;
  for (const row of await queueWindow(ctx, agentId)) {
    if (holdsLiveStepClaim(row, 'evaluation', now)) continue;
    await ctx.db.patch(row._id, {
      state: 'deferred',
      waitingSince: now,
      verdict: { decision: 'defer', reason: AWAITING_CHARTER, missingPermissions: [] },
      evaluationClaimedAt: undefined,
    });
    await appendEvent(ctx, {
      agentId,
      type: 'work.waiting-for-charter',
      payload: { workItemId: row._id },
      createdAt: now,
    });
    parked += 1;
  }
  return parked;
}

/**
 * Evaluate the queue's next row when the employee has a free slot, or park
 * the queue while the charter waits.
 *
 * Returns:
 *   How many steps were scheduled or rows parked.
 */
async function evaluateNext(ctx: MutationCtx, agentId: Id<'agents'>, now: number): Promise<number> {
  if (await charterAwaitsApproval(ctx, agentId)) return await parkForCharter(ctx, agentId, now);
  const { free, waiting } = await queueState(ctx, agentId, now);
  if (free === 0) return 0;
  // A row whose evaluation died too often is parked on the way, so it never
  // takes the slot it would otherwise be given again.
  const parked = await parkSpentEvaluations(ctx, waiting, now);
  const next = nextWaitingRow(
    waiting.filter((row) => !parked.has(row._id)),
    now,
  );
  if (!next) return parked.size;
  await scheduleEvaluation(ctx, next._id);
  return parked.size + 1;
}

/**
 * Hand a free slot to the work waiting for one, if the employee has a slot.
 *
 * Called by every transition that may free a slot, and by the autonomy
 * switch, which raises the cap without moving any row. The row it wakes
 * wakes the next one when its own verdict lands, so several free slots fill
 * one after another. Real mode only; a paused employee or deployment wakes
 * nothing (`stepMayRun`).
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 */
export async function wakeQueuedWork(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  if (SURFACE_MODE !== 'real' || !(await stepMayRun(ctx.db, agentId)).mayRun) return;
  await evaluateNext(ctx, agentId, Date.now());
}

/**
 * Schedule what a row needs next, in the transaction that moved it.
 *
 * A row entering `discovered` joins the queue, and the queue's next row is
 * evaluated when the employee has a free slot; entering `claimed` without a
 * plan, drafted; entering `plan-approved`, executed. A row the manager or a
 * running step moves next schedules nothing. Every other transition may have
 * freed a slot or left one free, so the queue's next row is evaluated when
 * the employee is under its cap; that is how waiting work resumes. Scheduling
 * in the same transaction as the move means a crash cannot separate the two;
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
      await wakeQueuedWork(ctx, row.agentId);
      return;
    case 'claimed':
      if (row.plan === undefined) await queueStep(ctx, row._id, 'draft');
      await wakeQueuedWork(ctx, row.agentId);
      return;
    case 'plan-approved':
      await queueStep(ctx, row._id, 'execute');
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

/** Recent events of one type read to count a row's restarts or find its last Retry. */
const RESUME_HISTORY = 200;

/**
 * How many times the sweep already restarted this row's dead draft since the
 * manager last retried it.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The claimed row.
 *
 * Returns:
 *   The restarts counted from the row's latest `work.retry`, or all of them.
 */
async function draftResumesSinceRetry(ctx: MutationCtx, row: Doc<'workItems'>): Promise<number> {
  const forRow = async (type: EventType): Promise<Doc<'events'>[]> =>
    (await eventsOfType(ctx, row.agentId, type).order('desc').take(RESUME_HISTORY)).filter(
      (event) => (event.payload as { workItemId?: unknown }).workItemId === row._id,
    );
  const [resumes, retries] = await Promise.all([forRow(DRAFT_RESUMED), forRow('work.retry')]);
  const since = retries[0]?.createdAt ?? Number.NEGATIVE_INFINITY;
  return resumes.filter((event) => event.createdAt > since).length;
}

/**
 * Restart a draft that died holding its claim, or stop the row once the
 * restarts are spent.
 *
 * A row whose draft never claimed it is only waiting in the scheduler and is
 * restarted without counting.
 *
 * Returns:
 *   True when a step was scheduled.
 */
async function resumeDraft(ctx: MutationCtx, row: Doc<'workItems'>, now: number): Promise<boolean> {
  if (row.draftClaimedAt !== undefined) {
    const resumed = await draftResumesSinceRetry(ctx, row);
    if (resumed >= MAX_DRAFT_RESUMES) {
      // The dead draft's claim rides with the stop, so a Stop and Retry before the job runs
      // leave the new draft's row alone (W12-R7; 12-J's fence).
      await ctx.scheduler.runAfter(0, internal.workRuns.setFailed, {
        workItemId: row._id,
        reason: `the plan draft died ${resumed + 1} times without an answer; Retry drafts it again`,
        stopped: true,
        draftClaimedAt: row.draftClaimedAt,
      });
      return true;
    }
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: DRAFT_RESUMED,
      payload: { workItemId: row._id, attempt: resumed + 1 },
      createdAt: now,
    });
  }
  await queueStep(ctx, row._id, 'draft');
  return true;
}

/**
 * Whether the step recorded on the row (`stepJobId`) is still waiting in the scheduler or
 * running, so the sweep leaves it to run rather than queue a second.
 *
 * @param ctx - Mutation context.
 * @param row - The row whose recorded step is read.
 */
async function recordedStepPending(ctx: MutationCtx, row: Doc<'workItems'>): Promise<boolean> {
  if (row.stepJobId === undefined) return false;
  const job = await ctx.db.system.get(row.stepJobId);
  return job !== null && (job.state.kind === 'pending' || job.state.kind === 'inProgress');
}

/**
 * Schedule again the apply of each approved set, or each run's auto phase, whose apply a pause
 * refused at its claim (12-P): no apply attempt on the row and the apply recorded on it
 * (`stepJobId`) no longer waiting or running, so a set whose apply is still queued is left to it
 * and never doubled. At most `SWEEP_BATCH` rows of each state.
 *
 * @param ctx - Mutation context.
 * @param agentId - The employee, which may run steps now (`stepMayRun`).
 * @returns How many applies were scheduled.
 */
async function resumeHeldApplies(ctx: MutationCtx, agentId: Id<'agents'>): Promise<number> {
  let scheduled = 0;
  for (const [state, phase] of [
    ['actions-pending', 'approved'],
    ['executing', 'auto'],
  ] as const) {
    let read = 0;
    for await (const row of ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))) {
      if (++read > SWEEP_BATCH) break;
      if (
        isRevocationTrialRow(row) ||
        row.pendingRunId === undefined ||
        row.approvedIndexes === undefined ||
        row.applyAttemptId !== undefined ||
        (phase === 'auto' && row.applyPhase !== 'auto') ||
        (await recordedStepPending(ctx, row))
      ) {
        continue;
      }
      if (await scheduleApply(ctx, row._id, row.pendingRunId, phase)) scheduled += 1;
    }
  }
  return scheduled;
}

/**
 * The employees one transaction of the stalled-step sweep reads (W12-R33): each employee's pass
 * reads up to a batch of rows in each of its ready states, so a deployment's every employee in
 * one transaction grows past what a transaction may read as employees are added.
 */
export const STALLED_SWEEP_AGENTS = 50;

/**
 * Reschedule every step the loop lost, for every employee: one pass of
 * {@link resumeAgentStepsInTransaction} each, a page of employees a transaction. When employees
 * are left after the page, the rest are handed to `workLoop:resumeStalledStepsAfter` in a
 * transaction of its own, so the sweep's reads are bounded however many employees the deployment
 * holds. The pages follow the table's own cursor, so two employees created in one instant (an
 * import that kept its times) are each swept once.
 *
 * @param ctx - Mutation context.
 * @param now - The instant to judge claims against.
 * @param cursor - Where the page before this one ended; null at the start.
 * @returns How many steps this transaction scheduled.
 */
export async function resumeStalledStepsInTransaction(
  ctx: MutationCtx,
  now: number,
  cursor: string | null = null,
): Promise<{ rescheduled: number }> {
  if (SURFACE_MODE !== 'real') return { rescheduled: 0 };
  const page = await ctx.db.query('agents').paginate({ numItems: STALLED_SWEEP_AGENTS, cursor });
  let rescheduled = 0;
  for (const agent of page.page) {
    rescheduled += await resumeAgentStepsInTransaction(ctx, agent._id, now);
  }
  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.workLoop.resumeStalledStepsAfter, {
      cursor: page.continueCursor,
    });
  }
  return { rescheduled };
}

/**
 * The stalled-step sweep's next page of employees; see {@link resumeStalledStepsInTransaction}.
 * Internal: scheduled by the page before it, never by a client. Writes what the sweep writes: a
 * queued step on each row it reschedules.
 */
export const resumeStalledStepsAfter = internalMutation({
  args: { cursor: v.string() },
  handler: async (ctx, args): Promise<{ rescheduled: number }> =>
    await resumeStalledStepsInTransaction(ctx, Date.now(), args.cursor),
});

/**
 * Reschedule every step the loop lost, or a pause held, for one employee.
 *
 * Scheduling shares the transaction of each transition, so what is lost is
 * a step that ran and died: an action killed at its time limit, a model call
 * that threw, a backend restarted mid-run. Such a step holds its claim until
 * the lease passes, so a live run is never doubled. A ready row with no live
 * claim gets its step again: a claimed row without a plan is drafted, an
 * approved plan is executed. A row that is ready but has no claim at all may
 * only be waiting in the scheduler; the claim or the state check turns the
 * duplicate into a few reads. The waiting queue is not walked: when the
 * employee has a free slot, the queue's next row gets it, which also resumes
 * an evaluation that died once its lease has passed and recovers a wake-up
 * lost with a step that died after freeing the slot.
 *
 * A step a pause held (12-P) is ready in the same way, and is queued again
 * here: the claimed row and the approved plan as above, and an approved set,
 * or a run's auto phase, whose apply was refused at its claim
 * ({@link resumeHeldApplies}). The resume runs this pass for
 * its employee in its own transaction; the sweep runs it for every employee,
 * which is how a step the deployment's pause held goes on once the jobs run.
 *
 * An employee whose handover is finishing (`accepting`, decision D18), or that
 * is paused, or on a deployment whose jobs are paused (`stepMayRun`), has
 * nothing resumed: no draft, no approved plan, no apply, no decision request
 * and no evaluation starts for it. Its stalled runs are still stopped, which
 * ends them for a handover's move sooner than its deadline would.
 *
 * @param ctx - Mutation context.
 * @param agentId - The employee.
 * @param now - The instant to judge claims against.
 * @returns How many steps were scheduled.
 */
export async function resumeAgentStepsInTransaction(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<number> {
  if (SURFACE_MODE !== 'real') return 0;
  let rescheduled = 0;
  const resumes =
    !(await isBeingHandedOver(ctx.db, agentId)) && (await stepMayRun(ctx.db, agentId)).mayRun;
  const ready = async (
    state: 'claimed' | 'plan-approved' | 'plan-pending' | 'executing' | 'actions-pending',
    eligible: (row: Doc<'workItems'>) => boolean | Promise<boolean>,
  ) => {
    const rows: Doc<'workItems'>[] = [];
    for await (const row of ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))) {
      if (isRevocationTrialRow(row) || !(await eligible(row))) continue;
      rows.push(row);
      if (rows.length === SWEEP_BATCH) break;
    }
    return rows;
  };
  // A finishing handover's or a paused employee's stalled runs are stopped and nothing resumed.
  const resumable: typeof ready = async (state, eligible) =>
    resumes ? await ready(state, eligible) : [];
  for (const row of await resumable(
    'claimed',
    (row) => row.plan === undefined && !holdsLiveStepClaim(row, 'draft', now),
  )) {
    if (await resumeDraft(ctx, row, now)) rescheduled += 1;
  }
  for (const row of await resumable('plan-approved', () => true)) {
    await queueStep(ctx, row._id, 'execute');
    rescheduled += 1;
  }
  for (const row of await resumable(
    'plan-pending',
    (row) =>
      !row.decision &&
      (row.planPendingAt === undefined || now - row.planPendingAt >= STEP_LEASE_MS),
  )) {
    await ctx.scheduler.runAfter(0, internal.work.decidePlan, {
      workItemId: row._id,
      recovery: true,
    });
    rescheduled += 1;
  }
  if (resumes) rescheduled += await resumeHeldApplies(ctx, agentId);
  // A skill's authoring and a system's orientation a pause held go on with the steps (D-8 (b)).
  if (resumes) rescheduled += await resumeHeldStartsInTransaction(ctx, agentId);
  // A charter check a pause held left its agreements held for the employee: checked now (15-FX).
  if (resumes) rescheduled += await scheduleDueHoldChecks(ctx, agentId, now);
  for (const row of await ready('executing', async (row) => {
    if (
      !row.executionRunId ||
      row.pendingRunId ||
      row.applyAttemptId ||
      row.applyClaimedAt ||
      row.applyPhase
    )
      return false;
    const claim = await ctx.db.get(row.executionRunId);
    return !!claim && now - claim.createdAt >= EXECUTION_STALL_MS;
  })) {
    // A closing phase whose authoring never claimed the run keeps its
    // landed prerequisites: it is failed so Retry resumes it, not as a stop.
    const runId = row.executionRunId;
    if (runId && (row.output as { phase?: unknown } | undefined)?.phase === 'dependent-authoring') {
      await ctx.scheduler.runAfter(0, internal.work.recoverDependentAuthoring, {
        workItemId: row._id,
        runId,
      });
      rescheduled += 1;
      continue;
    }
    await ctx.scheduler.runAfter(0, internal.workRuns.setFailed, {
      workItemId: row._id,
      runId: row.executionRunId,
      reason: 'execution interrupted before the exact-action gate',
      stopped: true,
      onlyIfStalled: true,
    });
    rescheduled += 1;
  }
  // A held set parked while no manager channel existed was never asked
  // about; once a channel is back the request goes out. `prepareDecisionRequest`
  // claims it, so a request already on its way is not doubled.
  const channel = (
    await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .collect()
  ).some(isManagerChannel);
  if (channel) {
    for (const row of await resumable('actions-pending', async (row) => {
      if (row.decision || row.approvedIndexes !== undefined || !row.pendingRunId) return false;
      // A set with nothing held has nothing to ask about; the request would
      // refuse it and the next sweep would ask again.
      const count = (row.output as { actions?: unknown[] } | undefined)?.actions?.length ?? 0;
      const held = Array.from({ length: count }, (_, index) =>
        normaliseActionVerdict(row.actionVerdicts?.[index] ?? {}),
      ).some((verdict) => verdict.disposition === 'held');
      if (!held) return false;
      const parked = await ctx.db.get(row.pendingRunId);
      return !!parked && now - parked.createdAt >= STEP_LEASE_MS;
    })) {
      await ctx.scheduler.runAfter(0, internal.managerChannelActions.requestDecision, {
        workItemId: row._id,
        kind: 'actions',
      });
      rescheduled += 1;
    }
  }
  if (resumes) rescheduled += await evaluateNext(ctx, agentId, now);
  return rescheduled;
}

/**
 * How long a claim on one of the manager channel's sends or edits is honoured (N-3): longer than a
 * Convex action's ten-minute limit, so a claim this old with no result belongs to an action that
 * died between its claim and its record.
 */
export const MANAGER_CLAIM_LEASE_MS = 15 * 60 * 1000;

/** The failure a lapsed claim is recorded with (wave 12, 12-W; a wording draft). */
export const MANAGER_CLAIM_LAPSED_REASON =
  'the send stopped before it recorded a result, so it is not known whether Slack took it';

/** Lapsed claims read per employee and kind at a time; the rest are read once these are settled. */
const LEASE_BATCH = 50;

/**
 * Lapsed claims on work items read per employee and kind at a time: fewer than
 * {@link LEASE_BATCH}, since such a row carries its run's output and is read and rewritten whole.
 */
const WORK_ITEM_LEASE_BATCH = 10;

/**
 * Documents one transaction of the lapsed-claims sweep writes at most (W16-R31): a page was 50
 * employees, five claim kinds and 50 claims a kind, up to 12,500 patches in one mutation, which
 * past the transaction's write limit rolled back and started at the same page on every run.
 */
export const SETTLE_WRITES_PER_SWEEP = 500;

/**
 * Bytes of rows one transaction of the sweep rewrites at most, a quarter of what a transaction
 * may write: a settled claim's row is written whole, and a work item's holds its run's output.
 */
export const SETTLE_BYTES_PER_SWEEP = 4 * 1024 * 1024;

/** The most bytes one document holds (Convex's limit): what a work item not yet read may weigh. */
export const ROW_BYTES_AT_MOST = 1024 * 1024;

/** What one transaction of the sweep may still write, counted as it writes. */
interface SweepRoom {
  /** Whether another document may be written. */
  readonly open: () => boolean;
  /**
   * The most rows a read of `batch` may take, so a read is never larger than what may be written:
   * none once the room is spent, and for rows that may each weigh `rowBytesAtMost` no more than
   * fit the bytes left, one at the least.
   */
  readonly rows: (batch: number, rowBytesAtMost?: number) => number;
  /** Count one document written, of the size given. */
  readonly spend: (bytes: number) => void;
}

/** A transaction's room at its start: {@link SETTLE_WRITES_PER_SWEEP} and {@link SETTLE_BYTES_PER_SWEEP}. */
function sweepRoom(): SweepRoom {
  let writes = SETTLE_WRITES_PER_SWEEP;
  let bytes = SETTLE_BYTES_PER_SWEEP;
  const open = (): boolean => writes > 0 && bytes > 0;
  return {
    open,
    rows: (batch, rowBytesAtMost) => {
      if (!open()) return 0;
      const fitting =
        rowBytesAtMost === undefined ? batch : Math.max(1, Math.floor(bytes / rowBytesAtMost));
      return Math.min(batch, writes, fitting);
    },
    spend: (written) => {
      writes -= 1;
      bytes -= written;
    },
  };
}

/**
 * The digest sends one sweep looks behind, newest first. A digest's claim lapses fifteen minutes
 * after it is taken and the sweep runs every five, while a digest goes out at most every fifteen
 * in digest mode (`DIGEST_MIN_GAP_MS`) and at the digest job's own turn otherwise, so a send that
 * died is met by the sweep long before ten newer ones stand in front of it. A pause holds both
 * jobs; only a sweep that failed at every turn while ten more digests went out would miss one.
 */
const LAPSED_DIGESTS_READ = 10;

/**
 * The notes of an employee's recent digest sends whose claim lapsed with nothing recorded: no
 * delivery, no failure, not set aside (W17-R22, with K-4 (a)). Each digest's notes are read by
 * `by_agent_digest`, so a per-run note, which is its own switch's, is never read here. A digest's
 * notes share one outcome (`work.recordManagerDigest` marks them all delivered or releases them
 * all, and a released note leaves the index), so one note says whether the send died holding
 * them, and only such a digest's notes are read further, the other predicates filtering one
 * digest's notes. Before this read the sweep filtered every open claim on `digestId`, and so read
 * every stuck per-run note at every sweep to find the digest's behind them.
 *
 * @param ctx - The sweep's mutation context.
 * @param agentId - The employee.
 * @param before - The instant a claim taken earlier has lapsed by.
 */
function lapsedDigestNotes(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  before: number,
): { take: (count: number) => Promise<Doc<'managerNotes'>[]> } {
  const lapsedOpen = (note: Doc<'managerNotes'>): boolean =>
    note.providerTs === undefined &&
    note.failure === undefined &&
    note.discardedAt === undefined &&
    (note.claimedAt ?? 0) > 0 &&
    (note.claimedAt ?? 0) < before;
  return {
    take: async (count) => {
      const digests = await eventsOfType(ctx, agentId, 'work.manager-digest-sending')
        .order('desc')
        .take(LAPSED_DIGESTS_READ);
      const notes: Doc<'managerNotes'>[] = [];
      for (const digest of digests) {
        if (notes.length >= count) break;
        const ofDigest = () =>
          ctx.db
            .query('managerNotes')
            .withIndex('by_agent_digest', (q) =>
              q.eq('agentId', agentId).eq('digestId', digest._id),
            );
        const first = await ofDigest().first();
        if (first === null || !lapsedOpen(first)) continue;
        notes.push(
          ...(await ofDigest()
            .filter((q) =>
              q.and(
                q.eq(q.field('providerTs'), undefined),
                q.eq(q.field('failure'), undefined),
                q.eq(q.field('discardedAt'), undefined),
                q.gt(q.field('claimedAt'), 0),
                q.lt(q.field('claimedAt'), before),
              ),
            )
            .take(count - notes.length)),
        );
      }
      return notes;
    },
  };
}

/** What settling one employee's lapsed claims came to. */
interface SettledClaims {
  /** How many claims were settled. */
  readonly settled: number;
  /** Whether a read came back as full as it was allowed to be, so more may stand behind it. */
  readonly more: boolean;
}

/**
 * Settle every manager-channel claim an action died holding (N-3), for one employee, as the
 * claim's own failure path would have: a digest's notes are released for the next digest with
 * the reason and a `work.manager-digest-failed` event (`recordManagerDigest`); a decision
 * acknowledgement, a duplicate-reply notice, the edit that closes a decided request (12-M writes
 * `closedAt` and `closeFailure`; the contract is in 12-W's handover) and a replaced request's one
 * edit record the failure and are not sent again, since the message may have landed. A per-run
 * note is left to its own switch (`work.recoverUnsentManagerNote`) and is not among the notes
 * read, so it cannot stand in a digest's note's place. Each read is the open claims
 * older than the lease on its index, so a claim with a result is never read, and each is taken
 * in its turn and no larger than the transaction's room, so a kind is read only while there is
 * room to settle it (W16-R31); a work item, which carries its run's output, is read no more at a
 * time than fit the bytes left at a document's largest size.
 *
 * @param ctx - The sweep's mutation context.
 * @param agentId - The employee.
 * @param now - The instant the lease is judged against.
 * @param room - What the sweep's transaction may still write; spent here as each claim settles.
 * @returns How many claims were settled, and whether a read came back full.
 */
async function settleLapsedManagerClaims(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
  room: SweepRoom,
): Promise<SettledClaims> {
  const before = now - MANAGER_CLAIM_LEASE_MS;
  const failure = MANAGER_CLAIM_LAPSED_REASON;
  let settled = 0;
  let more = false;
  /** The lapsed claims of one kind, as many as the room allows; none, and no read, once it is spent. */
  const lapsed = async <Row>(
    claims: { take: (count: number) => Promise<Row[]> },
    batch: number,
    rowBytesAtMost?: number,
  ): Promise<Row[]> => {
    const count = room.rows(batch, rowBytesAtMost);
    if (count === 0) return [];
    const rows = await claims.take(count);
    more ||= rows.length === count;
    return rows;
  };
  /** Settle the rows of one kind while the transaction has room, each counted as it is written. */
  const settle = async <Row extends { _id: string }>(
    rows: readonly Row[],
    write: (row: Row) => Promise<number>,
  ): Promise<Row[]> => {
    const written: Row[] = [];
    for (const row of rows) {
      if (!room.open()) break;
      room.spend(await write(row));
      written.push(row);
    }
    settled += written.length;
    return written;
  };

  const notes = await lapsed(lapsedDigestNotes(ctx, agentId, before), LEASE_BATCH);
  const released = await settle(notes, async (note) => {
    await ctx.db.patch(note._id, { claimedAt: undefined, digestId: undefined, failure });
    return getDocumentSize(note);
  });
  if (released.length > 0) {
    const payload = { noteIds: released.map((note) => note._id), reason: failure };
    await appendEvent(ctx, {
      agentId,
      type: 'work.manager-digest-failed',
      payload,
      createdAt: now,
    });
    room.spend(getConvexSize(payload));
  }

  const notices = await lapsed(
    ctx.db
      .query('managerDecisionNotices')
      .withIndex('by_agent_claim_open', (q) =>
        q
          .eq('agentId', agentId)
          .eq('providerTs', undefined)
          .eq('failure', undefined)
          .gt('claimedAt', 0)
          .lt('claimedAt', before),
      ),
    LEASE_BATCH,
  );
  await settle(notices, async (notice) => {
    await ctx.db.patch(notice._id, { failure });
    return getDocumentSize(notice);
  });

  // One row can hold both claims, so each patch merges into the decision as this transaction
  // last wrote it, kept here so the row is not read a second time.
  const decisions = new Map<Id<'workItems'>, NonNullable<Doc<'workItems'>['decision']>>();
  const settleDecision =
    (field: 'duplicateNoticeFailure' | 'closeFailure') =>
    async (row: Doc<'workItems'>): Promise<number> => {
      const decision = decisions.get(row._id) ?? row.decision;
      if (decision === undefined) return 0;
      const next = { ...decision, [field]: failure };
      decisions.set(row._id, next);
      await ctx.db.patch(row._id, { decision: next });
      return getDocumentSize(row);
    };
  const duplicates = await lapsed(
    ctx.db
      .query('workItems')
      .withIndex('by_agent_duplicate_notice_open', (q) =>
        q
          .eq('agentId', agentId)
          .eq('decision.duplicateNoticeTs', undefined)
          .eq('decision.duplicateNoticeFailure', undefined)
          .gt('decision.duplicateNoticeClaimedAt', 0)
          .lt('decision.duplicateNoticeClaimedAt', before),
      ),
    WORK_ITEM_LEASE_BATCH,
    ROW_BYTES_AT_MOST,
  );
  await settle(duplicates, settleDecision('duplicateNoticeFailure'));
  const closes = await lapsed(
    ctx.db
      .query('workItems')
      .withIndex('by_agent_close_open', (q) =>
        q
          .eq('agentId', agentId)
          .eq('decision.closedAt', undefined)
          .eq('decision.closeFailure', undefined)
          .gt('decision.closeClaimedAt', 0)
          .lt('decision.closeClaimedAt', before),
      ),
    WORK_ITEM_LEASE_BATCH,
    ROW_BYTES_AT_MOST,
  );
  await settle(closes, settleDecision('closeFailure'));

  const edits = await lapsed(
    ctx.db
      .query('replacedDecisionRequests')
      .withIndex('by_agent_edit_open', (q) =>
        q
          .eq('agentId', agentId)
          .eq('editedAt', undefined)
          .eq('editFailure', undefined)
          .gt('editClaimedAt', 0)
          .lt('editClaimedAt', before),
      ),
    LEASE_BATCH,
  );
  await settle(edits, async (edit) => {
    await ctx.db.patch(edit._id, { editFailure: failure });
    return getDocumentSize(edit);
  });
  return { settled, more };
}

/**
 * Employees one transaction of the lapsed-claims sweep reads, five claim reads each (W15-R16: the
 * sweep read every employee in one transaction); the next page is its own transaction.
 */
export const SETTLE_AGENTS_PER_SWEEP = 50;

/**
 * Settle the manager-channel claims every employee's actions died holding (N-3); see
 * `settleLapsedManagerClaims`. Internal; its own five-minute job (`convex/crons.ts`) in either mode,
 * a transaction apart from the stalled-step sweep, so its reads never roll that sweep back. Each
 * transaction reads a page of {@link SETTLE_AGENTS_PER_SWEEP} employees, writes at most
 * {@link SETTLE_WRITES_PER_SWEEP} documents and {@link SETTLE_BYTES_PER_SWEEP} of rows, and
 * schedules the next: the same page again when its room ran out, or when a read came back full
 * and something was settled, since a settled claim is no longer read and the page's rest is found
 * there; the next page from where it stopped otherwise (W16-R31). A pass of a page that settles
 * nothing schedules no second pass of it, so a read that comes back full of claims it leaves
 * does not keep it running.
 *
 * @param cursor - Where the previous page stopped; absent, the sweep starts at the first employee.
 * @returns How many claims this transaction settled.
 */
export const settleLapsedClaims = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ settled: number }> => {
    const now = Date.now();
    const page = await ctx.db
      .query('agents')
      .paginate({ cursor: args.cursor ?? null, numItems: SETTLE_AGENTS_PER_SWEEP });
    const room = sweepRoom();
    let settled = 0;
    let more = false;
    for (const agent of page.page) {
      if (!room.open()) break;
      const one = await settleLapsedManagerClaims(ctx, agent._id, now, room);
      settled += one.settled;
      more ||= one.more;
    }
    if (!room.open() || (more && settled > 0)) {
      await ctx.scheduler.runAfter(
        0,
        internal.workLoop.settleLapsedClaims,
        args.cursor === undefined ? {} : { cursor: args.cursor },
      );
    } else if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.workLoop.settleLapsedClaims, {
        cursor: page.continueCursor,
      });
    }
    return { settled };
  },
});

/** How often one employee's work surfaces may be polled on demand. */
export const CHECK_FOR_WORK_INTERVAL_MS = 60_000;

/** The event that records an on-demand poll; the interval is read from it. */
const CHECK_REQUESTED = 'work.check-requested' satisfies EventType;

/** Surface classes the intake sweep has a work reader for. */
const WORK_SURFACE_CLASSES = new Set(['kanban', 'chat']);

/**
 * Poll the employee's connected work surfaces now, at most once a minute.
 *
 * The five-minute intake cron stays the steady state; this is the
 * dashboard's "Check for new work", so a ticket just filed or an ask just
 * posted is discovered within a minute instead of at the next sweep. What
 * it finds is seeded and evaluated like anything the cron finds, and a parked
 * row whose wait is already over is re-admitted (`readmitSatisfiedDeferrals`,
 * scheduled by name because `work.ts` imports this module). Each check
 * is an event, which is also what the interval is measured from.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The employee.
 *
 * Returns:
 *   How many surfaces were scheduled for a poll, and, when the last check
 *   was under a minute ago, how long until the next is allowed.
 */
export const checkForNewWork = mutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ scheduled: number; retryInMs?: number }> => {
    await getCallerOrThrow(ctx);
    assertRealMode('Checking for new work');
    const agent = await assertOwnsAgent(ctx, args.agentId);
    // A paused employee's intake reads nothing, so a check would spend its minute and find nothing
    // (W12-R29): it is refused in words and the minute is kept.
    if (isPaused(agent)) throw new ConvexError(pausedCheckRefusal(agent.name));
    const now = Date.now();
    const since = now - CHECK_FOR_WORK_INTERVAL_MS;
    const lastCheck = await eventsOfType(ctx, args.agentId, CHECK_REQUESTED, { after: since })
      .order('desc')
      .first();
    if (lastCheck && lastCheck.createdAt > since) {
      return { scheduled: 0, retryInMs: lastCheck.createdAt + CHECK_FOR_WORK_INTERVAL_MS - now };
    }
    const surfaces = (
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect()
    ).filter(
      (surface) => surface.verdict === 'connected' && WORK_SURFACE_CLASSES.has(surface.class),
    );
    for (const surface of surfaces) {
      await ctx.scheduler.runAfter(0, internal.intakeActions.pollSurface, {
        surfaceId: surface._id,
      });
    }
    // The work already here is checked too: a row parked on a connection, a
    // grant or a skill that has since landed goes back to be evaluated.
    await ctx.scheduler.runAfter(0, internal.work.readmitSatisfiedDeferrals, {
      agentId: args.agentId,
    });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: CHECK_REQUESTED,
      payload: { surfaceIds: surfaces.map((surface) => surface._id) },
      createdAt: now,
    });
    return { scheduled: surfaces.length };
  },
});

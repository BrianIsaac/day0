import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalQuery, mutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { assertOwnsAgent } from './ownership';
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

import { appendEvent } from './eventLog';

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
const DRAFT_RESUMED = 'work.draft-resumed';

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
 * one after another. Real mode only.
 *
 * Args:
 *   ctx: Mutation context.
 *   agentId: The employee.
 */
export async function wakeQueuedWork(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
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
  const forRow = async (type: string): Promise<Doc<'events'>[]> =>
    (
      await ctx.db
        .query('events')
        .withIndex('by_agent_type', (q) => q.eq('agentId', row.agentId).eq('type', type))
        .order('desc')
        .take(RESUME_HISTORY)
    ).filter((event) => (event.payload as { workItemId?: unknown }).workItemId === row._id);
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
      await ctx.scheduler.runAfter(0, internal.work.setFailed, {
        workItemId: row._id,
        reason: `the plan draft died ${resumed + 1} times without an answer; Retry drafts it again`,
        stopped: true,
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
  await ctx.scheduler.runAfter(0, internal.workActions.draftPlanInternal, { workItemId: row._id });
  return true;
}

/**
 * Reschedule every step the loop lost, for every employee.
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
    const ready = async (
      state: 'claimed' | 'plan-approved' | 'plan-pending' | 'executing' | 'actions-pending',
      eligible: (row: Doc<'workItems'>) => boolean | Promise<boolean>,
    ) => {
      const rows: Doc<'workItems'>[] = [];
      for await (const row of ctx.db
        .query('workItems')
        .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id).eq('state', state))) {
        if (isRevocationTrialRow(row) || !(await eligible(row))) continue;
        rows.push(row);
        if (rows.length === SWEEP_BATCH) break;
      }
      return rows;
    };
    for (const row of await ready(
      'claimed',
      (row) => row.plan === undefined && !holdsLiveStepClaim(row, 'draft', now),
    )) {
      if (await resumeDraft(ctx, row, now)) rescheduled += 1;
    }
    for (const row of await ready('plan-approved', () => true)) {
      await ctx.scheduler.runAfter(0, internal.workActions.executeApprovedPlanInternal, {
        workItemId: row._id,
      });
      rescheduled += 1;
    }
    for (const row of await ready(
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
      if (
        runId &&
        (row.output as { phase?: unknown } | undefined)?.phase === 'dependent-authoring'
      ) {
        await ctx.scheduler.runAfter(0, internal.work.recoverDependentAuthoring, {
          workItemId: row._id,
          runId,
        });
        rescheduled += 1;
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.work.setFailed, {
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
        .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
        .collect()
    ).some(isManagerChannel);
    if (channel) {
      for (const row of await ready('actions-pending', async (row) => {
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
    rescheduled += await evaluateNext(ctx, agent._id, now);
  }
  return { rescheduled };
}

/** How often one employee's work surfaces may be polled on demand. */
export const CHECK_FOR_WORK_INTERVAL_MS = 60_000;

/** The event that records an on-demand poll; the interval is read from it. */
const CHECK_REQUESTED = 'work.check-requested';

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
    assertRealMode('Checking for new work');
    await assertOwnsAgent(ctx, args.agentId);
    const now = Date.now();
    const since = now - CHECK_FOR_WORK_INTERVAL_MS;
    const lastCheck = (
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId).gt('_creationTime', since))
        .collect()
    )
      .filter((event) => event.type === CHECK_REQUESTED && event.createdAt > since)
      .at(-1);
    if (lastCheck) {
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

import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsWorkItem } from './ownership';
import { actionIdempotencyKey } from '../src/work/idempotency';
import {
  HELD_NOT_APPROVED,
  normaliseActionVerdict,
  reviewActions,
  type ActionVerdict,
} from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import type { AppliedAction } from '../src/surfaces/types';
import { autonomousActionsOn } from '../src/work/autonomy';
import type { MockAction } from '../src/work/types';

export const APPLY_RECOVERY_MS = 6 * 60 * 1000;
export const INTERRUPTED_APPLY_REASON =
  'apply was interrupted after its claim; provider outcomes are unknown and must be reconciled before retry';

/**
 * Read the authority and connection state used at the provider boundary.
 *
 * The agent, grants and one surface are read in one transaction so an action
 * cannot combine a switch value from one revision with grants or a connection
 * from another.
 */
export const transportAuthority = internalQuery({
  args: { agentId: v.id('agents'), surfaceSlug: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { agentExists: false }
    | {
        agentExists: true;
        autonomousActions: boolean;
        grants: string[];
        surface?: ReturnType<typeof toSurfaceRecord>;
      }
  > => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return { agentExists: false };
    const [surface, grants] = await Promise.all([
      ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', args.agentId).eq('slug', args.surfaceSlug),
        )
        .first(),
      ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId))
        .collect(),
    ]);
    return {
      agentExists: true,
      autonomousActions: autonomousActionsOn(agent),
      grants: grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope),
      ...(surface ? { surface: toSurfaceRecord(surface) } : {}),
    };
  },
});

/**
 * Work items CRUD + state transitions. Public surfaces enforce
 * per-account ownership; internal transitions called by actions/scheduler
 * skip the check.
 *
 * State machine:
 *   discovered → claimed → plan-pending → plan-approved → executing
 *                                                       ↓
 *                                                   completed | failed
 *
 *   discovered → skipped | deferred | needs-skill
 *   plan-pending → cancelled
 *
 * Real mode adds the exact-action gate between the skill run and apply:
 *   executing → actions-pending → (approve) executing → completed | failed
 *                               → (reject)  failed
 * The run id minted by `claimForExecution` is kept on the row through the
 * gate, so approval applies with the same idempotency keys the run would have
 * used had it not paused.
 *
 * The gate runs in two phases over the same claim and apply path. Rows it
 * classifies `auto` (reads and the manager DM; every non-refused row once
 * the manager has turned autonomous actions on) are applied straight from
 * the hold while the row is still `executing` (`applyPhase: 'auto'`); when
 * the run also has `held` rows it then parks at `actions-pending` with the
 * auto rows already in the ledger, and the manager's approval runs the
 * second phase (`applyPhase: 'approved'`). A run with no held row never
 * enters `actions-pending`; a run with no auto row parks at once.
 */

/**
 * A skill id may only be attached to a work item belonging to the same agent.
 * The public actions derive the agent from the work item, so a mismatch here
 * means an internal caller has crossed two agents' contexts, not that a boss
 * pressed the wrong button.
 */
async function assertSameAgent(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  skillId: Id<'skills'>,
): Promise<{ item: Doc<'workItems'>; skill: Doc<'skills'> }> {
  const item = await ctx.db.get(workItemId);
  if (!item) throw new Error('workItem not found');
  const skill = await ctx.db.get(skillId);
  if (!skill) throw new Error('skill not found');
  if (skill.agentId !== item.agentId) {
    throw new Error('skill and work item belong to different agents');
  }
  return { item, skill };
}

export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'workItems'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .collect();
  },
});

export const get = query({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    return await assertOwnsWorkItem(ctx, args.workItemId);
  },
});

export const seedItem = internalMutation({
  args: {
    agentId: v.id('agents'),
    sourceCategory: v.string(),
    sourceSystem: v.string(),
    externalId: v.string(),
    title: v.string(),
    contentSummary: v.string(),
    contentRefs: v.array(v.string()),
    priority: v.optional(v.string()),
    requesterLabel: v.optional(v.string()),
    replyTarget: v.optional(
      v.object({
        channel: v.string(),
        channelName: v.optional(v.string()),
        threadTs: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<Id<'workItems'>> => {
    const existing = await ctx.db
      .query('workItems')
      .withIndex('by_extId', (q) =>
        q.eq('sourceSystem', args.sourceSystem).eq('externalId', args.externalId),
      )
      .filter((q) => q.eq(q.field('agentId'), args.agentId))
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert('workItems', {
      ...args,
      state: 'discovered',
      observedAt: Date.now(),
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'work.discovered',
      payload: { workItemId: id, title: args.title },
      createdAt: Date.now(),
    });
    return id;
  },
});

/**
 * Record an evaluation verdict and move the row to where it puts it.
 *
 * A plain helper rather than only a mutation, because `skills.completeRegistration`
 * has to requeue the work item that asked for a skill inside the same
 * transaction that registers the skill — a registered, callable skill whose
 * originating work item is still parked at `needs-skill` is a state nothing in
 * the product knows how to leave.
 */
export async function applyVerdict(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  verdict: unknown,
): Promise<void> {
  const row = await ctx.db.get(workItemId);
  if (!row) throw new Error('workItem not found');

  // Late-arriving verdict guard: a verdict is the entry transition from
  // `discovered` (initial evaluation) or `needs-skill` (pending-reevaluation
  // after a skill registers). If the row has already advanced past these —
  // claimed, plan-pending, plan-approved, executing, completed, etc. — a stale
  // verdict must NOT stomp the row's state, which would wipe a drafted plan or
  // running execution. Ignore silently.
  if (row.state !== 'discovered' && row.state !== 'needs-skill') {
    return;
  }

  const decision = (verdict as { decision: string }).decision;
  let nextState: Doc<'workItems'>['state'] = 'discovered';
  let skipReason: string | undefined;
  if (decision === 'claim') nextState = 'claimed';
  else if (decision === 'skip') {
    nextState = 'skipped';
    skipReason = (verdict as { reason?: string }).reason;
  } else if (decision === 'queue') nextState = 'discovered';
  else if (decision === 'defer') nextState = 'deferred';
  else if (decision === 'needs-skill') nextState = 'needs-skill';
  await ctx.db.patch(workItemId, {
    verdict,
    state: nextState,
    ...(skipReason ? { skipReason } : {}),
  });
  await ctx.db.insert('events', {
    agentId: row.agentId,
    type: 'work.evaluated',
    payload: { workItemId, decision, verdict },
    createdAt: Date.now(),
  });
}

export const setVerdict = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    verdict: v.any(),
  },
  handler: async (ctx, args) => {
    await applyVerdict(ctx, args.workItemId, args.verdict);
  },
});

/**
 * Store a drafted plan, if the row is still waiting for one.
 *
 * Same shape as `claimForExecution`: two callers can both read `claimed`
 * before either writes, and the second would otherwise replace a plan the boss
 * may already be reading — with a second plan-drafted event to match. The
 * state check and the write share one transaction, so the second caller is
 * told its draft was not needed.
 */
export const setPlan = internalMutation({
  args: { workItemId: v.id('workItems'), plan: v.any() },
  handler: async (ctx, args): Promise<{ stored: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'claimed') return { stored: false };
    await ctx.db.patch(args.workItemId, { plan: args.plan, state: 'plan-pending' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.plan-drafted',
      payload: { workItemId: args.workItemId, plan: args.plan },
      createdAt: Date.now(),
    });
    return { stored: true };
  },
});

export const approvePlan = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'plan-pending') {
      throw new Error(`workItem state is ${row.state}; expected plan-pending`);
    }
    await ctx.db.patch(args.workItemId, { state: 'plan-approved' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.plan-approved',
      payload: { workItemId: args.workItemId },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

export const retryFailed = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    const recoverable = ['failed', 'skipped', 'cancelled'];
    if (!recoverable.includes(row.state)) {
      throw new Error(`workItem state is ${row.state}; expected one of ${recoverable.join(', ')}`);
    }
    const applied = (
      (row.output ?? {}) as {
        applied?: Array<{ ok?: boolean; held?: boolean; outcomeUnknown?: boolean }>;
      }
    ).applied;
    const landed = applied?.some((entry) => entry.ok === true && entry.held !== true);
    const outcomeUnknown = applied?.some((entry) => entry.outcomeUnknown === true);
    if (row.skipReason === INTERRUPTED_APPLY_REASON || landed || outcomeUnknown) {
      throw new Error(
        'retry refused because an external effect may already have landed; reconcile the provider first',
      );
    }
    const next: Doc<'workItems'>['state'] = row.plan
      ? 'plan-approved'
      : (row.verdict as { decision?: string } | undefined)?.decision === 'claim'
        ? 'claimed'
        : 'discovered';
    await ctx.db.patch(args.workItemId, {
      state: next,
      skipReason: undefined,
      executionRunId: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.retry',
      payload: { workItemId: args.workItemId, resumeState: next, fromState: row.state },
      createdAt: Date.now(),
    });
    return { ok: true, resumeState: next };
  },
});

/** Why a work item is `cancelled` after the manager turned its plan down. */
export const PLAN_CANCELLED_REASON = 'plan cancelled by the manager';

/**
 * Why a work item is `cancelled` after the skill proposed for it was rejected.
 *
 * Args:
 *   skillName: The rejected skill's name.
 *
 * Returns:
 *   The reason the card shows in place of the pre-cancel verdict.
 */
export function skillRejectedReason(skillName: string): string {
  return `skill proposal "${skillName}" rejected by the manager`;
}

export const cancelPlan = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'plan-pending') {
      throw new Error(`workItem state is ${row.state}; expected plan-pending`);
    }
    await ctx.db.patch(args.workItemId, { state: 'cancelled', skipReason: PLAN_CANCELLED_REASON });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.cancelled',
      payload: { workItemId: args.workItemId, reason: PLAN_CANCELLED_REASON },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Take exclusive ownership of an approved work item, or report that somebody
 * else already has it.
 *
 * This is the whole of the concurrency control for execution. A mutation is a
 * transaction, so the state check and the move to `executing` cannot be split
 * by a second caller; an action that reads `plan-approved` and writes
 * `executing` as two calls can be, and both callers then run the skill and
 * apply every action. React Strict Mode plus the dashboard's auto-progress
 * effect supplies that second caller for free in development.
 *
 * The winner gets a `runId` — the id of the claim event, which is durable,
 * unique per claim and derived from nothing the caller controls. Adapter
 * calls key their idempotency off it, so an external effect can be recognised
 * as already-applied if the run is interrupted before its completion lands.
 */
export const claimForExecution = internalMutation({
  args: { workItemId: v.id('workItems'), skillId: v.id('skills') },
  handler: async (
    ctx,
    args,
  ): Promise<
    { claimed: true; runId: Id<'events'> } | { claimed: false; reason: string }
  > => {
    const { item } = await assertSameAgent(ctx, args.workItemId, args.skillId);
    if (item.state !== 'plan-approved') {
      return {
        claimed: false,
        reason:
          item.state === 'executing'
            ? 'another execution already claimed this work item'
            : `workItem state is ${item.state}; expected plan-approved`,
      };
    }
    const runId = await ctx.db.insert('events', {
      agentId: item.agentId,
      type: 'work.execution-claimed',
      payload: { workItemId: args.workItemId, skillId: args.skillId },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.workItemId, {
      state: 'executing',
      skillId: args.skillId,
      executionRunId: runId,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    return { claimed: true, runId };
  },
});

/**
 * Mark a run done, and refuse to when nothing is behind it.
 *
 * The rule — every action the run emitted changed the work environment — was
 * enforced by the caller that happens to run the skill today. That leaves it
 * one caller away from being lost, and it reads as satisfied by a run that
 * emitted no actions at all: vacuously, every action succeeded. `completed`
 * then means "the model finished a turn", which is precisely the state a
 * person cannot tell apart from work that happened.
 *
 * So the rule lives with the write instead. An empty ledger is a bug in the
 * caller rather than an outcome of the work, hence a throw: the action's own
 * error path turns it into a visible `failed` row rather than a silent one.
 */
export const setCompleted = internalMutation({
  args: { workItemId: v.id('workItems'), runId: v.optional(v.id('events')), output: v.any() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (
      row.state !== 'executing' ||
      (args.runId !== undefined && row.executionRunId !== args.runId)
    ) {
      throw new Error('execution run changed before completion');
    }
    const applied = (
      (args.output ?? {}) as { applied?: Array<{ tool: string; ok: boolean; held?: boolean }> }
    ).applied;
    if (!applied || applied.length === 0) {
      throw new Error(
        'cannot complete a work item whose run applied nothing to the work environment',
      );
    }
    // A held row is accounted for: the manager chose not to send it, or the
    // gate held a public post for them, and the ledger says so. It is neither
    // a landed change nor a failure.
    const failed = applied.filter((a) => !a.ok && !a.held);
    if (failed.length > 0) {
      throw new Error(
        `cannot complete a work item with ${failed.length} action(s) that did not change the work environment`,
      );
    }
    await ctx.db.patch(args.workItemId, {
      state: 'completed',
      output: args.output,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      executionRunId: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.completed',
      payload: { workItemId: args.workItemId, output: args.output },
      createdAt: Date.now(),
    });
  },
});

export const setFailed = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    reason: v.string(),
    // Kept when the skill produced a draft the run then failed to apply, so
    // the boss can read what was written before deciding whether to retry.
    output: v.optional(v.any()),
    runId: v.optional(v.id('events')),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (args.runId && row.executionRunId !== args.runId) return;
    // A row that already reached an end state keeps it. Nothing legitimately
    // fails a completed run, and a losing caller must not add a second failure
    // record for a failure the winner already wrote.
    const terminal = ['completed', 'failed', 'cancelled', 'skipped'];
    if (terminal.includes(row.state)) return;
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason: args.reason,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      executionRunId: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      ...(args.output !== undefined ? { output: args.output } : {}),
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.failed',
      payload: { workItemId: args.workItemId, reason: args.reason },
      createdAt: Date.now(),
    });
  },
});

/**
 * Decide, inside the hold transaction, what the gate will do with each action.
 *
 * The surfaces, grants and the agent's autonomous-actions toggle are read in
 * the same transaction that holds the run, so the verdicts describe the run
 * the manager is about to review (or that is about to apply on its own) and
 * a row refused here is refused at approval rather than failing at apply.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item being held.
 *   actions: The actions the skill emitted.
 *
 * Returns:
 *   The verdicts, one per action, and the toggle they were decided under.
 */
async function reviewHeldActions(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  actions: MockAction[],
): Promise<{ verdicts: ActionVerdict[]; autonomousActions: boolean }> {
  const [agent, surfaceRows, grantRows] = await Promise.all([
    ctx.db.get(row.agentId),
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
      .collect(),
    ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId))
      .collect(),
  ]);
  if (!agent) throw new Error('agent not found');
  const grants = new Set(grantRows.filter((grant) => !grant.revokedAt).map((grant) => grant.scope));
  const autonomousActions = autonomousActionsOn(agent);
  return {
    verdicts: reviewActions(
      actions,
      surfaceRows.map((surface) => toSurfaceRecord(surface)),
      grants,
      Date.now(),
      { autonomousActions },
    ),
    autonomousActions,
  };
}

/**
 * The persisted verdicts in the current shape, by action index.
 *
 * Args:
 *   verdicts: The verdicts persisted when the run was held.
 *
 * Returns:
 *   One verdict per index; an index without one reads as `held`.
 */
export function verdictList(
  verdicts: Doc<'workItems'>['actionVerdicts'] | undefined,
  count: number,
): ActionVerdict[] {
  return Array.from({ length: count }, (_, index) =>
    normaliseActionVerdict(verdicts?.[index] ?? {}),
  );
}

function indexesWith(verdicts: readonly ActionVerdict[], disposition: ActionVerdict['disposition']): number[] {
  return verdicts.flatMap((verdict, index) => (verdict.disposition === disposition ? [index] : []));
}

/**
 * The hold-time reasons of a run's refused rows, keyed by action index.
 *
 * Args:
 *   verdicts: The verdicts persisted when the run was held.
 *   count: How many actions the run holds.
 *
 * Returns:
 *   `[index, reason]` pairs for every refused row.
 */
function refusedReasonEntries(
  verdicts: Doc<'workItems'>['actionVerdicts'] | undefined,
  count: number,
): Array<[number, string]> {
  return verdictList(verdicts, count).flatMap((verdict, index): Array<[number, string]> =>
    verdict.disposition === 'refused' ? [[index, verdict.reason]] : [],
  );
}

function actionsOf(output: unknown): unknown[] {
  return ((output ?? {}) as { actions?: unknown[] }).actions ?? [];
}

function ledgerOf(output: unknown): Array<AppliedAction | undefined> {
  return ((output ?? {}) as { applied?: Array<AppliedAction | undefined> }).applied ?? [];
}

/**
 * Schedule the apply for the row's current approved set, with its recovery timer.
 *
 * Args:
 *   ctx: Mutation context.
 *   workItemId: The work item.
 *   pendingRunId: The run the approval belongs to.
 */
async function scheduleApply(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  pendingRunId: Id<'events'>,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.workActions.applyApprovedActions, { workItemId });
  await ctx.scheduler.runAfter(APPLY_RECOVERY_MS, internal.work.recoverInterruptedApply, {
    workItemId,
    pendingRunId,
  });
}

/**
 * Hold an executing run at the exact-action gate and apply what the gate allows.
 *
 * Called by the action that ran the skill, in real mode, instead of applying
 * anything itself. The draft, notes and literal `actions` are persisted with
 * the run id and one verdict per row. Rows the gate classifies `auto` are
 * approved here and applied by the same scheduled path a manager's approval
 * uses, while the row stays `executing`; when nothing is `auto` the row moves
 * to `actions-pending` at once. The hold event records whether autonomous
 * actions were on, so the audit trail shows the mode the verdicts were
 * decided under. Guarded on `executing` so a late caller cannot reopen a run
 * the manager has already decided.
 */
export const setActionsPending = internalMutation({
  args: { workItemId: v.id('workItems'), runId: v.id('events'), output: v.any() },
  handler: async (
    ctx,
    args,
  ): Promise<{ pending: boolean; phase?: 'auto' | 'manager' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'executing') return { pending: false };
    if (row.executionRunId !== args.runId) return { pending: false };
    const actions = (args.output as { actions?: unknown[] }).actions;
    if (!Array.isArray(actions)) throw new Error('output.actions must be a list');
    const { verdicts: actionVerdicts, autonomousActions } = await reviewHeldActions(
      ctx,
      row,
      actions as MockAction[],
    );
    const autoIndexes = indexesWith(actionVerdicts, 'auto');
    const heldIndexes = indexesWith(actionVerdicts, 'held');
    const refusedIndexes = indexesWith(actionVerdicts, 'refused');
    const payload = {
      workItemId: args.workItemId,
      runId: args.runId,
      actionCount: actions.length,
      autoIndexes,
      heldIndexes,
      refusedIndexes,
      autonomousActions,
    };
    if (autoIndexes.length > 0) {
      await ctx.db.patch(args.workItemId, {
        output: args.output,
        pendingRunId: args.runId,
        approvedIndexes: autoIndexes,
        applyPhase: 'auto',
        actionVerdicts,
        applyAttemptId: undefined,
        applyClaimedAt: undefined,
      });
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'work.actions-auto-applying',
        payload,
        createdAt: Date.now(),
      });
      await scheduleApply(ctx, args.workItemId, args.runId);
      return { pending: true, phase: 'auto' };
    }
    await ctx.db.patch(args.workItemId, {
      state: 'actions-pending',
      output: args.output,
      pendingRunId: args.runId,
      approvedIndexes: undefined,
      applyPhase: undefined,
      actionVerdicts,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-pending',
      payload,
      createdAt: Date.now(),
    });
    return { pending: true, phase: 'manager' };
  },
});

/**
 * Park a run whose auto rows have landed until the manager decides the rest.
 *
 * Called by the apply action after the auto phase when held rows remain. The
 * ledger it hands over carries the auto rows as applied and the held rows as
 * awaiting approval; the manager's approval replaces the placeholders. Fenced
 * on the run and on the apply attempt, so a late caller cannot park a run
 * that has moved on.
 */
export const setAwaitingApproval = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    runId: v.id('events'),
    applyAttemptId: v.id('events'),
    output: v.any(),
  },
  handler: async (ctx, args): Promise<{ parked: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (
      row.state !== 'executing' ||
      row.executionRunId !== args.runId ||
      row.applyAttemptId !== args.applyAttemptId ||
      row.applyPhase !== 'auto'
    ) {
      return { parked: false };
    }
    const actions = actionsOf(args.output);
    const verdicts = verdictList(row.actionVerdicts, actions.length);
    await ctx.db.patch(args.workItemId, {
      state: 'actions-pending',
      output: args.output,
      approvedIndexes: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-pending',
      payload: {
        workItemId: args.workItemId,
        runId: args.runId,
        actionCount: actions.length,
        autoIndexes: indexesWith(verdicts, 'auto'),
        heldIndexes: indexesWith(verdicts, 'held'),
        refusedIndexes: indexesWith(verdicts, 'refused'),
        autoApplied: true,
      },
      createdAt: Date.now(),
    });
    return { parked: true };
  },
});

/**
 * Approve some or all of the held actions and schedule their application.
 *
 * The indexes are validated against the persisted list and its verdicts,
 * deduplicated and sorted; an index outside the list is refused rather than
 * ignored, because a stale card must not silently approve a different action
 * than it showed. Only `held` rows can be approved: an `auto` row was applied
 * before the manager saw the card and a `refused` row can never be applied.
 * Approving nothing is allowed and lands nothing: every held row is then
 * recorded as not approved.
 */
export const approveActions = mutation({
  args: {
    workItemId: v.id('workItems'),
    pendingRunId: v.id('events'),
    approvedIndexes: v.array(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: true; approvedIndexes: number[] }> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'actions-pending') {
      throw new Error(`workItem state is ${row.state}; expected actions-pending`);
    }
    if (!row.pendingRunId) throw new Error('workItem has no pending run');
    if (row.pendingRunId !== args.pendingRunId) {
      throw new Error('pending run changed; refresh the action list');
    }
    if (row.approvedIndexes !== undefined) {
      throw new Error('actions have already been approved');
    }
    const actions = actionsOf(row.output);
    const verdicts = verdictList(row.actionVerdicts, actions.length);
    const approvedIndexes = [...new Set(args.approvedIndexes)].sort((a, b) => a - b);
    for (const index of approvedIndexes) {
      if (!Number.isInteger(index) || index < 0 || index >= actions.length) {
        throw new Error(`action index ${index} is outside the pending list`);
      }
      const verdict = verdicts[index];
      if (verdict.disposition === 'refused') {
        throw new Error(
          `action ${index + 1} is refused (${verdict.reason}); approve the others by selection`,
        );
      }
      if (verdict.disposition === 'auto') {
        throw new Error(`action ${index + 1} was applied automatically and cannot be approved again`);
      }
    }
    const heldIndexes = indexesWith(verdicts, 'held');
    const rejectedIndexes = heldIndexes.filter((index) => !approvedIndexes.includes(index));
    await ctx.db.patch(args.workItemId, { approvedIndexes, applyPhase: 'approved' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-approved',
      payload: {
        workItemId: args.workItemId,
        runId: row.pendingRunId,
        approvedIndexes,
        rejectedIndexes,
        refusedIndexes: indexesWith(verdicts, 'refused'),
        autoIndexes: indexesWith(verdicts, 'auto'),
      },
      createdAt: Date.now(),
    });
    await scheduleApply(ctx, args.workItemId, row.pendingRunId);
    return { ok: true, approvedIndexes };
  },
});

/**
 * Refuse the held actions. The row fails with the manager's reason and the
 * draft is kept. Rows the auto phase already applied stay in the ledger, so
 * Retry is fenced by them; a run nothing landed for resumes from
 * `plan-approved` and runs the skill again.
 */
export const rejectActions = mutation({
  args: { workItemId: v.id('workItems'), pendingRunId: v.id('events'), reason: v.string() },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'actions-pending') {
      throw new Error(`workItem state is ${row.state}; expected actions-pending`);
    }
    if (row.approvedIndexes !== undefined) {
      throw new Error('actions have already been approved');
    }
    if (!row.pendingRunId) throw new Error('workItem has no pending run');
    if (row.pendingRunId !== args.pendingRunId) {
      throw new Error('pending run changed; refresh the action list');
    }
    const reason = args.reason.trim();
    const skipReason = reason ? `rejected by the manager: ${reason}` : 'rejected by the manager';
    const applied = ledgerOf(row.output);
    const output =
      applied.length > 0
        ? {
            ...(row.output as Record<string, unknown>),
            applied: applied.map((entry) =>
              entry?.awaitingApproval
                ? { ...entry, awaitingApproval: undefined, reason: skipReason }
                : entry,
            ),
          }
        : undefined;
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason,
      ...(output !== undefined ? { output } : {}),
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      executionRunId: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-rejected',
      payload: { workItemId: args.workItemId, reason: skipReason },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Take the approved actions for application, exactly once.
 *
 * The apply action is scheduled by `setActionsPending` (the auto phase) and
 * by `approveActions` (the manager's), and may be scheduled again after a
 * restart; whichever caller records the apply attempt on the row is the one
 * that applies. In the auto phase the row is still `executing` and the fence
 * is the absent attempt id; in the approved phase it moves the row from
 * `actions-pending` back to `executing`. The caller gets everything it needs
 * from the row so it never re-reads state that may have moved. The toggle is
 * read here, in the claim's transaction, so the apply backstop sees the
 * manager's latest word rather than the one the hold was decided under.
 */
export const claimApprovedActions = internalMutation({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        claimed: true;
        agentId: Id<'agents'>;
        runId: Id<'events'>;
        applyAttemptId: Id<'events'>;
        phase: 'auto' | 'approved';
        approvedIndexes: number[];
        heldIndexes: number[];
        heldReasons: Array<[number, string]>;
        autonomousActions: boolean;
        output: unknown;
      }
    | { claimed: false; reason: string }
  > => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    const autoPhase =
      row.state === 'executing' && row.applyPhase === 'auto' && row.applyAttemptId === undefined;
    if (row.state !== 'actions-pending' && !autoPhase) {
      return { claimed: false, reason: `workItem state is ${row.state}; expected actions-pending` };
    }
    if (!row.pendingRunId) return { claimed: false, reason: 'workItem has no pending run' };
    if (!row.approvedIndexes) return { claimed: false, reason: 'no actions have been approved' };
    // A missing agent row is the apply action's failure to report (it fences
    // the run as outcome-unknown); the claim only needs the switch's value.
    const agent = await ctx.db.get(row.agentId);
    const applyAttemptId = await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-applying',
      payload: {
        workItemId: args.workItemId,
        runId: row.pendingRunId,
        phase: autoPhase ? 'auto' : 'approved',
      },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.workItemId, {
      state: 'executing',
      applyAttemptId,
      applyClaimedAt: Date.now(),
    });
    const count = actionsOf(row.output).length;
    return {
      claimed: true,
      agentId: row.agentId,
      runId: row.pendingRunId,
      applyAttemptId,
      phase: autoPhase ? 'auto' : 'approved',
      approvedIndexes: row.approvedIndexes,
      heldIndexes: indexesWith(verdictList(row.actionVerdicts, count), 'held'),
      heldReasons: refusedReasonEntries(row.actionVerdicts, count),
      autonomousActions: agent ? autonomousActionsOn(agent) : false,
      output: row.output,
    };
  },
});

/**
 * Recover an apply action that disappeared across a backend interruption.
 *
 * An unclaimed approved set - the manager's, or the gate's auto rows - is
 * safe to reschedule. Once an apply claim exists, the provider may already
 * have accepted a request, so recovery records every outcome of this phase
 * as unknown, keeps what an earlier phase already recorded, and refuses
 * automatic replay.
 */
export const recoverInterruptedApply = internalMutation({
  args: { workItemId: v.id('workItems'), pendingRunId: v.id('events') },
  handler: async (
    ctx,
    args,
  ): Promise<{ recovered: 'ignored' | 'rescheduled' | 'outcome-unknown' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row || row.executionRunId !== args.pendingRunId) return { recovered: 'ignored' };
    const unclaimedAuto =
      row.state === 'executing' && row.applyPhase === 'auto' && row.applyAttemptId === undefined;
    if ((row.state === 'actions-pending' && row.approvedIndexes !== undefined) || unclaimedAuto) {
      await scheduleApply(ctx, args.workItemId, args.pendingRunId);
      return { recovered: 'rescheduled' };
    }
    if (row.state !== 'executing' || !row.applyAttemptId || !row.applyClaimedAt) {
      return { recovered: 'ignored' };
    }
    const output = (row.output ?? {}) as {
      actions?: Array<{ tool?: unknown }>;
      [key: string]: unknown;
    };
    const approved = new Set(row.approvedIndexes ?? []);
    const count = output.actions?.length ?? 0;
    const verdicts = verdictList(row.actionVerdicts, count);
    const prior = ledgerOf(row.output);
    // In the auto phase a held row was never offered to the manager, so it
    // keeps the reason the gate held it for; in the approved phase an
    // unapproved held row is one the manager left out.
    const heldReasonFor = (index: number): string => {
      const verdict = verdicts[index];
      if (verdict.disposition === 'refused') return verdict.reason;
      if (verdict.disposition === 'held' && row.applyPhase === 'auto') return verdict.reason;
      return HELD_NOT_APPROVED;
    };
    const applied = (output.actions ?? []).map((action, index) => {
      const earlier = prior[index];
      if (earlier && !earlier.awaitingApproval && !approved.has(index)) return earlier;
      return {
        tool: typeof action.tool === 'string' ? action.tool : 'unknown',
        ok: !approved.has(index),
        ...(approved.has(index)
          ? { reason: 'outcome unknown after interrupted apply - verify provider before retry' }
          : { held: true, reason: heldReasonFor(index) }),
        idempotencyKey: actionIdempotencyKey({
          workItemId: args.workItemId,
          runId: args.pendingRunId,
          actionIndex: index,
        }),
      };
    });
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason: INTERRUPTED_APPLY_REASON,
      output: { ...output, applied },
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-interrupted',
      payload: {
        workItemId: args.workItemId,
        runId: args.pendingRunId,
        applyAttemptId: row.applyAttemptId,
      },
      createdAt: Date.now(),
    });
    return { recovered: 'outcome-unknown' };
  },
});

export const setProposedSkill = internalMutation({
  args: { workItemId: v.id('workItems'), skillId: v.id('skills') },
  handler: async (ctx, args) => {
    await assertSameAgent(ctx, args.workItemId, args.skillId);
    await ctx.db.patch(args.workItemId, { proposedSkillId: args.skillId });
  },
});

export const countOpenForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<number> => {
    await assertOwnsAgent(ctx, args.agentId);
    const open = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
      .collect();
    const openStates = new Set([
      'claimed',
      'plan-pending',
      'plan-approved',
      'executing',
      'actions-pending',
    ]);
    return open.filter((w) => openStates.has(w.state)).length;
  },
});

export const findExistingClaim = query({
  args: {
    agentId: v.id('agents'),
    sourceSystem: v.string(),
    externalId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const row = await ctx.db
      .query('workItems')
      .withIndex('by_extId', (q) =>
        q.eq('sourceSystem', args.sourceSystem).eq('externalId', args.externalId),
      )
      .filter((q) => q.eq(q.field('agentId'), args.agentId))
      .first();
    if (!row) return null;
    const claimedStates = [
      'claimed',
      'plan-pending',
      'plan-approved',
      'executing',
      'actions-pending',
    ];
    if (!claimedStates.includes(row.state)) return null;
    return { state: row.state };
  },
});

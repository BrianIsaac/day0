import { v } from 'convex/values';
import { mutation, query, internalMutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsWorkItem } from './ownership';

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
    const next: Doc<'workItems'>['state'] = row.plan
      ? 'plan-approved'
      : (row.verdict as { decision?: string } | undefined)?.decision === 'claim'
        ? 'claimed'
        : 'discovered';
    await ctx.db.patch(args.workItemId, { state: next, skipReason: undefined });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.retry',
      payload: { workItemId: args.workItemId, resumeState: next, fromState: row.state },
      createdAt: Date.now(),
    });
    return { ok: true, resumeState: next };
  },
});

export const cancelPlan = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    await ctx.db.patch(args.workItemId, { state: 'cancelled' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.cancelled',
      payload: { workItemId: args.workItemId },
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
    await ctx.db.patch(args.workItemId, { state: 'executing', skillId: args.skillId });
    const runId = await ctx.db.insert('events', {
      agentId: item.agentId,
      type: 'work.execution-claimed',
      payload: { workItemId: args.workItemId, skillId: args.skillId },
      createdAt: Date.now(),
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
  args: { workItemId: v.id('workItems'), output: v.any() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
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
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
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
 * Pause an executing run at the exact-action gate.
 *
 * Called by the action that ran the skill, in real mode, instead of applying
 * anything: the draft, notes and literal `actions` are persisted with the run
 * id, the row moves to `actions-pending`, and nothing reaches a surface until
 * `approveActions` says which indexes may. Guarded on `executing` so a late
 * caller cannot reopen a run the manager has already decided.
 */
export const setActionsPending = internalMutation({
  args: { workItemId: v.id('workItems'), runId: v.id('events'), output: v.any() },
  handler: async (ctx, args): Promise<{ pending: boolean }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'executing') return { pending: false };
    const actions = (args.output as { actions?: unknown[] }).actions;
    if (!Array.isArray(actions)) throw new Error('output.actions must be a list');
    await ctx.db.patch(args.workItemId, {
      state: 'actions-pending',
      output: args.output,
      pendingRunId: args.runId,
      approvedIndexes: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-pending',
      payload: { workItemId: args.workItemId, runId: args.runId, actionCount: actions.length },
      createdAt: Date.now(),
    });
    return { pending: true };
  },
});

/**
 * Approve some or all of the pending actions and schedule their application.
 *
 * The indexes are validated against the persisted list, deduplicated and
 * sorted; an index outside the list is refused rather than ignored, because a
 * stale card must not silently approve a different action than it showed.
 * Approving nothing is allowed and lands nothing: every action is then
 * recorded as held.
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
    const actions = ((row.output ?? {}) as { actions?: unknown[] }).actions ?? [];
    const approvedIndexes = [...new Set(args.approvedIndexes)].sort((a, b) => a - b);
    for (const index of approvedIndexes) {
      if (!Number.isInteger(index) || index < 0 || index >= actions.length) {
        throw new Error(`action index ${index} is outside the pending list`);
      }
    }
    await ctx.db.patch(args.workItemId, { approvedIndexes });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-approved',
      payload: {
        workItemId: args.workItemId,
        runId: row.pendingRunId,
        approvedIndexes,
        heldIndexes: actions.map((_, index) => index).filter((i) => !approvedIndexes.includes(i)),
      },
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.workActions.applyApprovedActions, {
      workItemId: args.workItemId,
    });
    return { ok: true, approvedIndexes };
  },
});

/**
 * Refuse the pending actions. The row fails with the manager's reason and the
 * draft is kept, so Retry resumes from `plan-approved` and runs the skill again.
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
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason,
      pendingRunId: undefined,
      approvedIndexes: undefined,
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
 * The apply action is scheduled by `approveActions` and may be scheduled again
 * by a second approval after a restart; whichever caller moves the row from
 * `actions-pending` back to `executing` is the one that applies. The caller
 * gets everything it needs from the row so it never re-reads state that may
 * have moved.
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
        approvedIndexes: number[];
        output: unknown;
      }
    | { claimed: false; reason: string }
  > => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'actions-pending') {
      return { claimed: false, reason: `workItem state is ${row.state}; expected actions-pending` };
    }
    if (!row.pendingRunId) return { claimed: false, reason: 'workItem has no pending run' };
    if (!row.approvedIndexes) return { claimed: false, reason: 'no actions have been approved' };
    await ctx.db.patch(args.workItemId, { state: 'executing' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.actions-applying',
      payload: { workItemId: args.workItemId, runId: row.pendingRunId },
      createdAt: Date.now(),
    });
    return {
      claimed: true,
      agentId: row.agentId,
      runId: row.pendingRunId,
      approvedIndexes: row.approvedIndexes,
      output: row.output,
    };
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

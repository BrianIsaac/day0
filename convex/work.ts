import { v } from 'convex/values';
import { mutation, query, internalMutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
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

export const setCompleted = internalMutation({
  args: { workItemId: v.id('workItems'), output: v.any() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    await ctx.db.patch(args.workItemId, { state: 'completed', output: args.output });
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
    const openStates = new Set(['claimed', 'plan-pending', 'plan-approved', 'executing']);
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
    const claimedStates = ['claimed', 'plan-pending', 'plan-approved', 'executing'];
    if (!claimedStates.includes(row.state)) return null;
    return { state: row.state };
  },
});

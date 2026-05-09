import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
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

export const setVerdict = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    verdict: v.any(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');

    // Late-arriving verdict guard: setVerdict is the entry transition
    // from `discovered` (initial evaluation) or `needs-skill`
    // (pending-reevaluation after a skill registers). If the row has
    // already advanced past these — claimed, plan-pending,
    // plan-approved, executing, completed, etc. — a stale verdict
    // call must NOT stomp the row's state, which would wipe a drafted
    // plan or running execution. Ignore silently.
    if (row.state !== 'discovered' && row.state !== 'needs-skill') {
      return;
    }

    const decision = (args.verdict as { decision: string }).decision;
    let nextState: Doc<'workItems'>['state'] = 'discovered';
    let skipReason: string | undefined;
    if (decision === 'claim') nextState = 'claimed';
    else if (decision === 'skip') {
      nextState = 'skipped';
      skipReason = (args.verdict as { reason?: string }).reason;
    } else if (decision === 'queue') nextState = 'discovered';
    else if (decision === 'defer') nextState = 'deferred';
    else if (decision === 'needs-skill') nextState = 'needs-skill';
    await ctx.db.patch(args.workItemId, {
      verdict: args.verdict,
      state: nextState,
      ...(skipReason ? { skipReason } : {}),
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.evaluated',
      payload: { workItemId: args.workItemId, decision, verdict: args.verdict },
      createdAt: Date.now(),
    });
  },
});

export const setPlan = internalMutation({
  args: { workItemId: v.id('workItems'), plan: v.any() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    await ctx.db.patch(args.workItemId, { plan: args.plan, state: 'plan-pending' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.plan-drafted',
      payload: { workItemId: args.workItemId, plan: args.plan },
      createdAt: Date.now(),
    });
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

export const setExecutingWithSkill = internalMutation({
  args: { workItemId: v.id('workItems'), skillId: v.id('skills') },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.workItemId, { state: 'executing', skillId: args.skillId });
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
  args: { workItemId: v.id('workItems'), reason: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    await ctx.db.patch(args.workItemId, { state: 'failed', skipReason: args.reason });
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

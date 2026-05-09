import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { assertOwnsAgent, assertOwnsCharter } from './ownership';

/**
 * Charter CRUD + binary-plus-edit approval mutation. Every public
 * function asserts the caller owns the agent the charter belongs to.
 */

export const latest = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .first();
  },
});

export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .collect();
  },
});

export const persist = internalMutation({
  args: {
    agentId: v.id('agents'),
    version: v.string(),
    body: v.any(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert('charters', {
      agentId: args.agentId,
      version: args.version,
      body: args.body,
      approved: false,
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'charter.drafted',
      payload: { charterId: id, version: args.version },
      createdAt: Date.now(),
    });
    return id;
  },
});

export const approve = mutation({
  args: { charterId: v.id('charters') },
  handler: async (ctx, args) => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    await ctx.db.patch(args.charterId, {
      approved: true,
      approvedAt: Date.now(),
    });
    await ctx.db.patch(charter.agentId, { state: 'active' });
    await ctx.db.insert('events', {
      agentId: charter.agentId,
      type: 'charter.approved',
      payload: { charterId: args.charterId, version: charter.version },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

export const requestChanges = mutation({
  args: { charterId: v.id('charters'), notes: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const charter = await assertOwnsCharter(ctx, args.charterId);
    await ctx.db.insert('events', {
      agentId: charter.agentId,
      type: 'charter.request_changes',
      payload: { charterId: args.charterId, notes: args.notes ?? '' },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

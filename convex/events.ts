import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';

/**
 * Events feed — append-only, drives the live UI ticker.
 */

export const recent = query({
  args: { agentId: v.id('agents'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    return await ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .take(limit);
  },
});

export const log = internalMutation({
  args: { agentId: v.id('agents'), type: v.string(), payload: v.optional(v.any()) },
  handler: async (ctx, args) => {
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: args.type,
      payload: args.payload ?? {},
      createdAt: Date.now(),
    });
  },
});

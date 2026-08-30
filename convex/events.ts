import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import { assertOwnsAgent } from './ownership';
import { collectLedgerObservations } from './metrics';

/**
 * Events feed — append-only, drives the live UI ticker. The reading side
 * enforces per-account ownership; the writing side is internal-only.
 */

export const recent = query({
  args: { agentId: v.id('agents'), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const limit = args.limit ?? 50;
    return await ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .take(limit);
  },
});

/** The complete redacted trace used by the semi-final evaluation report. */
export const exportForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const [events, workItems, surfaces] = await Promise.all([
      ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('workItems')
        .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect(),
    ]);
    const credentials = await Promise.all(
      [...new Set(surfaces.flatMap((surface) => (surface.credentialId ? [surface.credentialId] : [])))]
        .map(async (credentialId) => await ctx.db.get(credentialId)),
    );
    return {
      version: 1,
      agent: { id: agent._id, name: agent.name },
      events,
      ledger: collectLedgerObservations(events, workItems),
      credentialNames: credentials.flatMap((credential) =>
        credential ? [{ label: credential.label }] : [],
      ),
    };
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

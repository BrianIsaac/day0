import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';

/**
 * Agent CRUD + state transitions. Each agent is owned by a Clerk user;
 * `listForUser` filters by the signed-in user so concurrent demos stay
 * isolated. All other public functions that take an `agentId` enforce
 * ownership via `assertOwnsAgent` before reading or writing.
 */

export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    return await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', identity.subject))
      .order('desc')
      .take(20);
  },
});

export const get = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    return await assertOwnsAgent(ctx, args.agentId);
  },
});

export const getByEmail = query({
  args: { bossEmail: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const row = await ctx.db
      .query('agents')
      .withIndex('by_bossEmail', (q) => q.eq('bossEmail', args.bossEmail))
      .order('desc')
      .first();
    if (!row) return null;
    if (row.userId !== identity.subject) return null;
    return row;
  },
});

/**
 * Internal-only fetch used by action-side ownership assertions; bypasses
 * the public `get` so that `assertOwnsAgentAction` doesn't recurse through
 * its own ownership check before it can compare userId.
 */
export const getInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.agentId);
  },
});

export const deploy = mutation({
  args: { bossEmail: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Id<'agents'>> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('not authenticated');
    const agentId = await ctx.db.insert('agents', {
      bossEmail: args.bossEmail,
      name: args.name ?? 'Day0',
      userId: identity.subject,
      state: 'deployed',
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId,
      type: 'agent.deployed',
      payload: { bossEmail: args.bossEmail },
      createdAt: Date.now(),
    });
    for (const scope of [
      'boss:message',
      'docs:read',
      'spreadsheet:read',
      'social:read',
      'ticket:read',
    ]) {
      await ctx.db.insert('permissionGrants', {
        agentId,
        scope,
        createdAt: Date.now(),
      });
    }
    return agentId;
  },
});

export const grantScopes = mutation({
  args: { agentId: v.id('agents'), scopes: v.array(v.string()) },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    let added = 0;
    for (const scope of args.scopes) {
      const existing = await ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) =>
          q.eq('agentId', args.agentId).eq('scope', scope),
        )
        .first();
      if (existing) continue;
      await ctx.db.insert('permissionGrants', {
        agentId: args.agentId,
        scope,
        createdAt: Date.now(),
      });
      added += 1;
    }
    return { added };
  },
});

export const setState = internalMutation({
  args: {
    agentId: v.id('agents'),
    state: v.union(
      v.literal('deployed'),
      v.literal('day-one-in-progress'),
      v.literal('charter-pending'),
      v.literal('active'),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.agentId, { state: args.state });
  },
});

export const recentEvents = query({
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

export const grantedScopes = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'permissionGrants'>[]> => {
    const all = await ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', args.agentId))
      .collect();
    return all.filter((g) => !g.revokedAt);
  },
});

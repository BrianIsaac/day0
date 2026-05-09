import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

/**
 * Skill registry + propose-author-register lifecycle. The state
 * machine:
 *
 *   proposed → approved → authoring → verified → registered
 *                       ↓                    ↓
 *                   rejected              failed
 *
 * `builtin` skills come straight in at `registered`. `agent-authored`
 * skills walk the full path.
 */

export const registered = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'registered'))
      .collect();
  },
});

export const proposed = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'skills'>[]> => {
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId).eq('state', 'proposed'))
      .collect();
  },
});

export const get = query({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.skillId);
  },
});

export const findByAgentName = query({
  args: { agentId: v.id('agents'), name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', args.agentId).eq('name', args.name))
      .first();
  },
});

export const installBuiltin = internalMutation({
  args: {
    agentId: v.id('agents'),
    name: v.string(),
    description: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'skills'>> => {
    const existing = await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', args.agentId).eq('name', args.name))
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert('skills', {
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      body: args.body,
      sourceType: 'builtin',
      state: 'registered',
      createdAt: Date.now(),
      registeredAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'skill.builtin-installed',
      payload: { skillId: id, name: args.name },
      createdAt: Date.now(),
    });
    return id;
  },
});

export const propose = internalMutation({
  args: {
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    name: v.string(),
    description: v.string(),
    rationale: v.string(),
    requiredScopes: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'skills'>> => {
    // Dedup: re-evaluation can race and re-propose the same skill name
    // for the same agent. If a non-rejected/failed proposal already
    // exists, return its id so callers progress without creating a
    // duplicate row.
    const existing = await ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) =>
        q.eq('agentId', args.agentId).eq('name', args.name),
      )
      .first();
    if (existing && existing.state !== 'rejected' && existing.state !== 'failed') {
      return existing._id;
    }
    const id = await ctx.db.insert('skills', {
      agentId: args.agentId,
      name: args.name,
      description: args.description,
      body: '',
      sourceType: 'agent-authored',
      state: 'proposed',
      proposedFor: args.workItemId,
      rationale: args.rationale,
      requiredScopes: args.requiredScopes,
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'skill.proposed',
      payload: {
        skillId: id,
        name: args.name,
        rationale: args.rationale,
        forWorkItem: args.workItemId,
      },
      createdAt: Date.now(),
    });
    return id;
  },
});

export const approve = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.skillId);
    if (!row) throw new Error('skill not found');
    if (row.state !== 'proposed') {
      throw new Error(`skill state is ${row.state}; expected proposed`);
    }
    await ctx.db.patch(args.skillId, { state: 'approved' });
    // Issue the required scopes as live grants.
    for (const scope of row.requiredScopes ?? []) {
      const existing = await ctx.db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId).eq('scope', scope))
        .first();
      if (!existing) {
        await ctx.db.insert('permissionGrants', {
          agentId: row.agentId,
          scope,
          createdAt: Date.now(),
        });
      }
    }
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.approved',
      payload: { skillId: args.skillId, name: row.name, scopes: row.requiredScopes ?? [] },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

export const reject = mutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.skillId);
    if (!row) throw new Error('skill not found');
    await ctx.db.patch(args.skillId, { state: 'rejected' });
    if (row.proposedFor) {
      await ctx.db.patch(row.proposedFor, { state: 'cancelled' });
    }
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'skill.rejected',
      payload: { skillId: args.skillId, name: row.name },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

export const setAuthoring = internalMutation({
  args: { skillId: v.id('skills'), sandboxId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.skillId, {
      state: 'authoring',
      daytonaSandboxId: args.sandboxId,
    });
    const row = await ctx.db.get(args.skillId);
    if (row) {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'skill.authoring',
        payload: { skillId: args.skillId, sandboxId: args.sandboxId },
        createdAt: Date.now(),
      });
    }
  },
});

export const setVerified = internalMutation({
  args: { skillId: v.id('skills'), body: v.string(), verificationLog: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.skillId, {
      state: 'verified',
      body: args.body,
      verificationLog: args.verificationLog,
    });
  },
});

export const setRegistered = internalMutation({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.skillId, { state: 'registered', registeredAt: Date.now() });
    const row = await ctx.db.get(args.skillId);
    if (row) {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'skill.registered',
        payload: { skillId: args.skillId, name: row.name },
        createdAt: Date.now(),
      });
    }
  },
});

export const setFailed = internalMutation({
  args: { skillId: v.id('skills'), reason: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.skillId, {
      state: 'failed',
      verificationLog: args.reason,
    });
    const row = await ctx.db.get(args.skillId);
    if (row) {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'skill.failed',
        payload: { skillId: args.skillId, reason: args.reason },
        createdAt: Date.now(),
      });
    }
  },
});

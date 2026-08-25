import { v } from 'convex/values';
import { action, internalMutation, mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsAgentAction } from './ownership';
import { assertRealMode } from '../src/lib/surface-mode';
import type { Doc } from './_generated/dataModel';

const surfaceVerdict = v.union(
  v.literal('declared'),
  v.literal('proposed'),
  v.literal('approved'),
  v.literal('connected'),
  v.literal('ungranted'),
  v.literal('absent'),
  v.literal('listed-dead'),
);

/**
 * Convert a declared system name to its stable per-agent key.
 *
 * Args:
 *   name: Manager-provided system name.
 *
 * Returns:
 *   A lowercase URL-safe surface slug.
 */
export function surfaceSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'system'
  );
}

/** List connection verdicts for one owned agent. */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'surfaces'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
      .collect();
  },
});

/** Seed one declared row per system named in the approved charter. */
export const seedFromCharter = internalMutation({
  args: {
    agentId: v.id('agents'),
    namedSystems: v.array(
      v.object({ name: v.string(), class: v.string(), whereMentioned: v.string() }),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    for (const system of args.namedSystems) {
      const slug = surfaceSlug(system.name);
      const existing = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (index) => index.eq('agentId', args.agentId).eq('slug', slug))
        .unique();
      if (existing) continue;
      await ctx.db.insert('surfaces', {
        agentId: args.agentId,
        slug,
        displayName: system.name,
        class: system.class,
        verdict: 'declared',
        whereFound: [{ ref: 'manager 1:1', quote: system.whereMentioned }],
        credentialLanded: false,
        createdAt: Date.now(),
      });
    }
  },
});

/** Store an evidence-backed connect request. */
export const propose = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    request: v.any(),
    whereFound: v.array(v.any()),
    path: v.string(),
    fallbackPath: v.string(),
    endpoint: v.optional(v.string()),
    credentialRef: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await ctx.db.patch(args.surfaceId, {
      verdict: 'proposed',
      request: args.request,
      whereFound: args.whereFound,
      path: args.path,
      fallbackPath: args.fallbackPath,
      endpoint: args.endpoint,
      credentialRef: args.credentialRef,
      reason: undefined,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.proposed',
      payload: { surfaceId: surface._id, path: args.path },
      createdAt: Date.now(),
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.oriented',
      payload: { surfaceId: surface._id, verdict: 'proposed' },
      createdAt: Date.now(),
    });
  },
});

/** Record that documentation explicitly provides no approved surface. */
export const markAbsent = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    searched: v.array(v.string()),
    whereFound: v.array(v.any()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await ctx.db.patch(args.surfaceId, {
      verdict: 'absent',
      whereFound: args.whereFound,
      reason: `No approved surface found after searching: ${args.searched.join(', ')}`,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.oriented',
      payload: { surfaceId: surface._id, verdict: 'absent', searched: args.searched },
      createdAt: Date.now(),
    });
  },
});

/** Set a surface verdict from a server-side probe or lifecycle action. */
export const setStatus = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    verdict: surfaceVerdict,
    reason: v.optional(v.string()),
    credentialLanded: v.optional(v.boolean()),
    lastVerifiedAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await ctx.db.patch(surface._id, {
      verdict: args.verdict,
      reason: args.reason,
      credentialLanded: args.credentialLanded ?? surface.credentialLanded,
      lastVerifiedAt: args.lastVerifiedAt ?? surface.lastVerifiedAt,
    });
  },
});

/**
 * Record manager or IT approval; both are required for `approved`.
 *
 * Only a proposed surface can be approved: an absent, declared or already
 * approved surface has nothing to approve, and a rejected surface must be
 * re-proposed from evidence before either stamp can be placed again.
 */
export const approve = mutation({
  args: { surfaceId: v.id('surfaces'), role: v.union(v.literal('manager'), v.literal('it')) },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'proposed') {
      throw new Error(
        `Only a proposed surface can be approved; this one is ${surface.verdict}.`,
      );
    }
    const now = Date.now();
    const patch = args.role === 'manager' ? { managerApprovedAt: now } : { itApprovedAt: now };
    const both =
      (args.role === 'manager' || surface.managerApprovedAt !== undefined) &&
      (args.role === 'it' || surface.itApprovedAt !== undefined);
    await ctx.db.patch(surface._id, { ...patch, verdict: both ? 'approved' : 'proposed' });
    if (both) {
      await ctx.db.insert('events', {
        agentId: surface.agentId,
        type: 'surface.approved',
        payload: { surfaceId: surface._id },
        createdAt: now,
      });
    }
  },
});

/**
 * Reject a proposed or approved surface and return it to `declared`.
 *
 * Both approval stamps and every connection detail are cleared, so a later
 * re-proposal starts from evidence again and a single approval can never
 * complete it on the strength of a stamp placed before the rejection.
 */
export const reject = mutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    await assertOwnsAgent(ctx, surface.agentId);
    if (surface.verdict !== 'proposed' && surface.verdict !== 'approved') {
      throw new Error(
        `Only a proposed or approved surface can be rejected; this one is ${surface.verdict}.`,
      );
    }
    await ctx.db.patch(surface._id, {
      verdict: 'declared',
      reason: args.reason,
      request: undefined,
      managerApprovedAt: undefined,
      itApprovedAt: undefined,
      endpoint: undefined,
      path: undefined,
      fallbackPath: undefined,
      credentialRef: undefined,
      toolAllowlist: undefined,
      credentialLanded: false,
      lastVerifiedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.rejected',
      payload: { surfaceId: surface._id, reason: args.reason },
      createdAt: Date.now(),
    });
  },
});

/**
 * Re-run orientation for the owner's declared surfaces.
 *
 * Orientation otherwise runs only from charter approval, so a rejected
 * surface would have no way back to `proposed` short of re-approving the
 * charter. Real mode only, like the run it triggers.
 */
export const reorient = action({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ proposed: number; absent: number }> => {
    await assertOwnsAgentAction(ctx, args.agentId);
    assertRealMode('Surface orientation');
    return await ctx.runAction(internal.orientationActions.run, { agentId: args.agentId });
  },
});

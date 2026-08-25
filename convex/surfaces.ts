import { v } from 'convex/values';
import { action, internalMutation, mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsAgentAction } from './ownership';
import { assertRealMode } from '../src/lib/surface-mode';
import type { Doc, Id } from './_generated/dataModel';

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
  handler: async (ctx, args): Promise<Id<'surfaces'>[]> => {
    const surfaceIds: Id<'surfaces'>[] = [];
    for (const system of args.namedSystems) {
      const slug = surfaceSlug(system.name);
      const existing = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (index) => index.eq('agentId', args.agentId).eq('slug', slug))
        .unique();
      if (existing) {
        surfaceIds.push(existing._id);
        continue;
      }
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId: args.agentId,
        slug,
        displayName: system.name,
        class: system.class,
        verdict: 'declared',
        whereFound: [{ ref: 'manager 1:1', quote: system.whereMentioned }],
        credentialLanded: false,
        createdAt: Date.now(),
      });
      surfaceIds.push(surfaceId);
    }
    return surfaceIds;
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
    credentialId: v.optional(v.id('credentials')),
    credentialLocation: v.optional(v.string()),
    expiresInDays: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.verdict !== 'declared') return false;
    const now = Date.now();
    await ctx.db.patch(args.surfaceId, {
      verdict: 'proposed',
      request: args.request,
      whereFound: args.whereFound,
      path: args.path,
      fallbackPath: args.fallbackPath,
      endpoint: args.endpoint,
      credentialId: args.credentialId,
      credentialLocation: args.credentialLocation,
      credentialRef: undefined,
      expiresAt: now + args.expiresInDays * 24 * 60 * 60 * 1_000,
      reason: undefined,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.proposed',
      payload: { surfaceId: surface._id, path: args.path },
      createdAt: now,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.oriented',
      payload: { surfaceId: surface._id, verdict: 'proposed' },
      createdAt: now,
    });
    return true;
  },
});

/** Record that documentation explicitly provides no approved surface. */
export const markAbsent = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    searched: v.array(v.string()),
    whereFound: v.array(v.any()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.verdict !== 'declared') return false;
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
    return true;
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

/** Attach an encrypted credential reference without exposing its value. */
export const attachCredential = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    credentialId: v.id('credentials'),
    credentialLocation: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    const approved = surface.managerApprovedAt !== undefined && surface.itApprovedAt !== undefined;
    await ctx.db.patch(surface._id, {
      credentialId: args.credentialId,
      credentialLocation: args.credentialLocation,
      credentialRef: undefined,
      credentialLanded: false,
      verdict:
        approved && (surface.verdict === 'ungranted' || surface.verdict === 'listed-dead')
          ? 'approved'
          : surface.verdict,
      reason: approved ? undefined : surface.reason,
    });
  },
});

/** Reserve the next probe generation for an approved connection candidate. */
export const beginProbe = internalMutation({
  args: { surfaceId: v.id('surfaces') },
  handler: async (
    ctx,
    args,
  ): Promise<{ surface: Doc<'surfaces'>; generation: number } | null> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (
      !surface ||
      !['approved', 'connected', 'ungranted', 'listed-dead'].includes(surface.verdict)
    ) {
      return null;
    }
    const generation = (surface.probeGeneration ?? 0) + 1;
    await ctx.db.patch(surface._id, { probeGeneration: generation });
    return { surface: { ...surface, probeGeneration: generation }, generation };
  },
});

/** Persist a safe probe failure while retaining no provider request material. */
export const recordProbeFailure = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    generation: v.number(),
    verdict: v.union(v.literal('ungranted'), v.literal('listed-dead')),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.probeGeneration !== args.generation) return false;
    if (!['approved', 'connected', 'ungranted', 'listed-dead'].includes(surface.verdict)) {
      return false;
    }
    await ctx.db.patch(surface._id, {
      verdict: args.verdict,
      reason: args.reason,
      credentialLanded: false,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.probe-failed',
      payload: { surfaceId: surface._id, verdict: args.verdict, reason: args.reason },
      createdAt: Date.now(),
    });
    return true;
  },
});

/** Persist one successful provider probe and its discovered safe metadata. */
export const recordConnected = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    generation: v.number(),
    toolAllowlist: v.array(v.string()),
    toolArguments: v.array(v.object({ tool: v.string(), arguments: v.array(v.string()) })),
    managerDmChannelId: v.optional(v.string()),
    providerIdentityId: v.optional(v.string()),
    providerWorkspaceId: v.optional(v.string()),
    verifiedAt: v.number(),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.probeGeneration !== args.generation) return false;
    if (!['approved', 'connected', 'ungranted', 'listed-dead'].includes(surface.verdict)) {
      return false;
    }
    await ctx.db.patch(surface._id, {
      verdict: 'connected',
      reason: undefined,
      credentialLanded: true,
      lastVerifiedAt: args.verifiedAt,
      toolAllowlist: args.toolAllowlist,
      toolArguments: args.toolArguments,
      managerDmChannelId: args.managerDmChannelId,
      providerIdentityId: args.providerIdentityId,
      providerWorkspaceId: args.providerWorkspaceId,
      expiresAt: args.expiresAt ?? surface.expiresAt,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.connected',
      payload: { surfaceId: surface._id },
      createdAt: args.verifiedAt,
    });
    return true;
  },
});

/** Demote an expired connected surface until its approval is renewed. */
export const recordExpired = internalMutation({
  args: { surfaceId: v.id('surfaces'), now: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (
      !surface ||
      surface.verdict !== 'connected' ||
      surface.expiresAt === undefined ||
      surface.expiresAt > args.now
    ) {
      return;
    }
    await ctx.db.patch(surface._id, {
      verdict: 'approved',
      reason: 'expired',
      credentialLanded: false,
      lastVerifiedAt: undefined,
    });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.expired',
      payload: { surfaceId: surface._id },
      createdAt: args.now,
    });
  },
});

/** Record this poll's waterfall position and visible skip outcome. */
export const recordIntake = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    waterfallPosition: v.number(),
    skipReason: v.optional(v.string()),
    polledAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return;
    await ctx.db.patch(surface._id, {
      waterfallPosition: args.waterfallPosition,
      intakeSkipReason: args.skipReason,
      lastPolledAt:
        args.polledAt === undefined
          ? surface.lastPolledAt
          : Math.max(surface.lastPolledAt ?? 0, args.polledAt),
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
      await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
        surfaceId: surface._id,
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
      credentialId: undefined,
      credentialLocation: undefined,
      managerDmChannelId: undefined,
      toolAllowlist: undefined,
      toolArguments: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      waterfallPosition: undefined,
      intakeSkipReason: undefined,
      lastPolledAt: undefined,
      credentialLanded: false,
      lastVerifiedAt: undefined,
      expiresAt: undefined,
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
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    await assertOwnsAgentAction(ctx, args.agentId);
    assertRealMode('Surface orientation');
    return await ctx.runAction(internal.orientationActions.run, { agentId: args.agentId });
  },
});

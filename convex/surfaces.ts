import { v } from 'convex/values';
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsAgentAction } from './ownership';
import { grantScopeInTransaction } from './agents';
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

/**
 * Seed one declared row per work system named in the approved charter.
 *
 * A system of class `docs` is a documentation location: it is configured on
 * the documentation page and read from there, never discovered, connected or
 * polled, so it stays on the charter card and gets no surface.
 */
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
      if (system.class === 'docs') continue;
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

const credentialKind = v.union(v.literal('value'), v.literal('location'), v.literal('oauth'));

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
    credentialKind: v.optional(credentialKind),
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
      credentialKind: args.credentialId ? args.credentialKind : undefined,
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

/**
 * Schedule the isolated orientation job for one declared surface, at most once.
 *
 * Charter approval and the owner's re-run control both come through here.
 * A surface whose previous job is still pending or running is left alone,
 * so two requests in quick succession cost one model call, not two, and
 * only the surface id crosses the scheduler boundary.
 */
export const scheduleOrientation = internalMutation({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.verdict !== 'declared') return false;
    if (surface.orientationJobId) {
      const job = await ctx.db.system.get(surface.orientationJobId);
      if (job && (job.state.kind === 'pending' || job.state.kind === 'inProgress')) return false;
    }
    const orientationJobId = await ctx.scheduler.runAfter(
      0,
      internal.orientationActions.orientOne,
      { surfaceId: surface._id },
    );
    await ctx.db.patch(surface._id, { orientationJobId });
    return true;
  },
});

/**
 * Record that an orientation job failed before it could decide.
 *
 * The surface stays `declared`, because nothing was decided, but the card
 * carries the failure so the operator sees why there is no proposal and the
 * re-run control applies. A surface that has moved on is left alone.
 */
export const recordOrientationFailure = internalMutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.verdict !== 'declared') return false;
    const reason = `orientation failed: ${args.reason}`.slice(0, 400);
    await ctx.db.patch(surface._id, { reason });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.orientation-failed',
      payload: { surfaceId: surface._id, reason },
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
    credentialKind,
    credentialLocation: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    const approved = surface.managerApprovedAt !== undefined && surface.itApprovedAt !== undefined;
    await ctx.db.patch(surface._id, {
      credentialId: args.credentialId,
      credentialKind: args.credentialKind,
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

/**
 * Return work parked on this surface to the evaluator.
 *
 * Evaluation defers a candidate whose provider is not connected, or whose
 * read grant is missing, and nothing re-evaluates a deferred row on its
 * own. When the surface connects, and the grant lands with it, those rows go
 * back to `discovered` so the dashboard's queue evaluates them again.
 *
 * Args:
 *   ctx: Mutation context of the connecting write.
 *   surface: The surface that just became connected.
 *
 * Returns:
 *   Ids of the work items requeued.
 */
async function requeueWorkAwaitingSurface(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
): Promise<Id<'workItems'>[]> {
  const readScope = `${surface.slug}:read`;
  const deferred = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (index) =>
      index.eq('agentId', surface.agentId).eq('state', 'deferred'),
    )
    .collect();
  const requeued: Id<'workItems'>[] = [];
  for (const item of deferred) {
    const verdict = item.verdict as
      | { reason?: string; missingSurface?: string; missingPermissions?: string[] }
      | undefined;
    const waitingOnThisSurface =
      (verdict?.reason === 'awaiting-connection' && verdict.missingSurface === surface.slug) ||
      (verdict?.reason === 'awaiting-permission' &&
        (verdict.missingPermissions ?? []).includes(readScope));
    if (!waitingOnThisSurface) continue;
    await ctx.db.patch(item._id, { state: 'discovered', verdict: undefined });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'work.requeued',
      payload: { workItemId: item._id, surfaceId: surface._id, slug: surface.slug },
      createdAt: Date.now(),
    });
    requeued.push(item._id);
  }
  return requeued;
}

/**
 * Persist one successful provider probe and its discovered safe metadata.
 *
 * The first transition to `connected` also grants `<slug>:read` and requeues
 * the work that was deferred on this surface, in the same transaction, so a
 * connected surface can never exist without its grant and the hourly
 * re-probe never grants again.
 */
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
    const transitioned = surface.verdict !== 'connected';
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
    if (transitioned) {
      await grantScopeInTransaction(ctx, surface.agentId, `${surface.slug}:read`);
      await requeueWorkAwaitingSurface(ctx, surface);
    }
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
      credentialKind: undefined,
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

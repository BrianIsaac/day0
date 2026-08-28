import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { agentReadsSource } from './docSources';
import { reconcileDocumentedSystems, type DocumentedSystemSeed } from './surfaces';

const candidateValidator = v.object({
  slug: v.string(),
  displayName: v.string(),
  class: v.string(),
  ref: v.string(),
  quote: v.string(),
  url: v.optional(v.string()),
});

async function currentDiscoveries(
  ctx: Parameters<typeof reconcileDocumentedSystems>[0],
  sourceId: Id<'docSources'>,
): Promise<DocumentedSystemSeed[]> {
  const rows = await ctx.db
    .query('docSystemDiscoveries')
    .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
    .take(1_001);
  if (rows.length > 1_000) throw new Error('Documentation discovery exceeds 1,000 systems.');
  return rows
    .filter((row): boolean => row.current)
    .map(
      (row): DocumentedSystemSeed => ({
        slug: row.slug,
        displayName: row.displayName,
        class: row.class,
        ref: row.ref,
        quote: row.quote,
        url: row.url,
      }),
    );
}

/** Read the authoritative completed generation for one discovery action. */
export const context = internalQuery({
  args: { sourceId: v.id('docSources'), runId: v.id('docSyncRuns') },
  handler: async (
    ctx,
    args,
  ): Promise<{
    source: Doc<'docSources'>;
    pages: Doc<'docPages'>[];
  } | null> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== undefined ||
      source.lastCompletedSyncId !== run._id ||
      source.lastDiscoverySyncId === run._id ||
      run.sourceId !== source._id ||
      run.state !== 'completed'
    ) {
      return null;
    }
    const pages = await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .take(501);
    if (pages.length > 500) throw new Error('Documentation discovery exceeds 500 pages.');
    return { source, pages };
  },
});

/** Reconcile a completed discovery generation and seed every inheriting agent. */
export const apply = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    fingerprint: v.string(),
    warning: v.optional(v.string()),
    candidates: v.array(candidateValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    applied: boolean;
    created: number;
    updated: number;
    retired: number;
    scheduled: number;
  }> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== undefined ||
      source.lastCompletedSyncId !== run._id ||
      source.lastDiscoverySyncId === run._id ||
      run.sourceId !== source._id ||
      run.state !== 'completed'
    ) {
      return { applied: false, created: 0, updated: 0, retired: 0, scheduled: 0 };
    }
    if (args.candidates.length > 1_000) {
      throw new Error('Documentation discovery exceeds 1,000 systems.');
    }
    const now = Date.now();
    const candidates = new Map<string, (typeof args.candidates)[number]>();
    for (const candidate of args.candidates) {
      if (candidate.class !== 'docs' && !candidates.has(candidate.slug)) {
        candidates.set(candidate.slug, candidate);
      }
    }
    const existing = await ctx.db
      .query('docSystemDiscoveries')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .take(1_001);
    if (existing.length > 1_000) throw new Error('Documentation discovery exceeds 1,000 systems.');
    const existingBySlug = new Map(existing.map((row) => [row.slug, row]));
    for (const row of existing) {
      if (!candidates.has(row.slug) && row.current) {
        await ctx.db.patch(row._id, { current: false, lastSeenAt: now });
      }
    }
    for (const candidate of candidates.values()) {
      const row = existingBySlug.get(candidate.slug);
      if (row) {
        await ctx.db.patch(row._id, {
          displayName: candidate.displayName,
          class: candidate.class,
          ref: candidate.ref,
          quote: candidate.quote,
          url: candidate.url,
          current: true,
          lastSeenAt: now,
        });
      } else {
        await ctx.db.insert('docSystemDiscoveries', {
          sourceId: source._id,
          ...candidate,
          current: true,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    }
    const systems = [...candidates.values()];
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (index) => index.eq('userId', source.userId))
      .take(101);
    if (agents.length > 100) throw new Error('Documentation discovery exceeds 100 agents.');
    const totals = { created: 0, updated: 0, retired: 0, scheduled: 0 };
    for (const agent of agents) {
      if (!agentReadsSource(agent, source._id)) continue;
      const result = await reconcileDocumentedSystems(ctx, {
        agentId: agent._id,
        sourceId: source._id,
        systems,
        now,
      });
      totals.created += result.created;
      totals.updated += result.updated;
      totals.retired += result.retired;
      totals.scheduled += result.scheduled;
      await ctx.db.insert('events', {
        agentId: agent._id,
        type: 'documentation.systems-discovered',
        payload: { sourceId: source._id, systems: systems.length, ...result },
        createdAt: now,
      });
    }
    await ctx.db.patch(source._id, {
      lastDiscoverySyncId: run._id,
      discoveryFingerprint: args.fingerprint,
      lastDiscoveryAt: now,
      lastDiscoveryError: args.warning?.slice(0, 500),
      updatedAt: now,
    });
    return { applied: true, ...totals };
  },
});

/** Stamp an unchanged completed generation without spending a model call. */
export const markUnchanged = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    fingerprint: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const source = await ctx.db.get(args.sourceId);
    if (
      !source ||
      source.activeSyncId !== undefined ||
      source.lastCompletedSyncId !== args.runId ||
      source.lastDiscoverySyncId === args.runId ||
      source.discoveryFingerprint !== args.fingerprint
    ) {
      return false;
    }
    const now = Date.now();
    await ctx.db.patch(source._id, {
      lastDiscoverySyncId: args.runId,
      lastDiscoveryAt: now,
      lastDiscoveryError: undefined,
      updatedAt: now,
    });
    return true;
  },
});

/** Keep discovery failure visible and retry it after the next completed sync. */
export const recordFailure = internalMutation({
  args: { sourceId: v.id('docSources'), runId: v.id('docSyncRuns'), reason: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const source = await ctx.db.get(args.sourceId);
    if (
      !source ||
      source.activeSyncId !== undefined ||
      source.lastCompletedSyncId !== args.runId ||
      source.lastDiscoverySyncId === args.runId
    ) {
      return false;
    }
    await ctx.db.patch(source._id, {
      lastDiscoveryError: args.reason.slice(0, 500),
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** Seed one newly deployed agent from discoveries already stored for a source. */
export const seedForAgent = internalMutation({
  args: { agentId: v.id('agents'), sourceId: v.id('docSources') },
  handler: async (ctx, args) => {
    const [agent, source] = await Promise.all([
      ctx.db.get(args.agentId),
      ctx.db.get(args.sourceId),
    ]);
    if (
      !agent ||
      !source ||
      agent.userId !== source.userId ||
      !agentReadsSource(agent, source._id)
    ) {
      return { created: 0, updated: 0, retired: 0, scheduled: 0 };
    }
    return await reconcileDocumentedSystems(ctx, {
      agentId: agent._id,
      sourceId: source._id,
      systems: await currentDiscoveries(ctx, source._id),
      now: Date.now(),
    });
  },
});

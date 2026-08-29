import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { agentReadsSource } from './docSources';
import {
  backfillCharterProvenance,
  reconcileDocumentedSystems,
  type CharterSystemSeed,
  type DocumentedSystemSeed,
} from './surfaces';
import type { Charter } from '../src/agent/charter';
import {
  documentedSystemIdentity,
  sameDocumentedSystem,
  type DocumentedSystemIdentity,
} from '../src/docs/system-discovery';

const discoveryEvidenceValidator = v.object({
  displayName: v.string(),
  ref: v.string(),
  quote: v.string(),
  url: v.optional(v.string()),
});

const documentedIdentityValidator = v.object({
  slugs: v.array(v.string()),
  nameKeys: v.array(v.string()),
  endpoints: v.array(v.string()),
  hosts: v.array(v.string()),
});

const candidateValidator = v.object({
  slug: v.string(),
  displayName: v.string(),
  class: v.string(),
  ref: v.string(),
  quote: v.string(),
  url: v.optional(v.string()),
  evidence: v.optional(v.array(discoveryEvidenceValidator)),
  mergedNames: v.optional(v.array(v.string())),
  identity: v.optional(documentedIdentityValidator),
  transportOnly: v.optional(v.boolean()),
});

function combineIdentities(
  left: DocumentedSystemIdentity,
  right: DocumentedSystemIdentity,
): DocumentedSystemIdentity {
  return {
    slugs: [...new Set([...left.slugs, ...right.slugs])].sort(),
    nameKeys: [...new Set([...left.nameKeys, ...right.nameKeys])].sort(),
    endpoints: [...new Set([...left.endpoints, ...right.endpoints])].sort(),
    hosts: [...new Set([...left.hosts, ...right.hosts])].sort(),
  };
}

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
        evidence: row.evidence,
        identity: row.identity,
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
    accepted: number;
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
      return { applied: false, created: 0, updated: 0, retired: 0, scheduled: 0, accepted: 0 };
    }
    if (args.candidates.length > 1_000) {
      throw new Error('Documentation discovery exceeds 1,000 systems.');
    }
    const now = Date.now();
    const [existing, agents] = await Promise.all([
      ctx.db
        .query('docSystemDiscoveries')
        .withIndex('by_source', (index) => index.eq('sourceId', source._id))
        .take(1_001),
      ctx.db
        .query('agents')
        .withIndex('by_userId', (index) => index.eq('userId', source.userId))
        .take(101),
    ]);
    if (existing.length > 1_000) throw new Error('Documentation discovery exceeds 1,000 systems.');
    if (agents.length > 100) throw new Error('Documentation discovery exceeds 100 agents.');
    const surfaces = (
      await Promise.all(
        agents.map(
          async (agent) =>
            await ctx.db
              .query('surfaces')
              .withIndex('by_agent', (index) => index.eq('agentId', agent._id))
              .collect(),
        ),
      )
    ).flat();
    const targets = [
      ...existing
        .filter((row) => row.current)
        .map((row) => ({
          slug: row.slug,
          displayName: row.displayName,
          class: row.class,
          identity:
            row.identity ??
            documentedSystemIdentity({
              name: row.displayName,
              quotes: (row.evidence ?? [row]).map((item) => item.quote),
            }),
        })),
      ...surfaces.map((surface) => ({
        slug: surface.slug,
        displayName: surface.displayName,
        class: surface.class,
        identity: documentedSystemIdentity({
          name: surface.displayName,
          quotes: (surface.discoveryEvidence ?? []).map((item) => item.quote),
          endpoints: surface.endpoint ? [surface.endpoint] : [],
        }),
      })),
    ];
    const candidates = new Map<string, (typeof args.candidates)[number]>();
    for (const original of args.candidates) {
      if (original.class === 'docs') continue;
      const evidence = original.evidence ?? [
        {
          displayName: original.displayName,
          ref: original.ref,
          quote: original.quote,
          url: original.url,
        },
      ];
      const identity =
        original.identity ??
        documentedSystemIdentity({
          name: original.displayName,
          quotes: evidence.map((item) => item.quote),
        });
      if (
        evidence.length > 64 ||
        (original.mergedNames?.length ?? 0) > 64 ||
        Object.values(identity).some((values) => values.length > 64)
      ) {
        throw new Error('Documentation discovery identity exceeds 64 signals.');
      }
      const matches = targets.filter((target) =>
        sameDocumentedSystem(original.class, identity, target.class, target.identity),
      );
      const target =
        matches.find((match) => match.slug === original.slug) ??
        [...matches].sort((left, right): number => {
          const leftTransport = Number(left.identity.nameKeys[0] !== left.identity.slugs[0]);
          const rightTransport = Number(right.identity.nameKeys[0] !== right.identity.slugs[0]);
          return (
            leftTransport - rightTransport ||
            left.displayName.split(/\s+/).length - right.displayName.split(/\s+/).length ||
            left.displayName.localeCompare(right.displayName)
          );
        })[0];
      if (original.transportOnly && !target) continue;
      const conflictingSlug = existing.some(
        (row) => row.slug === original.slug && !matches.some((match) => match.slug === row.slug),
      );
      const host = identity.hosts[0]
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const slug = target?.slug ?? (conflictingSlug ? `${original.slug}-${host || 'system'}` : original.slug);
      const candidate = {
        ...original,
        slug,
        displayName: target?.displayName ?? original.displayName,
        evidence,
        mergedNames: [
          ...new Set([
            ...(original.mergedNames ?? []),
            ...(target && target.displayName !== original.displayName ? [original.displayName] : []),
          ]),
        ],
        identity: target ? combineIdentities(identity, target.identity) : identity,
      };
      const prior = candidates.get(slug);
      if (!prior) {
        candidates.set(slug, candidate);
        continue;
      }
      const combinedEvidence = new Map(
        [...(prior.evidence ?? []), ...evidence].map(
          (item) => [`${item.ref}\0${item.quote}`, item] as const,
        ),
      );
      candidates.set(slug, {
        ...prior,
        evidence: [...combinedEvidence.values()],
        mergedNames: [...new Set([...(prior.mergedNames ?? []), ...(candidate.mergedNames ?? [])])],
        identity: combineIdentities(prior.identity ?? identity, candidate.identity),
        transportOnly: Boolean(prior.transportOnly && candidate.transportOnly),
      });
    }
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
          evidence: candidate.evidence,
          mergedNames: candidate.mergedNames,
          identity: candidate.identity,
          current: true,
          lastSeenAt: now,
        });
      } else {
        await ctx.db.insert('docSystemDiscoveries', {
          sourceId: source._id,
          slug: candidate.slug,
          displayName: candidate.displayName,
          class: candidate.class,
          ref: candidate.ref,
          quote: candidate.quote,
          url: candidate.url,
          evidence: candidate.evidence,
          mergedNames: candidate.mergedNames,
          identity: candidate.identity,
          current: true,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }
    }
    const systems = [...candidates.values()];
    const totals = { created: 0, updated: 0, retired: 0, scheduled: 0 };
    for (const agent of agents) {
      if (!agentReadsSource(agent, source._id)) continue;
      const charter = await ctx.db
        .query('charters')
        .withIndex('by_agent', (index) => index.eq('agentId', agent._id))
        .order('desc')
        .first();
      if (charter?.approved) {
        await backfillCharterProvenance(ctx, {
          agentId: agent._id,
          namedSystems: ((charter.body as Charter).namedSystems ?? []) as CharterSystemSeed[],
          now,
        });
      }
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
    return { applied: true, ...totals, accepted: systems.length };
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

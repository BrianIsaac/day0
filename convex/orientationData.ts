import { internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { agentReadsSource } from './docSources';
import type { Doc } from './_generated/dataModel';

/** Return declared surface rows for one server-authorised orientation run. */
export const surfacesForAgent = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'surfaces'>[]> =>
    await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
      .collect(),
});

/** Return every declared surface for the deployment-local intake sweep. */
export const surfacesForIntake = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<'surfaces'>[]> => await ctx.db.query('surfaces').collect(),
});

/** Return one surface and its owning agent for an isolated orientation job. */
export const surfaceForOrientation = internalQuery({
  args: { surfaceId: v.id('surfaces') },
  handler: async (
    ctx,
    args,
  ): Promise<{ surface: Doc<'surfaces'>; agent: Doc<'agents'> } | null> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) return null;
    const agent = await ctx.db.get(surface.agentId);
    if (!agent) return null;
    return { surface, agent };
  },
});

/**
 * Decide whether a surface belongs in the hourly provider re-probe.
 *
 * A connected surface is re-verified so liveness stays fresh. A surface the
 * last probe left `listed-dead` is retried as long as it still holds both
 * approvals and a credential, so a transient provider failure heals on the
 * next hour instead of waiting for a human to press Probe. `ungranted`
 * rows are not retried: nothing changes until a credential lands, and
 * landing one schedules its own probe.
 *
 * Args:
 *   surface: Persisted surface row.
 *
 * Returns:
 *   True when the hourly cron should probe it.
 */
export function isReprobeCandidate(surface: Doc<'surfaces'>): boolean {
  if (surface.verdict === 'connected') return true;
  return (
    surface.verdict === 'listed-dead' &&
    surface.credentialId !== undefined &&
    surface.managerApprovedAt !== undefined &&
    surface.itApprovedAt !== undefined
  );
}

/** Return the surfaces eligible for the hourly provider re-probe. */
export const reprobeCandidates = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<'surfaces'>[]> => {
    const surfaces = await ctx.db.query('surfaces').collect();
    return surfaces.filter(isReprobeCandidate);
  },
});

/** Return owner-linked documentation pages visible to one agent. */
export const pagesForAgent = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'docPages'>[]> => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent?.userId) return [];
    const sources = (
      await ctx.db
        .query('docSources')
        .withIndex('by_user', (index) => index.eq('userId', agent.userId!))
        .collect()
    ).filter((source) => agentReadsSource(agent, source._id));
    return (
      await Promise.all(
        sources.map(
          async (source) =>
            await ctx.db
              .query('docPages')
              .withIndex('by_source', (index) => index.eq('sourceId', source._id))
              .collect(),
        ),
      )
    ).flat();
  },
});

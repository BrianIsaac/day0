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

/** Return connected surfaces eligible for the hourly provider re-probe. */
export const connectedForReprobe = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<'surfaces'>[]> => {
    const surfaces = await ctx.db.query('surfaces').collect();
    return surfaces.filter((surface): boolean => surface.verdict === 'connected');
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

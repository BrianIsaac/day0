import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

/**
 * Store the bot id a chat probe read from the provider, fenced by generation.
 *
 * The probe calls this just before it records the connection, so a surface is
 * never connected, and the poll a fresh connection schedules never runs, with
 * the identity of an earlier credential still on the row. A probe that read no
 * bot id clears the field rather than leaving an older one behind.
 *
 * Args:
 *   surfaceId: Surface being verified.
 *   generation: The probe generation that read the identity.
 *   providerBotId: The `bot_id` the provider stamps on this credential's posts.
 *
 * Returns:
 *   Whether the identity was stored; false when a newer probe superseded it.
 */
export const recordBotIdentity = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    generation: v.number(),
    providerBotId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface) throw new Error('Surface not found.');
    if (surface.probeGeneration !== args.generation) return false;
    if (surface.providerBotId === args.providerBotId) return true;
    await ctx.db.patch(surface._id, { providerBotId: args.providerBotId });
    return true;
  },
});

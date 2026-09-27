import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { scheduleOrientationFor } from './surfaces';

/**
 * Put an `absent` system back to `declared` and orient it again.
 *
 * Internal: orientation calls it when the linked pages no longer hold the
 * absence it recorded (a page now names the system, or its denial is gone),
 * so an author who writes the missing page is not stuck behind a verdict
 * only a manager's re-run could clear. Writes the verdict, a
 * `surface.reopened` event and the orientation job in one transaction; a
 * surface that is no longer `absent` is left alone.
 *
 * @returns Whether the surface was re-opened.
 */
export const reopenAbsent = internalMutation({
  args: { surfaceId: v.id('surfaces'), reason: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.verdict !== 'absent') return false;
    await ctx.db.patch(surface._id, { verdict: 'declared', reason: args.reason });
    await ctx.db.insert('events', {
      agentId: surface.agentId,
      type: 'surface.reopened',
      payload: { surfaceId: surface._id, reason: args.reason },
      createdAt: Date.now(),
    });
    await scheduleOrientationFor(ctx, { ...surface, verdict: 'declared', reason: args.reason });
    return true;
  },
});

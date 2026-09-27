import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { scheduleOrientationFor } from './surfaces';
import { appendEvent } from './eventLog';
import { namedByCharter } from '../src/surfaces/charter-cards';

/**
 * What a re-open did: oriented the system again, left it declared for the
 * manager's Propose, or found it no longer `absent` and left it alone.
 */
export type ReopenOutcome = 'oriented' | 'awaiting-proposal' | 'not-absent';

/**
 * Put an `absent` system back to `declared`, and orient it again when the charter asks for it.
 *
 * Internal: orientation calls it when the linked pages no longer hold the
 * absence it recorded (a page now names the system, or its denial is gone),
 * so an author who writes the missing page is not stuck behind a verdict
 * only a manager's re-run could clear. A system the employee's charter does
 * not name (when the charter names work systems at all) waits for the
 * manager's Propose, as orientation would leave it; its reason says so, and
 * no orientation job is placed that would only decide to do nothing (review
 * m34). Writes the verdict, a `surface.reopened` event and any orientation
 * job in one transaction; a surface that is no longer `absent` is left alone.
 *
 * @param charterNamesSystems - Whether the employee's approved charter names any work system.
 * @returns What the re-open did.
 */
export const reopenAbsent = internalMutation({
  args: { surfaceId: v.id('surfaces'), charterNamesSystems: v.boolean() },
  handler: async (ctx, args): Promise<ReopenOutcome> => {
    const surface = await ctx.db.get(args.surfaceId);
    if (!surface || surface.verdict !== 'absent') return 'not-absent';
    const waitsForManager = args.charterNamesSystems && !namedByCharter(surface);
    const reason = waitsForManager
      ? `A linked page now records ${surface.displayName}. The charter does not name it, so it waits for the manager to propose it.`
      : `A linked page now records ${surface.displayName}; orientation runs again.`;
    await ctx.db.patch(surface._id, { verdict: 'declared', reason });
    await appendEvent(ctx, {
      agentId: surface.agentId,
      type: 'surface.reopened',
      payload: { surfaceId: surface._id, reason },
      createdAt: Date.now(),
    });
    if (waitsForManager) return 'awaiting-proposal';
    await scheduleOrientationFor(ctx, { ...surface, verdict: 'declared', reason });
    return 'oriented';
  },
});

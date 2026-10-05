import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type QueryCtx } from './_generated/server';
import {
  heartbeatWriteDue,
  socketBridgeConfigured,
  socketBridgeStateFor,
  type SocketBridgeState,
} from '../src/surfaces/slack-socket';

/*
 * The Socket Mode bridge's heartbeat (wave 13, 13-FS; D-6 (b), W12-R16). The bridge reports at each
 * sync, and whenever an app's connection is greeted or lost, which apps it holds a live connection
 * for (`POST /slack-socket/heartbeat`, `convex/slackSocket.ts`); this keeps one row per card,
 * written only when it says something new, and the card's buttons row and the decision request's
 * buttons read it. A table rather than a field of the card (13-K): a card written every half minute
 * would wake every reader of the card and contend with the work loop's transactions.
 */

const reportValidator = v.object({
  surfaceId: v.string(),
  appId: v.string(),
  live: v.boolean(),
  liveSince: v.optional(v.number()),
  failure: v.optional(v.string()),
});

/**
 * Internal, for the heartbeat route: keep one page of the bridge's report, one row per card. A row
 * is written for a card's first report, a change of liveness or app, and an unchanged report once
 * the row is about two minutes old; anything else is left, so the readers wake only for news. An
 * entry whose id names no chat card is dropped.
 *
 * @returns How many rows were written.
 */
export const recordHeartbeats = internalMutation({
  args: { reports: v.array(reportValidator) },
  returns: v.object({ written: v.number() }),
  handler: async (ctx, args): Promise<{ written: number }> => {
    const now = Date.now();
    let written = 0;
    for (const report of args.reports) {
      const surfaceId = ctx.db.normalizeId('surfaces', report.surfaceId);
      const surface = surfaceId === null ? null : await ctx.db.get(surfaceId);
      if (surface === null || surface.class !== 'chat') continue;
      const kept = await ctx.db
        .query('socketHeartbeats')
        .withIndex('by_surface', (q) => q.eq('surfaceId', surface._id))
        .first();
      if (!heartbeatWriteDue(kept, report, now)) continue;
      const row = {
        agentId: surface.agentId,
        surfaceId: surface._id,
        appId: report.appId,
        live: report.live,
        liveSince: report.live ? report.liveSince : undefined,
        reportedAt: now,
        failure: report.live ? undefined : report.failure,
      };
      if (kept === null) await ctx.db.insert('socketHeartbeats', row);
      else await ctx.db.replace(kept._id, row);
      written += 1;
    }
    return { written };
  },
});

/**
 * What a card knows of the bridge for its own app: `unconfigured` without the deployment's bridge
 * secret, `live` while the bridge's newest report on the card names its app live and is recent,
 * and `down` otherwise, a bridge from before 0.17.0 (which reports nothing) included.
 *
 * @param ctx - A query's or a mutation's context.
 * @param surface - The chat card the decision requests go through.
 * @param now - The clock, in epoch milliseconds.
 */
export async function socketBridgeStateOf(
  ctx: Pick<QueryCtx, 'db'>,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<SocketBridgeState> {
  if (!socketBridgeConfigured()) return 'unconfigured';
  const report = await ctx.db
    .query('socketHeartbeats')
    .withIndex('by_surface', (q) => q.eq('surfaceId', surface._id))
    .first();
  return socketBridgeStateFor(true, report, surface.provisioning?.appId, now);
}

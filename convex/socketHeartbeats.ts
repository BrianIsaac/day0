import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import {
  heartbeatWriteDue,
  SOCKET_HEARTBEAT_EXPIRY_MS,
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
 * entry whose id names no chat card is dropped. Each live row written schedules its own expiry
 * (`expire`), so a bridge that dies unseen is written down and the card re-renders.
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
      if (row.live) {
        await ctx.scheduler.runAfter(SOCKET_HEARTBEAT_EXPIRY_MS, internal.socketHeartbeats.expire, {
          surfaceId: surface._id,
          reportedAt: now,
        });
      }
      written += 1;
    }
    return { written };
  },
});

/**
 * Internal, scheduled by `recordHeartbeats`: write a card's live report down when nothing renewed
 * it since (the row still carries the `reportedAt` it was scheduled for), so every reader of the
 * row, the card's open page included, reads the bridge as down. A renewed or a changed row is left.
 */
export const expire = internalMutation({
  args: { surfaceId: v.id('surfaces'), reportedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query('socketHeartbeats')
      .withIndex('by_surface', (q) => q.eq('surfaceId', args.surfaceId))
      .first();
    if (row === null || !row.live || row.reportedAt !== args.reportedAt) return null;
    await ctx.db.patch(row._id, { live: false, liveSince: undefined });
    return null;
  },
});

/** How many chat cards one page of `heartbeatReport` reads; each reads its report. */
const REPORT_PAGE = 200;

/** One employee app in `check:access`'s socket row: whether the backend holds a live report of it. */
interface HeartbeatRow {
  readonly appId: string;
  readonly appName: string;
  readonly live: boolean;
}

/**
 * Internal, for `check:access` (13-FS): one page of the employee apps with an app-level token, each
 * with whether the backend holds a live and recent report of it from the bridge, so the socket row
 * can name an app the bridge holds whose card still reads the buttons as off.
 */
export const heartbeatReport = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ apps: HeartbeatRow[]; cursor: string | null }> => {
    const now = Date.now();
    const page = await ctx.db
      .query('surfaces')
      .withIndex('by_class', (q) => q.eq('class', 'chat'))
      .paginate({ cursor: args.cursor, numItems: REPORT_PAGE });
    const apps = await Promise.all(
      page.page.flatMap((surface) => {
        const app = surface.provisioning;
        if (app?.appLevelTokenCredentialId === undefined) return [];
        return [
          (async (): Promise<HeartbeatRow> => {
            const report = await ctx.db
              .query('socketHeartbeats')
              .withIndex('by_surface', (q) => q.eq('surfaceId', surface._id))
              .first();
            return {
              appId: app.appId,
              appName: app.appName,
              live: socketBridgeStateFor(true, report, app.appId, now) === 'live',
            };
          })(),
        ];
      }),
    );
    return { apps, cursor: page.isDone ? null : page.continueCursor };
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

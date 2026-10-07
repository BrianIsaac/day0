import type { TestConvex } from 'convex-test';
import type { Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';

/**
 * Give a Slack card the Socket Mode bridge's report on its own app, in the shape the bridge's
 * heartbeat route writes it (wave 13, 13-FS; D-6 (b)): live and reported now unless the test says
 * otherwise. Requests and the card offer buttons only while such a report is live and recent.
 *
 * @param harness - The test's backend.
 * @param surfaceId - The Slack card whose app the bridge reports on; it must carry its app.
 * @param report - What differs from a live report made now.
 * @returns The report's row.
 */
export async function reportBridgeOn(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
  report: { readonly live?: boolean; readonly reportedAt?: number; readonly appId?: string } = {},
): Promise<Id<'socketHeartbeats'>> {
  return await harness.run(async (ctx) => {
    const card = await ctx.db.get(surfaceId);
    if (!card?.provisioning) throw new Error('the card carries no app for the bridge to report on');
    const reportedAt = report.reportedAt ?? Date.now();
    const live = report.live ?? true;
    return await ctx.db.insert('socketHeartbeats', {
      agentId: card.agentId,
      surfaceId,
      appId: report.appId ?? card.provisioning.appId,
      live,
      ...(live ? { liveSince: reportedAt } : {}),
      reportedAt,
    });
  });
}

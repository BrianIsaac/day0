import { v } from 'convex/values';
import { mutation } from './_generated/server';
import { getCallerOrThrow } from './ownership';
import { deleteOwnedDocumentation } from './docSources';
import { purgeOwnedCredentials } from './credentials';

/**
 * Every table whose rows belong to one agent through an `agentId` field.
 *
 * `tests/convex/reset.test.ts` derives the same list from the schema and
 * fails when the two differ, so a new agent-keyed table cannot be missed here.
 */
export const AGENT_KEYED_TABLES = [
  'charters',
  'workspace',
  'voiceSessions',
  'workItems',
  'managerDecisionNotices',
  'managerNotes',
  'skills',
  'permissionGrants',
  'events',
  'surfaces',
  'mockDocs',
  'mockSpreadsheets',
  'mockSpreadsheetRows',
  'mockSlackChannels',
  'mockSlackMessages',
  'mockTweets',
  'mockTweetReplies',
  'mockTickets',
] as const;

/**
 * Wipe every record belonging to the signed-in user. Idempotent.
 * Called from the reset button on the landing page.
 *
 * Owner-level documentation and credentials outlive a plain reset. With
 * `alsoUnlinkDocumentation` every owned source is unlinked and every owned
 * credential is revoked with its ciphertext deleted; the credential rows
 * stay as the audit trail of what was held.
 */
export const deleteMyData = mutation({
  args: { alsoUnlinkDocumentation: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const identity = await getCallerOrThrow(ctx);
    const userId = identity.subject;

    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .collect();

    let deleted = 0;
    for (const agent of agents) {
      const agentId = agent._id;
      const tableDeletions: Array<Promise<unknown>> = [];
      for (const tableName of AGENT_KEYED_TABLES) {
        const rows = await ctx.db
          .query(tableName)
          .filter((q) => q.eq(q.field('agentId'), agentId))
          .collect();
        for (const row of rows) tableDeletions.push(ctx.db.delete(row._id));
      }
      await Promise.all(tableDeletions);
      await ctx.db.delete(agent._id);
      deleted += 1;
    }
    const unlinkedSources = args.alsoUnlinkDocumentation
      ? await deleteOwnedDocumentation(ctx, userId)
      : 0;
    if (args.alsoUnlinkDocumentation) await purgeOwnedCredentials(ctx, userId);
    return { deleted, unlinkedSources };
  },
});

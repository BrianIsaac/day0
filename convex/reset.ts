import { mutation } from './_generated/server';

/**
 * Wipe every record belonging to the signed-in user. Idempotent.
 * Called from the reset button on the landing page.
 */
export const deleteMyData = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('not authenticated');
    const userId = identity.subject;

    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .collect();

    let deleted = 0;
    for (const agent of agents) {
      const agentId = agent._id;
      // Delete all rows that reference this agentId across every per-agent table.
      const tableDeletions: Array<Promise<unknown>> = [];

      const collectAndDelete = async (
        tableName:
          | 'charters'
          | 'workspace'
          | 'voiceSessions'
          | 'workItems'
          | 'skills'
          | 'permissionGrants'
          | 'events'
          | 'mockDocs'
          | 'mockSpreadsheets'
          | 'mockSpreadsheetRows'
          | 'mockSlackChannels'
          | 'mockSlackMessages'
          | 'mockTweets'
          | 'mockTweetReplies'
          | 'mockTickets',
      ) => {
        const rows = await ctx.db
          .query(tableName)
          .filter((q) => q.eq(q.field('agentId'), agentId))
          .collect();
        for (const r of rows) {
          tableDeletions.push(ctx.db.delete(r._id));
        }
      };

      await collectAndDelete('charters');
      await collectAndDelete('workspace');
      await collectAndDelete('voiceSessions');
      await collectAndDelete('workItems');
      await collectAndDelete('skills');
      await collectAndDelete('permissionGrants');
      await collectAndDelete('events');
      await collectAndDelete('mockDocs');
      await collectAndDelete('mockSpreadsheets');
      await collectAndDelete('mockSpreadsheetRows');
      await collectAndDelete('mockSlackChannels');
      await collectAndDelete('mockSlackMessages');
      await collectAndDelete('mockTweets');
      await collectAndDelete('mockTweetReplies');
      await collectAndDelete('mockTickets');

      await Promise.all(tableDeletions);
      await ctx.db.delete(agent._id);
      deleted += 1;
    }
    return { deleted };
  },
});

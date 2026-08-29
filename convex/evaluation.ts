import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { assertOwnsAgent } from './ownership';
import { seedItemInTransaction, workItemSeedFields } from './work';
import { SURFACE_MODE } from '../src/lib/surface-mode';

function requireMockMode(): void {
  if (SURFACE_MODE !== 'mock') throw new Error('evaluation harness requires mock mode');
}

export const seedTasks = mutation({
  args: {
    agentId: v.id('agents'),
    tasks: v.array(v.object(workItemSeedFields)),
  },
  handler: async (ctx, args) => {
    requireMockMode();
    await assertOwnsAgent(ctx, args.agentId);
    if (args.tasks.length === 0 || args.tasks.length > 50) {
      throw new Error('evaluation task batch must contain between 1 and 50 tasks');
    }
    for (const task of args.tasks) {
      if (!task.externalId.startsWith('EVAL-')) {
        throw new Error('evaluation task external ids must start with EVAL-');
      }
    }
    return await Promise.all(
      args.tasks.map((task) => seedItemInTransaction(ctx, { agentId: args.agentId, ...task })),
    );
  },
});

export const snapshot = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    requireMockMode();
    await assertOwnsAgent(ctx, args.agentId);
    const [workItems, events, spreadsheets, slackMessages, tweetReplies, tickets] =
      await Promise.all([
        ctx.db
          .query('workItems')
          .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
          .collect(),
        ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
          .collect(),
        ctx.db
          .query('mockSpreadsheetRows')
          .withIndex('by_agent_sheet_tab', (q) => q.eq('agentId', args.agentId))
          .collect(),
        ctx.db
          .query('mockSlackMessages')
          .withIndex('by_agent_channel', (q) => q.eq('agentId', args.agentId))
          .collect(),
        ctx.db
          .query('mockTweetReplies')
          .withIndex('by_agent_tweet', (q) => q.eq('agentId', args.agentId))
          .collect(),
        ctx.db
          .query('mockTickets')
          .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
          .collect(),
      ]);
    return { workItems, events, spreadsheets, slackMessages, tweetReplies, tickets };
  },
});

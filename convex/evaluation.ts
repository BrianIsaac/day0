import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { assertOwnsAgent } from './ownership';
import { seedItemInTransaction, workItemSeedFields } from './work';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { isTerminalWorkState } from '../src/evaluation/states';

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

export const timeoutTask = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ timedOut: boolean }> => {
    requireMockMode();
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    await assertOwnsAgent(ctx, row.agentId);
    if (!row.externalId.startsWith('EVAL-')) {
      throw new Error('only evaluation work items may be timed out by the harness');
    }
    if (isTerminalWorkState(row.state)) return { timedOut: false };
    const reason = 'evaluation timeout: the task exceeded its declared wall-clock deadline';
    await ctx.db.patch(args.workItemId, {
      state: 'failed',
      skipReason: reason,
      executionRunId: undefined,
      pendingRunId: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      approvedIndexes: undefined,
      applyPhase: undefined,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'work.failed',
      payload: { workItemId: args.workItemId, reason, source: 'evaluation-harness' },
      createdAt: Date.now(),
    });
    return { timedOut: true };
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

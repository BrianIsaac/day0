import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { seedItemInTransaction, workItemSeedFields } from './work';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { isTerminalWorkState } from '../src/evaluation/states';
import { evaluationBedName, evaluationBedRefusal } from '../src/evaluation/bed-flag';
import { appendEvent } from './eventLog';

/**
 * Refuse a harness call outside mock mode or on a deployment that names no bed.
 *
 * @throws ConvexError naming the flag when the deployment is not a bed (N9).
 */
function requireEvaluationBed(what: string): void {
  if (SURFACE_MODE !== 'mock') throw new Error('evaluation harness requires mock mode');
  if (evaluationBedName() === undefined) throw new ConvexError(evaluationBedRefusal(what));
}

const originatingTicketFields = {
  slug: v.string(),
  title: v.string(),
  body: v.string(),
  status: v.union(
    v.literal('open'),
    v.literal('in-progress'),
    v.literal('blocked'),
    v.literal('done'),
  ),
  priority: v.string(),
} as const;

/**
 * Seed the harness's evaluation tasks onto an employee's queue. Public, guarded by
 * `getCallerOrThrow` first and then the employee's owner, on an evaluation bed in mock mode only.
 * Writes the work items.
 */
export const seedTasks = mutation({
  args: {
    agentId: v.id('agents'),
    tasks: v.array(
      v.object({
        ...workItemSeedFields,
        originatingTicket: v.optional(v.object(originatingTicketFields)),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await getCallerOrThrow(ctx);
    requireEvaluationBed('evaluation.seedTasks');
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
      args.tasks.map(async (task) => {
        const { originatingTicket, ...workItem } = task;
        if (originatingTicket) {
          if (!originatingTicket.slug.startsWith('REVOPS-EVAL-')) {
            throw new Error('evaluation ticket slugs must start with REVOPS-EVAL-');
          }
          const existing = await ctx.db
            .query('mockTickets')
            .withIndex('by_agent_slug', (q) =>
              q.eq('agentId', args.agentId).eq('slug', originatingTicket.slug),
            )
            .unique();
          if (!existing) {
            await ctx.db.insert('mockTickets', {
              agentId: args.agentId,
              ...originatingTicket,
              comments: [],
              updatedAt: Date.now(),
            });
          }
        }
        return await seedItemInTransaction(ctx, { agentId: args.agentId, ...workItem });
      }),
    );
  },
});

/**
 * Time an evaluation task out. Public, guarded by `getCallerOrThrow` first and then the item's
 * employee's owner, on an evaluation bed in mock mode only. Writes the item and its event.
 */
export const timeoutTask = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ timedOut: boolean }> => {
    await getCallerOrThrow(ctx);
    requireEvaluationBed('evaluation.timeoutTask');
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
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.failed',
      payload: { workItemId: args.workItemId, reason, source: 'evaluation-harness' },
      createdAt: Date.now(),
    });
    return { timedOut: true };
  },
});

/**
 * Fail an evaluation task's skill authoring. Public, guarded by `getCallerOrThrow` first and then
 * the item's employee's owner, on an evaluation bed in mock mode only. Writes the item and its
 * event.
 */
export const failSkillAuthoringAttempts = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ failed: boolean }> => {
    await getCallerOrThrow(ctx);
    requireEvaluationBed('evaluation.failSkillAuthoringAttempts');
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    await assertOwnsAgent(ctx, row.agentId);
    if (!row.externalId.startsWith('EVAL-')) {
      throw new Error('only evaluation work items may be failed by the harness');
    }
    if (isTerminalWorkState(row.state)) return { failed: false };
    const reason = 'skill-authoring-attempts-exhausted';
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
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.failed',
      payload: { workItemId: args.workItemId, reason, source: 'evaluation-harness' },
      createdAt: Date.now(),
    });
    return { failed: true };
  },
});

/**
 * The rows an evaluation run reads back for an employee. Public, guarded by `getCallerOrThrow`
 * first and then the employee's owner, on an evaluation bed in mock mode only. Writes nothing.
 */
export const snapshot = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await getCallerOrThrow(ctx);
    requireEvaluationBed('evaluation.snapshot');
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

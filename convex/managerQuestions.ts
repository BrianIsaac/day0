import { v } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsWorkItem } from './ownership';
import { amendCharterInTransaction, type AmendmentVia } from './charters';
import type { Charter } from '../src/agent/charter';
import { questionKey, sharedContentWords } from '../src/agent/manager-questions';

/**
 * Questions for the manager: the charter's open questions, asked once each
 * at the first plan approval whose plan or candidate touches them, and
 * answered into the charter as an amendment.
 *
 * The record shape is `ManagerQuestionRecord` (`src/agent/manager-questions.ts`)
 * and the table validator in `convex/schema.ts`. The planning pane reads
 * `forWorkItem` on the approval screen and calls `answer`, or
 * `answerQuestionInTransaction` from its own approve-with-answer mutation.
 */

/** The plan fields the question check reads; the rest of the plan is ignored. */
interface PlanText {
  summary?: string;
  steps?: string[];
  riskNotes?: string;
}

function planText(plan: unknown): string {
  const p = (plan ?? {}) as PlanText;
  return [p.summary ?? '', ...(p.steps ?? []), p.riskNotes ?? ''].join('\n');
}

/**
 * Ask, for one freshly drafted plan, every open question it touches.
 *
 * Runs inside the transaction that stores the plan. A question already
 * asked for this agent, on any work item, is not asked again; the answer
 * given there reaches the charter and every later plan reads it from the
 * charter.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item whose plan was just drafted.
 *   plan: The plan as stored.
 *
 * Returns:
 *   The records created.
 */
export async function askOpenQuestionsAtPlan(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  plan: unknown,
): Promise<Id<'managerQuestions'>[]> {
  const charter = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
    .order('desc')
    .first();
  if (!charter || !charter.approved) return [];
  const body = charter.body as Charter;
  const candidate = `${row.title}\n${row.contentSummary}`;
  const drafted = planText(plan);
  const now = Date.now();
  const created: Id<'managerQuestions'>[] = [];
  for (const question of body.openQuestions ?? []) {
    const key = questionKey(question);
    if (!key) continue;
    const planWords = sharedContentWords(question, drafted);
    const candidateWords = planWords.length > 0 ? [] : sharedContentWords(question, candidate);
    if (planWords.length === 0 && candidateWords.length === 0) continue;
    const existing = await ctx.db
      .query('managerQuestions')
      .withIndex('by_agent_key', (q) => q.eq('agentId', row.agentId).eq('key', key))
      .first();
    if (existing) continue;
    const context =
      planWords.length > 0
        ? { touchedBy: 'plan' as const, text: drafted.trim(), words: planWords }
        : { touchedBy: 'candidate' as const, text: candidate.trim(), words: candidateWords };
    const questionId = await ctx.db.insert('managerQuestions', {
      agentId: row.agentId,
      key,
      question,
      context,
      askedAt: now,
      workItemId: row._id,
      charterId: charter._id,
    });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'charter.question-asked',
      payload: { questionId, workItemId: row._id, question, touchedBy: context.touchedBy },
      createdAt: now,
    });
    created.push(questionId);
  }
  return created;
}

/**
 * Record the manager's answer and write it into the charter.
 *
 * The answer amends the latest charter when the question is still open
 * there. When the charter already carries an answer (given from the card),
 * the record takes the text without a second amendment.
 *
 * Args:
 *   ctx: Mutation context.
 *   record: The question, as read in this transaction.
 *   text: The manager's answer.
 *   via: How the answer arrived.
 *
 * Returns:
 *   The charter version the answer landed in, or null when none was needed.
 */
export async function answerQuestionInTransaction(
  ctx: MutationCtx,
  record: Doc<'managerQuestions'>,
  text: string,
  via: AmendmentVia,
): Promise<{ amendedCharterId: Id<'charters'> | null }> {
  if (record.answer) throw new Error('that question has already been answered');
  const answer = text.replace(/\s+/g, ' ').trim();
  if (!answer) throw new Error('the answer cannot be empty');
  const latest = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', record.agentId))
    .order('desc')
    .first();
  const stillOpen = ((latest?.body as Charter | undefined)?.openQuestions ?? []).some(
    (question: string): boolean => questionKey(question) === record.key,
  );
  let amendedCharterId: Id<'charters'> | null = null;
  if (latest?.approved && stillOpen) {
    const amended = await amendCharterInTransaction(ctx, {
      agentId: record.agentId,
      changes: [{ kind: 'answer-question', question: record.question, answer }],
      via,
      reason: `answer to: ${record.question}`,
    });
    amendedCharterId = amended.charterId;
  }
  await ctx.db.patch(record._id, {
    answer: {
      text: answer,
      answeredAt: Date.now(),
      via,
      ...(amendedCharterId ? { amendedCharterId } : {}),
    },
  });
  return { amendedCharterId };
}

/** The questions asked at this work item's plan, unanswered first. */
export const forWorkItem = query({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<Doc<'managerQuestions'>[]> => {
    await assertOwnsWorkItem(ctx, args.workItemId);
    const rows = await ctx.db
      .query('managerQuestions')
      .withIndex('by_work_item', (q) => q.eq('workItemId', args.workItemId))
      .collect();
    return rows.sort((a, b) => Number(Boolean(a.answer)) - Number(Boolean(b.answer)));
  },
});

/** Every question still waiting on the manager, oldest first. */
export const openForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<Doc<'managerQuestions'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const rows = await ctx.db
      .query('managerQuestions')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .collect();
    return rows.filter((row) => !row.answer);
  },
});

/** Answer one question from the dashboard; the answer amends the charter. */
export const answer = mutation({
  args: { questionId: v.id('managerQuestions'), text: v.string() },
  handler: async (ctx, args): Promise<{ amendedCharterId: Id<'charters'> | null }> => {
    const record = await ctx.db.get(args.questionId);
    if (!record) throw new Error('question not found');
    await assertOwnsAgent(ctx, record.agentId);
    return await answerQuestionInTransaction(ctx, record, args.text, 'dashboard');
  },
});

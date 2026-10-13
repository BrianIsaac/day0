import { ConvexError, v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  assertOwnsAgent,
  assertOwnsWorkItem,
  getCallerOrThrow,
  verifiedAddressOf,
} from './ownership';
import { amendCharterInTransaction } from './charters';
import {
  citeConflictOf,
  conflictsLeanedOn,
  conflictsOnPlanBlocks,
  planLeansOnConflict,
  standingConflictOf,
} from './docConflicts';
import type { CiteConflictPage } from '../src/work/types';
import type { RequestQuestion } from '../src/work/manager-channel';
import { slackEscaped } from '../src/surfaces/slack-markup';
import { providerTsToMs } from '../src/work/provider-ts';
import { conflictBlocks } from './docRelationProposals';
import { decideRelationInTransaction } from './docRelations';
import {
  CONFLICT_CHOICES,
  CONFLICT_QUESTION_CLOSED,
  conflictChoiceWords,
  type ConflictChoice,
} from '../src/agent/reorientation-words';
import type { CharterAnswerVia } from '../src/events/contract';
import type { Charter } from '../src/agent/charter';
import {
  isOpenQuestion,
  managerOpenQuestions,
  questionKey,
  sharedContentWords,
} from '../src/agent/manager-questions';
import { closeQuestionsOfRelation } from './questionCloses';
import { appendEvent } from './eventLog';

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
  for (const question of managerOpenQuestions(body)) {
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
    await appendEvent(ctx, {
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
 * the record takes the text without a second amendment. Either way one
 * `charter.question-answered` event says whether the charter changed.
 *
 * Args:
 *   ctx: Mutation context.
 *   record: The question, as read in this transaction.
 *   text: The manager's answer.
 *   via: How the answer arrived: the dashboard or a plan approval (`CharterAnswerVia`).
 *
 * Returns:
 *   The charter version the answer landed in, or null when none was needed.
 */
export async function answerQuestionInTransaction(
  ctx: MutationCtx,
  record: Doc<'managerQuestions'>,
  text: string,
  via: CharterAnswerVia,
): Promise<{ amendedCharterId: Id<'charters'> | null }> {
  if (record.answer) throw new Error('that question has already been answered');
  if (record.closed) throw new Error('that question was closed without an answer');
  const answer = text.replace(/\s+/g, ' ').trim();
  if (!answer) throw new Error('the answer cannot be empty');
  const latest = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', record.agentId))
    .order('desc')
    .first();
  const stillOpen = managerOpenQuestions(
    (latest?.body as Charter | undefined) ?? { openQuestions: [] },
  ).some((question: string): boolean => questionKey(question) === record.key);
  const currentBody = latest?.body as Charter | undefined;
  const priorAnswer = currentBody?.answeredQuestions?.find(
    (entry) => questionKey(entry.question) === record.key,
  );
  if (
    !latest?.approved ||
    (!stillOpen && priorAnswer?.answer.replace(/\s+/g, ' ').trim() !== answer)
  ) {
    throw new Error('that question is no longer open on the current charter; refresh the plan');
  }
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
  // Every answer is one reorientation the manager settled, whether or not
  // it changed the charter: A9's acceptance figure reads the pair.
  await appendEvent(ctx, {
    agentId: record.agentId,
    type: 'charter.question-answered',
    payload: {
      questionId: record._id,
      via,
      amended: amendedCharterId !== null,
      ...(amendedCharterId ? { charterId: amendedCharterId } : {}),
    },
    createdAt: Date.now(),
  });
  return { amendedCharterId };
}

/** The questions asked at this work item's plan, those still open first. */
export const forWorkItem = query({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<Doc<'managerQuestions'>[]> => {
    await assertOwnsWorkItem(ctx, args.workItemId);
    const rows = await ctx.db
      .query('managerQuestions')
      .withIndex('by_work_item', (q) => q.eq('workItemId', args.workItemId))
      .take(ITEM_QUESTIONS_READ);
    return rows.sort((a, b) => Number(!isOpenQuestion(a)) - Number(!isOpenQuestion(b)));
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
    const charter = await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .first();
    const open = new Set(
      charter?.approved ? managerOpenQuestions(charter.body as Charter).map(questionKey) : [],
    );
    return rows.filter((row) => isOpenQuestion(row) && open.has(row.key));
  },
});

/**
 * Answer one question from the dashboard; the answer amends the charter. Public, guarded by
 * `getCallerOrThrow` first and then the question's employee's owner.
 */
export const answer = mutation({
  args: { questionId: v.id('managerQuestions'), text: v.string() },
  handler: async (ctx, args): Promise<{ amendedCharterId: Id<'charters'> | null }> => {
    await getCallerOrThrow(ctx);
    const record = await ctx.db.get(args.questionId);
    if (!record) throw new Error('question not found');
    await assertOwnsAgent(ctx, record.agentId);
    return await answerQuestionInTransaction(ctx, record, args.text, 'dashboard');
  },
});

/** Why a conflict's answer was refused, in the card's words. */
export const CONFLICT_ANSWER_REFUSALS = {
  gone: 'That question is no longer stored.',
  notConflict: 'That question is not about two pages that disagree.',
  answered: 'That question has already been answered.',
  /** Closed when its plan was drafted again: the plan that stands now asks its own. */
  redrafted: 'That question was closed when the plan was drafted again.',
  /** Closed because its conflict stopped standing. */
  closed: CONFLICT_QUESTION_CLOSED,
  /** The conflict stopped standing since the card was drawn: nothing is decided or recorded. */
  settled: 'These two pages no longer disagree as they did, so nothing is recorded.',
} as const;

/** The decision of the relation an answer stands for. */
const DECISION_OF: Readonly<Record<ConflictChoice, 'from-is-right' | 'to-is-right' | 'both-hold'>> =
  { from: 'from-is-right', to: 'to-is-right', both: 'both-hold' };

/**
 * Answer a conflict's question beside its plan (RM20 (a)): the answer decides the relation as the
 * Documentation tab's card would (the first page right, the second, or both hold), and the record
 * of the question keeps the answer and where it was given. A conflict the manager settled
 * elsewhere meanwhile is not decided again; the answer is kept. The steps the plan withheld for it
 * are redrafted on Retry.
 *
 * @param ctx - The answer's transaction.
 * @param question - The question, as read in this transaction.
 * @param answer - The choice, where it was given, and the manager's verified address.
 * @returns The answer in words, for the card and the Slack acknowledgement.
 * @throws ConvexError when the question is not a conflict's or was answered.
 */
export async function answerConflictInTransaction(
  ctx: MutationCtx,
  question: Doc<'managerQuestions'>,
  answer: {
    readonly choice: ConflictChoice;
    readonly via: 'dashboard' | 'slack';
    readonly decidedBy: string | undefined;
  },
): Promise<{ text: string }> {
  if (question.type !== 'retrieval' || question.relationId === undefined) {
    throw new ConvexError(CONFLICT_ANSWER_REFUSALS.notConflict);
  }
  if (question.answer !== undefined) throw new ConvexError(CONFLICT_ANSWER_REFUSALS.answered);
  if (question.closed !== undefined) {
    throw new ConvexError(
      question.closed.reason === 'redrafted'
        ? CONFLICT_ANSWER_REFUSALS.redrafted
        : CONFLICT_ANSWER_REFUSALS.closed,
    );
  }
  const relation = await ctx.db.get(question.relationId);
  const standing = await standingConflictOf(ctx, relation);
  // A card clicked after the conflict settled or a page left decides nothing, so it records
  // nothing either: an answer kept with nothing decided read as a decision made (W16-R27).
  if (relation === null || standing === undefined) {
    throw new ConvexError(CONFLICT_ANSWER_REFUSALS.settled);
  }
  const text = conflictChoiceWords(answer.choice, citeConflictOf(standing).pages);
  await decideRelationInTransaction(ctx, relation, DECISION_OF[answer.choice], {
    decidedBy: answer.decidedBy,
    via: answer.via,
  });
  await ctx.db.patch(question._id, {
    answer: { text, answeredAt: Date.now(), via: answer.via },
  });
  return { text };
}

/**
 * Answer a conflict's question from the plan's card on the dashboard. Public, guarded by
 * `getCallerOrThrow` first and then the question's employee's owner. Writes the relation's
 * decision, with what it sets off, and the question's answer.
 */
export const answerConflict = mutation({
  args: {
    questionId: v.id('managerQuestions'),
    choice: v.union(...CONFLICT_CHOICES.map((choice) => v.literal(choice))),
  },
  handler: async (ctx, args): Promise<{ text: string }> => {
    const caller = await getCallerOrThrow(ctx);
    const question = await ctx.db.get(args.questionId);
    if (question === null) throw new ConvexError(CONFLICT_ANSWER_REFUSALS.gone);
    await assertOwnsAgent(ctx, question.agentId);
    return await answerConflictInTransaction(ctx, question, {
      choice: args.choice,
      via: 'dashboard',
      decidedBy: verifiedAddressOf(caller),
    });
  },
});

/**
 * The questions one item's reads take (standard 10.4): an item asks one question per open charter
 * question its plan touched and one per conflict under it, a handful in practice.
 */
const ITEM_QUESTIONS_READ = 100;

/** The conflict questions one item's plans raised that are still open, oldest first. */
export async function openConflictQuestions(
  ctx: Pick<QueryCtx, 'db'>,
  workItemId: Id<'workItems'>,
): Promise<Doc<'managerQuestions'>[]> {
  return (
    await ctx.db
      .query('managerQuestions')
      .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
      .take(ITEM_QUESTIONS_READ)
  ).filter(
    (question) =>
      question.type === 'retrieval' &&
      question.relationId !== undefined &&
      isOpenQuestion(question),
  );
}

/** The agent's questions the poll's check reads back, newest first (standard 10.4). */
const QUESTIONS_OWED_READ = 100;

/**
 * Whether a conflict's question beside a plan whose request went to this DM still waits for its
 * answer (the second pass's M1): the question holds nothing of the plan, so the manager may answer
 * long after the request was decided, and the poll reads the DM until the conflict is settled or
 * answered. A question whose conflict no longer stands waits for nothing.
 *
 * @param ctx - The poll's query context.
 * @param surface - The manager channel's card.
 * @param channel - Its DM's id.
 */
export async function conflictAnswerOwedOn(
  ctx: QueryCtx,
  surface: Pick<Doc<'surfaces'>, 'agentId' | 'slug'>,
  channel: string,
): Promise<boolean> {
  const questions = await ctx.db
    .query('managerQuestions')
    .withIndex('by_agent', (q) => q.eq('agentId', surface.agentId))
    .order('desc')
    .take(QUESTIONS_OWED_READ);
  for (const question of questions) {
    if (question.type !== 'retrieval' || question.relationId === undefined) continue;
    if (!isOpenQuestion(question)) continue;
    const decision = (await ctx.db.get(question.workItemId))?.decision;
    if (decision?.kind !== 'plan' || decision.surfaceSlug !== surface.slug) continue;
    if (decision.channel !== channel) continue;
    if ((await standingConflictOf(ctx, await ctx.db.get(question.relationId))) !== undefined) {
      return true;
    }
  }
  return false;
}

/** One of an item's conflict questions, with the number the manager answers it by. */
export interface NumberedConflictQuestion {
  /**
   * Its place among the conflict questions asked beside the item's plans, in the order they were
   * asked and whatever became of them (17-C, decision C-4): answering or closing one never
   * renumbers another, so a number typed from an old message still names the question it named.
   */
  readonly number: number;
  readonly question: Doc<'managerQuestions'>;
  /** Whether it still waits for its answer and its conflict still stands. */
  readonly standing: boolean;
}

/**
 * Every conflict question asked beside an item's plans, oldest first, each with its number and
 * whether it still stands: what a numbered answer names and what a request numbers (17-C;
 * W16-R27, where a typed answer went to the first standing question whatever the manager meant).
 */
export async function numberedConflictQuestions(
  ctx: QueryCtx,
  workItemId: Id<'workItems'>,
): Promise<NumberedConflictQuestion[]> {
  const asked = (
    await ctx.db
      .query('managerQuestions')
      .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
      .take(ITEM_QUESTIONS_READ)
  ).filter((question) => question.type === 'retrieval' && question.relationId !== undefined);
  const numbered: NumberedConflictQuestion[] = [];
  for (const [index, question] of asked.entries()) {
    const relation =
      isOpenQuestion(question) && question.relationId !== undefined
        ? await ctx.db.get(question.relationId)
        : null;
    numbered.push({
      number: index + 1,
      question,
      standing: relation !== null && (await standingConflictOf(ctx, relation)) !== undefined,
    });
  }
  return numbered;
}

/** What becomes of a queued question notice when its send looks at it. */
export type QuestionNoticeOwed =
  /** Posted now, in the request's thread; numbered where the plan has several standing. */
  | {
      readonly state: 'send';
      readonly questionId: Id<'managerQuestions'>;
      readonly threadTs: string;
      readonly number?: number;
    }
  /** The request is still on its way out: looked at again shortly. */
  | { readonly state: 'wait' }
  /** Nothing to post: the notice is dropped. */
  | { readonly state: 'drop' };

/**
 * Whether a queued question notice is still owed (17-C): posted when its question is open, its
 * conflict stands, and the request it was queued for is the item's own, delivered, and did not
 * carry the question in its body. A request still in flight is waited for; one that failed is
 * resent with the question in it. Whether the body carried the question is read off the times: a
 * question asked after the provider took the request was not in it, and one asked while the
 * request was on its way out, when the body was built before or after it, is looked for in the
 * request's own text. Read by `work.prepareManagerReplyNotice`.
 */
export async function questionNoticeOwed(
  ctx: QueryCtx,
  notice: Pick<Doc<'managerDecisionNotices'>, 'questionId' | 'workItemId' | 'decisionId'>,
): Promise<QuestionNoticeOwed> {
  const [question, row] = await Promise.all([
    notice.questionId === undefined ? null : ctx.db.get(notice.questionId),
    ctx.db.get(notice.workItemId),
  ]);
  const decision = row?.decision;
  if (question === null || decision === undefined) return { state: 'drop' };
  if (decision.id !== notice.decisionId || decision.kind !== 'plan') return { state: 'drop' };
  const numbered = await numberedConflictQuestions(ctx, notice.workItemId);
  const asked = numbered.find((entry) => entry.question._id === question._id);
  if (asked === undefined || !asked.standing) return { state: 'drop' };
  if (decision.ts === undefined) {
    return decision.requestFailedAt === undefined ? { state: 'wait' } : { state: 'drop' };
  }
  const deliveredAt = providerTsToMs(decision.ts);
  if (
    (deliveredAt === null || question._creationTime <= deliveredAt) &&
    decision.requestText?.includes(slackEscaped(question.question)) === true
  ) {
    return { state: 'drop' };
  }
  const several = numbered.filter((entry) => entry.standing).length > 1;
  return {
    state: 'send',
    questionId: question._id,
    threadTs: decision.ts,
    ...(several ? { number: asked.number } : {}),
  };
}

/**
 * The conflict questions a plan's decision request carries, each with its words and its number.
 * Internal; read by `managerChannelActions.requestDecision`.
 */
export const conflictQuestionsForRequest = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<RequestQuestion[]> =>
    (await numberedConflictQuestions(ctx, args.workItemId))
      .filter((numbered) => numbered.standing)
      .map((numbered) => ({ text: numbered.question.question, number: numbered.number })),
});

/**
 * Close the item's open conflict questions whose conflict no longer stands (17-C): a page was
 * archived, edited or removed since, or the two are no longer trusted alike, by a path that did
 * not pass the relation's own decision. Internal; called by the run before it reads what it holds
 * (`workActions.withConflictsHeld`), so a question nobody can answer is closed by the first run
 * that would have waited on it. Writes `closed: settled` on each; returns how many.
 */
export const closeSettled = internalMutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<number> => {
    const now = Date.now();
    let closed = 0;
    for (const question of await openConflictQuestions(ctx, args.workItemId)) {
      const relationId = question.relationId;
      if (relationId === undefined) continue;
      if ((await standingConflictOf(ctx, await ctx.db.get(relationId))) !== undefined) continue;
      closed += await closeQuestionsOfRelation(ctx, relationId, now);
    }
    return closed;
  },
});

/**
 * What the apply holds for a plan's unanswered conflict questions (RM20 (a)): each question, its
 * relation and the hashes of the blocks its pages disagree in, by which the plan's steps that rely
 * on the passage are found, and whether the plan's own words lean on the conflict, which holds
 * every step where no cite carries it (D-1 (c)). Internal; read by `workActions` before a set is
 * gated.
 */
export const conflictHoldsFor = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{ question: string; relationId: string; blocks: string[]; leaned: boolean }>
  > => {
    const holds: Array<{
      question: string;
      relationId: string;
      blocks: string[];
      leaned: boolean;
    }> = [];
    const plan = (await ctx.db.get(args.workItemId))?.plan;
    for (const question of await openConflictQuestions(ctx, args.workItemId)) {
      const relation = question.relationId ? await ctx.db.get(question.relationId) : null;
      // A conflict that no longer stands holds nothing, whatever became of its question.
      const standing = relation === null ? undefined : await standingConflictOf(ctx, relation);
      if (relation === null || standing === undefined) continue;
      holds.push({
        question: question.question,
        relationId: relation._id,
        blocks: [...conflictBlocks(relation)],
        leaned: planLeansOnConflict(plan, citeConflictOf(standing)),
      });
    }
    return holds;
  },
});

/**
 * The first conflict that stands on the blocks an approved plan relies on and that nobody asked
 * about beside it (D-4 (b)): confirmed since the plan was approved, so the run stops with the two
 * pages named and Retry drafts it again. The blocks are the plan's cited ones, or, where it cites
 * nothing, those its selection recorded, or, where the planner read the whole mirror, every pair of
 * pages the employee reads; and a conflict the plan names in its own words and cites nowhere
 * (D-1 (c)). Internal; read by `workActions.refuseGoneCites`.
 */
export const conflictConfirmedSince = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<{ heading: string; pages: [CiteConflictPage, CiteConflictPage] } | null> => {
    const row = await ctx.db.get(args.workItemId);
    const agent = row === null ? null : await ctx.db.get(row.agentId);
    if (row === null || agent?.userId === undefined) return null;
    // A relation with a question still open is the hold's; one whose only questions are answered
    // stands again (settled as both holding, taken back and confirmed anew), and nobody was asked
    // about it as it stands now (W16-R27).
    const asked = new Set(
      (await openConflictQuestions(ctx, row._id)).flatMap((question) =>
        question.relationId === undefined ? [] : [question.relationId],
      ),
    );
    for (const conflict of [
      ...(await conflictsOnPlanBlocks(ctx, row, agent)),
      ...(await conflictsLeanedOn(ctx, row, agent)),
    ]) {
      if (asked.has(conflict.relationId as Id<'docRelations'>)) continue;
      return { heading: conflict.heading, pages: [conflict.pages[0], conflict.pages[1]] };
    }
    return null;
  },
});

/** A conflict's question as the plan's card draws it: the question, the two pages, the item. */
export interface ConflictQuestionView {
  readonly _id: Id<'managerQuestions'>;
  readonly workItemId: Id<'workItems'>;
  readonly question: string;
  /** The two pages, first and second, while the conflict still stands; null once it does not. */
  readonly pages: readonly [CiteConflictPage, CiteConflictPage] | null;
}

/** The conflict questions one read of an employee's takes: one a plan and conflict, few open. */
const OPEN_CONFLICTS_READ = 50;

/**
 * The conflict questions still waiting beside an employee's plans (RM20 (a)), each with the two
 * pages its answers name, for the Work tab's cards. Public, guarded by the employee's owner.
 */
export const conflictsForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<ConflictQuestionView[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const rows = await ctx.db
      .query('managerQuestions')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .take(OPEN_CONFLICTS_READ * 4);
    const views: ConflictQuestionView[] = [];
    for (const row of rows) {
      if (row.type !== 'retrieval' || row.relationId === undefined || !isOpenQuestion(row)) {
        continue;
      }
      if (views.length >= OPEN_CONFLICTS_READ) break;
      const standing = await standingConflictOf(ctx, await ctx.db.get(row.relationId));
      const pages = standing === undefined ? null : citeConflictOf(standing).pages;
      views.push({
        _id: row._id,
        workItemId: row.workItemId,
        question: row.question,
        pages: pages === null ? null : [pages[0], pages[1]],
      });
    }
    return views;
  },
});

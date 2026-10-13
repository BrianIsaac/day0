import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { isOpenQuestion, type ManagerQuestionCloseReason } from '../src/agent/manager-questions';

/*
 * A conflict's question closed without an answer (wave 17, 17-C; the schema's
 * `managerQuestions.closed` is 17-K's): its plan was drafted again, so the new plan is asked
 * afresh on what it rests on, or its conflict stopped standing, so nothing waits on it. The
 * charter's own questions are never closed here: each is asked once an employee and its answer
 * amends the charter, whichever plan raised it.
 *
 * This module is a floor: it imports no `convex/` module, so every site that sends a plan back to
 * drafting (`planRedraft`, `workApply`, `skillControls`, `workRuns`), the relation's decision
 * (`docRelations`) and a page's change of status (`docStatus`) can call it without an edge towards
 * `work`. It registers no function.
 */

/** The questions one item's close reads: one a conflict under its plans, a handful in practice. */
const ITEM_QUESTIONS_READ = 100;

/** The questions about one relation one close reads: one a work item, few items a relation. */
const RELATION_QUESTIONS_READ = 500;

/**
 * The confirmed conflicts read from or to one page: a pair holds one, and a page disagrees with a
 * handful of others at most.
 */
const CONFLICTS_OF_A_PAGE = 32;

/** Whether a question asks which of two pages is right. */
function isConflictQuestion(question: Doc<'managerQuestions'>): boolean {
  return question.type === 'retrieval' && question.relationId !== undefined;
}

/** Close each question that is a conflict's and still open; the count closed. */
async function closeOpen(
  ctx: MutationCtx,
  questions: readonly Doc<'managerQuestions'>[],
  reason: ManagerQuestionCloseReason,
  now: number,
): Promise<number> {
  const open = questions.filter(
    (question) => isConflictQuestion(question) && isOpenQuestion(question),
  );
  for (const question of open) {
    await ctx.db.patch(question._id, { closed: { reason, at: now } });
  }
  return open.length;
}

/**
 * Close an item's open conflict questions because its plan is being drafted again (`redrafted`):
 * the plan they were asked beside is gone, and the new one is asked on what it cites. Called in
 * the transaction that clears the plan, by every site that does. An answered question keeps its
 * answer.
 *
 * @param ctx - The redraft's transaction.
 * @param workItemId - The item whose plan goes.
 * @param now - The transaction's time.
 * @returns How many were closed.
 */
export async function closeQuestionsAtRedraft(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  now: number,
): Promise<number> {
  const asked = await ctx.db
    .query('managerQuestions')
    .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
    .take(ITEM_QUESTIONS_READ);
  return await closeOpen(ctx, asked, 'redrafted', now);
}

/**
 * Close every open question about one relation because its conflict no longer stands
 * (`settled`): nobody can answer which page is right once the two no longer disagree. The caller
 * has established that it does not stand.
 *
 * @param ctx - The transaction in which the conflict stopped standing, or one that found it so.
 * @param relationId - The relation the questions ask about.
 * @param now - The transaction's time.
 * @returns How many were closed.
 */
export async function closeQuestionsOfRelation(
  ctx: MutationCtx,
  relationId: Id<'docRelations'>,
  now: number,
): Promise<number> {
  const asked = await ctx.db
    .query('managerQuestions')
    .withIndex('by_relation', (q) => q.eq('relationId', relationId))
    .take(RELATION_QUESTIONS_READ);
  return await closeOpen(ctx, asked, 'settled', now);
}

/**
 * Close the open questions of every confirmed conflict one page is an end of, because the page
 * stopped being current (superseded, archived, gone) and no conflict stands on a page that is not
 * (`docConflicts.standingConflictOf`). Called where a page's status leaves `active`.
 *
 * @param ctx - The transaction that changed the page.
 * @param page - The page that is no longer current.
 * @param now - The transaction's time.
 * @returns How many were closed.
 */
export async function closeQuestionsOnPage(
  ctx: MutationCtx,
  page: { readonly sourceId: Id<'docSources'>; readonly ref: string },
  now: number,
): Promise<number> {
  // The index names the page; the kind and the status are read off the rows it gives, so a page
  // with many proposals still gives its confirmed conflicts first to last.
  const [from, to] = await Promise.all([
    ctx.db
      .query('docRelations')
      .withIndex('by_from', (q) => q.eq('from.sourceId', page.sourceId).eq('from.ref', page.ref))
      .filter((q) =>
        q.and(q.eq(q.field('kind'), 'possible_conflict'), q.eq(q.field('status'), 'confirmed')),
      )
      .take(CONFLICTS_OF_A_PAGE),
    ctx.db
      .query('docRelations')
      .withIndex('by_to', (q) => q.eq('to.sourceId', page.sourceId).eq('to.ref', page.ref))
      .filter((q) =>
        q.and(q.eq(q.field('kind'), 'possible_conflict'), q.eq(q.field('status'), 'confirmed')),
      )
      .take(CONFLICTS_OF_A_PAGE),
  ]);
  let closed = 0;
  for (const relation of [...from, ...to]) {
    closed += await closeQuestionsOfRelation(ctx, relation._id, now);
  }
  return closed;
}

import type { TestConvex } from 'convex-test';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';

/*
 * A conflict's question beside an item's plan, seeded as rows (wave 17, 17-C): a confirmed
 * conflict between two pages of one source and the open `retrieval` question that asks which is
 * right, for the tests of what closes it. No page is stored: the closes read the question and the
 * relation, never whether the conflict stands.
 */

/** A harness over the tree's schema. */
export type Harness = TestConvex<typeof schema>;

/** What the seed left: the relation, its question and the two pages' refs. */
export interface SeededConflictQuestion {
  readonly sourceId: Id<'docSources'>;
  readonly relationId: Id<'docRelations'>;
  readonly questionId: Id<'managerQuestions'>;
  readonly from: string;
  readonly to: string;
}

/**
 * Seed a confirmed conflict and its open question beside one item.
 *
 * @param harness - The convex-test harness.
 * @param item - The item the question is asked beside, and its employee.
 * @param fields - Fields of the question to set over the seed's (an answer, a close).
 */
export async function seedConflictQuestion(
  harness: Harness,
  item: { readonly agentId: Id<'agents'>; readonly workItemId: Id<'workItems'> },
  fields: Partial<Doc<'managerQuestions'>> & { readonly pages?: readonly [string, string] } = {},
): Promise<SeededConflictQuestion> {
  const { pages = ['revops/limits.md', 'policies/limits.md'], ...question } = fields;
  const [from, to] = pages;
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Handbook',
      kind: 'folder',
      locator: '.',
      status: 'linking',
      createdAt: 1,
      updatedAt: 1,
    });
    const relationId = await ctx.db.insert('docRelations', {
      userId: 'owner',
      from: { sourceId, ref: from },
      to: { sourceId, ref: to },
      kind: 'possible_conflict',
      evidence: [{ measure: 'heading-figures', value: 1, blockRefs: ['h-from', 'h-to'] }],
      status: 'confirmed',
      createdAt: 1,
    });
    const charterId = await ctx.db.insert('charters', {
      agentId: item.agentId,
      version: '0.1',
      body: { proposedFunction: 'Revenue operations coordination' },
      approved: true,
      approvedAt: 1,
      createdAt: 1,
    });
    const questionId = await ctx.db.insert('managerQuestions', {
      agentId: item.agentId,
      key: `conflict:${relationId}`,
      question: 'Two pages disagree under “Comment length”. Which is right?',
      context: { touchedBy: 'plan', text: 'Comment length', words: [] },
      askedAt: 1,
      workItemId: item.workItemId,
      charterId,
      blocking: false,
      type: 'retrieval',
      relationId,
      ...question,
    });
    return { sourceId, relationId, questionId, from, to };
  });
}

/** A question as stored now. */
export async function questionOf(
  harness: Harness,
  questionId: Id<'managerQuestions'>,
): Promise<Doc<'managerQuestions'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(questionId));
  if (row === null) throw new Error('question missing');
  return row;
}

/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as questionCloses from '../../convex/questionCloses';
import {
  closeQuestionsAtRedraft,
  closeQuestionsOfRelation,
  closeQuestionsOnPage,
} from '../../convex/questionCloses';
import { allConvexModules } from './all-modules';
import { questionOf, seedConflictQuestion, type Harness } from './fakes/conflict-question';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { registeredIn } from './registered-functions';

/**
 * A conflict's question closed without an answer (`convex/questionCloses.ts`; wave 17, 17-C): at a
 * redraft, at its relation's settling and at a page's leaving use. Each close is read back off the
 * question's row.
 */

const NOW = 1_787_768_413_000;

/** An employee and one of its items, plan-pending. */
async function seedItem(
  harness: Harness,
  externalId = 'REVOPS-1',
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'deployed',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId,
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'plan-pending',
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

describe('closeQuestionsAtRedraft', (): void => {
  it('closes the item’s open conflict questions as redrafted and leaves an answered one, a charter question and another item’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const item = await seedItem(harness);
    const other = await seedItem(harness, 'REVOPS-2');
    const open = await seedConflictQuestion(harness, item);
    const answered = await seedConflictQuestion(harness, item, {
      answer: { text: 'Both hold', answeredAt: 5, via: 'dashboard' },
    });
    const elsewhere = await seedConflictQuestion(harness, other);
    const charterQuestion = await harness.run(async (ctx) => {
      const asked = await ctx.db.get(open.questionId);
      return await ctx.db.insert('managerQuestions', {
        agentId: item.agentId,
        key: 'who approves refunds',
        question: 'Who approves refunds?',
        context: { touchedBy: 'plan', text: 'Refund the customer.', words: ['refunds'] },
        askedAt: 1,
        workItemId: item.workItemId,
        charterId: asked!.charterId,
      });
    });

    const closed = await harness.run(
      async (ctx) => await closeQuestionsAtRedraft(ctx, item.workItemId, NOW),
    );

    expect(closed).toBe(1);
    expect((await questionOf(harness, open.questionId)).closed).toEqual({
      reason: 'redrafted',
      at: NOW,
    });
    const kept = await questionOf(harness, answered.questionId);
    expect(kept.closed).toBeUndefined();
    expect(kept.answer?.text).toBe('Both hold');
    expect((await questionOf(harness, charterQuestion)).closed).toBeUndefined();
    expect((await questionOf(harness, elsewhere.questionId)).closed).toBeUndefined();
  });
});

describe('closeQuestionsOfRelation', (): void => {
  it('closes every open question about the relation as settled, on whichever item, and never a second time', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const item = await seedItem(harness);
    const other = await seedItem(harness, 'REVOPS-2');
    const first = await seedConflictQuestion(harness, item);
    // A second plan asked about the same relation, and one this plan's redraft already closed.
    const [second, redrafted] = await harness.run(async (ctx) => {
      const asked = (await ctx.db.get(first.questionId))!;
      const { _id, _creationTime, ...fields } = asked;
      void _id;
      void _creationTime;
      return [
        await ctx.db.insert('managerQuestions', { ...fields, workItemId: other.workItemId }),
        await ctx.db.insert('managerQuestions', {
          ...fields,
          closed: { reason: 'redrafted', at: 7 },
        }),
      ];
    });

    const closed = await harness.run(
      async (ctx) => await closeQuestionsOfRelation(ctx, first.relationId, NOW),
    );

    expect(closed).toBe(2);
    expect((await questionOf(harness, first.questionId)).closed).toEqual({
      reason: 'settled',
      at: NOW,
    });
    expect((await questionOf(harness, second)).closed).toEqual({ reason: 'settled', at: NOW });
    expect((await questionOf(harness, redrafted)).closed).toEqual({ reason: 'redrafted', at: 7 });
    // Nothing is left open to close.
    expect(
      await harness.run(
        async (ctx) => await closeQuestionsOfRelation(ctx, first.relationId, NOW + 1),
      ),
    ).toBe(0);
  });
});

describe('closeQuestionsOnPage', (): void => {
  it('closes the questions of every confirmed conflict the page is an end of, and no other', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const item = await seedItem(harness);
    // The page as the first end, as the second end, in a conflict still only proposed, and absent.
    const asFrom = await seedConflictQuestion(harness, item, {
      pages: ['revops/limits.md', 'policies/limits.md'],
    });
    const asTo = await seedConflictQuestion(harness, item, {
      pages: ['handover/limits.md', 'revops/limits.md'],
    });
    const proposed = await seedConflictQuestion(harness, item, {
      pages: ['revops/limits.md', 'archive/limits.md'],
    });
    const unrelated = await seedConflictQuestion(harness, item, {
      pages: ['handover/limits.md', 'policies/limits.md'],
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(proposed.relationId, { status: 'proposed' });
      // Every seed made its own source; the page is one page, so its three relations name one.
      for (const seeded of [asTo, proposed]) {
        const relation = (await ctx.db.get(seeded.relationId))!;
        await ctx.db.patch(seeded.relationId, {
          from: { ...relation.from, sourceId: asFrom.sourceId },
          to: { ...relation.to, sourceId: asFrom.sourceId },
        });
      }
    });

    const closed = await harness.run(
      async (ctx) =>
        await closeQuestionsOnPage(
          ctx,
          { sourceId: asFrom.sourceId, ref: 'revops/limits.md' },
          NOW,
        ),
    );

    expect(closed).toBe(2);
    for (const seeded of [asFrom, asTo]) {
      expect((await questionOf(harness, seeded.questionId)).closed).toEqual({
        reason: 'settled',
        at: NOW,
      });
    }
    expect((await questionOf(harness, proposed.questionId)).closed).toBeUndefined();
    expect((await questionOf(harness, unrelated.questionId)).closed).toBeUndefined();
  });
});

describe('the module', (): void => {
  it('registers no function: the sites that close call its helpers in their own transactions', (): void => {
    expect(registeredIn(questionCloses)).toEqual([]);
  });
});

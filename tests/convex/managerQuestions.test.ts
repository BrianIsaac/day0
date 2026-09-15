/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import type { Charter } from '../../src/agent/charter';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';
import {
  RECORDED_QUESTIONS_2026_09_16,
  SYNTHESIS_SELF_CHECK_NOTE_2026_09_16,
} from '../fixtures/charter-synthesis-notes-2026-09-16';

type Harness = TestConvex<typeof schema>;

const OWNER = { subject: 'owner' };

async function seedApprovedAgent(
  harness: Harness,
): Promise<{ agentId: Id<'agents'>; charterId: Id<'charters'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'worker 1',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const charterId = await ctx.db.insert('charters', {
      agentId,
      version: '0.0',
      body: runThroughBody(),
      approved: true,
      approvedAt: 2,
      createdAt: 2,
    });
    return { agentId, charterId };
  });
}

async function seedClaimed(
  harness: Harness,
  agentId: Id<'agents'>,
  title: string,
  contentSummary = 'A routine ticket.',
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: `REVOPS-${Math.floor(Math.random() * 10_000)}`,
        title,
        contentSummary,
        contentRefs: [],
        state: 'claimed',
        observedAt: 3,
        createdAt: 3,
      }),
  );
}

const lookerPlan = {
  summary: 'Refresh the Looker pipeline tile and comment on the ticket.',
  steps: ['Read REVOPS-7.', 'Refresh the Looker pipeline tile.', 'Draft a comment.'],
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 10,
  expectedOutputType: 'comment',
};

const plainPlan = {
  summary: 'Draft a reply to the ask.',
  steps: ['Read the thread.', 'Draft a reply.'],
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 5,
  expectedOutputType: 'reply',
};

async function questions(harness: Harness, agentId: Id<'agents'>): Promise<Doc<'managerQuestions'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('managerQuestions')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect(),
  );
}

async function eventTypes(harness: Harness, agentId: Id<'agents'>): Promise<string[]> {
  const events = await harness.run(
    async (ctx) =>
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect(),
  );
  return events.map((event) => event.type);
}

describe('the question record', (): void => {
  it('is validated on write: a record without the context the planning pane reads is refused', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedAgent(harness);
    const workItemId = await seedClaimed(harness, agentId, 'Refresh the Looker tile');
    await expect(
      harness.run(async (ctx) => {
        await ctx.db.insert('managerQuestions', {
          agentId,
          key: 'who owns the looker pipeline tile',
          question: 'Who owns the Looker pipeline tile.',
          askedAt: 4,
          workItemId,
          charterId,
        } as unknown as Doc<'managerQuestions'>);
      }),
    ).rejects.toThrow(/context|validat/i);
    await expect(
      harness.run(async (ctx) => {
        await ctx.db.insert('managerQuestions', {
          agentId,
          key: 'who owns the looker pipeline tile',
          question: 'Who owns the Looker pipeline tile.',
          context: { touchedBy: 'plan', text: 'Refresh the Looker pipeline tile.', words: ['looker'] },
          askedAt: 4,
          workItemId,
          charterId,
          answer: { text: 'Priya.', answeredAt: 5, via: 'sms' },
        } as unknown as Doc<'managerQuestions'>);
      }),
    ).rejects.toThrow(/via|validat/i);
  });
});

describe('asking open questions at plan approval', (): void => {
  it('asks the question the plan touches, once, with the words that touched it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedAgent(harness);
    const first = await seedClaimed(harness, agentId, 'REVOPS-7 tile refresh');
    await harness.mutation(internal.work.setPlan, { workItemId: first, plan: lookerPlan });

    const asked = await questions(harness, agentId);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      agentId,
      key: 'who owns the looker pipeline tile',
      question: 'Who owns the Looker pipeline tile.',
      context: { touchedBy: 'plan', words: ['looker', 'pipeline', 'tile'] },
      workItemId: first,
      charterId,
    });
    expect(asked[0]?.context.text).toContain('Refresh the Looker pipeline tile.');
    expect(asked[0]?.answer).toBeUndefined();
    expect(await eventTypes(harness, agentId)).toEqual(['work.plan-drafted', 'charter.question-asked']);

    const second = await seedClaimed(harness, agentId, 'Another Looker tile refresh');
    await harness.mutation(internal.work.setPlan, { workItemId: second, plan: lookerPlan });
    expect(await questions(harness, agentId)).toHaveLength(1);
    const owner = harness.withIdentity(OWNER);
    expect(await owner.query(api.managerQuestions.forWorkItem, { workItemId: second })).toEqual([]);
    expect(await owner.query(api.managerQuestions.forWorkItem, { workItemId: first })).toHaveLength(1);
    expect(await owner.query(api.managerQuestions.openForAgent, { agentId })).toHaveLength(1);
  });

  it('asks through the candidate when the plan says nothing, and not at all when neither touches it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApprovedAgent(harness);
    const untouched = await seedClaimed(harness, agentId, 'Reply to the #revops-asks thread');
    await harness.mutation(internal.work.setPlan, { workItemId: untouched, plan: plainPlan });
    expect(await questions(harness, agentId)).toEqual([]);

    const byCandidate = await seedClaimed(
      harness,
      agentId,
      'Northstar account clean-up',
      'Merge the duplicate Northstar accounts.',
    );
    await harness.mutation(internal.work.setPlan, { workItemId: byCandidate, plan: plainPlan });
    const asked = await questions(harness, agentId);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      key: 'whether northstar crm access will be granted',
      context: { touchedBy: 'candidate', words: ['northstar'] },
      workItemId: byCandidate,
    });
  });

  it("never asks the synthesiser's own note, whether the charter filed it as a note or as a question", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedAgent(harness);
    const later =
      'Evidence check: 2 clauses in this draft quoted my own words back as if they were yours, so I dropped them. Which of this is actually what you told me?';
    await harness.run(async (ctx) =>
      await ctx.db.patch(charterId, {
        body: {
          ...runThroughBody(),
          openQuestions: [...RECORDED_QUESTIONS_2026_09_16],
          synthesisNotes: [later],
        },
      }),
    );
    const workItemId = await seedClaimed(harness, agentId, 'Audit note for the checklist');
    await harness.mutation(internal.work.setPlan, {
      workItemId,
      plan: {
        ...plainPlan,
        summary: 'Read the tile back and quote its audit line as evidence.',
        steps: ['Read the tile back.', 'Quote the words of the audit line as evidence; drop nothing you were not told.'],
      },
    });
    const asked = await questions(harness, agentId);
    expect(asked.map((row) => row.question)).not.toContain(SYNTHESIS_SELF_CHECK_NOTE_2026_09_16);
    expect(asked.map((row) => row.question)).not.toContain(later);
    expect(asked).toEqual([]);
    const owner = harness.withIdentity(OWNER);
    expect(await owner.query(api.managerQuestions.openForAgent, { agentId })).toEqual([]);
  });

  it('asks nothing while the charter is not approved', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedAgent(harness);
    await harness.run(async (ctx) => await ctx.db.patch(charterId, { approved: false }));
    const workItemId = await seedClaimed(harness, agentId, 'REVOPS-7 tile refresh');
    await harness.mutation(internal.work.setPlan, { workItemId, plan: lookerPlan });
    expect(await questions(harness, agentId)).toEqual([]);
  });
});

describe('answering a question', (): void => {
  it('writes the answer into the charter as an amendment and marks the record', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedAgent(harness);
    const workItemId = await seedClaimed(harness, agentId, 'REVOPS-7 tile refresh');
    await harness.mutation(internal.work.setPlan, { workItemId, plan: lookerPlan });
    const [asked] = await questions(harness, agentId);
    const owner = harness.withIdentity(OWNER);

    const result = await owner.mutation(api.managerQuestions.answer, {
      questionId: asked!._id,
      text: ' Priya owns it. ',
    });
    expect(result.amendedCharterId).not.toBeNull();
    const latest = await owner.query(api.charters.latest, { agentId });
    expect(latest?._id).toBe(result.amendedCharterId);
    expect(latest).toMatchObject({ version: '0.1', approved: true, supersedes: charterId });
    const body = latest?.body as Charter;
    expect(body.openQuestions).toEqual(['Whether Northstar CRM access will be granted.']);
    expect(body.answeredQuestions).toEqual([
      { question: 'Who owns the Looker pipeline tile.', answer: 'Priya owns it.', answeredAt: expect.any(String) },
    ]);
    const [answered] = await questions(harness, agentId);
    expect(answered?.answer).toEqual({
      text: 'Priya owns it.',
      answeredAt: expect.any(Number),
      via: 'dashboard',
      amendedCharterId: result.amendedCharterId,
    });
    expect(await owner.query(api.managerQuestions.openForAgent, { agentId })).toEqual([]);
    expect(await eventTypes(harness, agentId)).toContain('charter.amended');
  });

  it('refuses a second answer, a stranger and an empty answer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApprovedAgent(harness);
    const workItemId = await seedClaimed(harness, agentId, 'REVOPS-7 tile refresh');
    await harness.mutation(internal.work.setPlan, { workItemId, plan: lookerPlan });
    const [asked] = await questions(harness, agentId);
    const owner = harness.withIdentity(OWNER);
    await expect(
      harness.withIdentity({ subject: 'stranger' }).mutation(api.managerQuestions.answer, {
        questionId: asked!._id,
        text: 'Me.',
      }),
    ).rejects.toThrow(/forbidden/);
    await expect(
      owner.mutation(api.managerQuestions.answer, { questionId: asked!._id, text: '   ' }),
    ).rejects.toThrow(/cannot be empty/);
    await owner.mutation(api.managerQuestions.answer, { questionId: asked!._id, text: 'Priya.' });
    await expect(
      owner.mutation(api.managerQuestions.answer, { questionId: asked!._id, text: 'Aman.' }),
    ).rejects.toThrow(/already been answered/);
  });

  it('takes the answer without a second amendment when the card already answered the charter', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApprovedAgent(harness);
    const workItemId = await seedClaimed(harness, agentId, 'REVOPS-7 tile refresh');
    await harness.mutation(internal.work.setPlan, { workItemId, plan: lookerPlan });
    const [asked] = await questions(harness, agentId);
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.charters.amend, {
      agentId,
      changes: [{ kind: 'answer-question', question: 'Who owns the Looker pipeline tile.', answer: 'Priya.' }],
    });
    const result = await owner.mutation(api.managerQuestions.answer, {
      questionId: asked!._id,
      text: 'Priya.',
    });
    expect(result.amendedCharterId).toBeNull();
    expect(await owner.query(api.charters.listForAgent, { agentId })).toHaveLength(2);
    const [answered] = await questions(harness, agentId);
    expect(answered?.answer).toMatchObject({ text: 'Priya.', via: 'dashboard' });
    expect(answered?.answer?.amendedCharterId).toBeUndefined();
  });
});

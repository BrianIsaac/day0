/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  longestWaitFirst,
  needsYouOfEmployee,
  transferEntryOf,
  type NeedsYouEntry,
} from '../../convex/needsYou';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { warnedBy } from './fakes/reorientation';

/**
 * The needs-you projection (`convex/needsYou.ts`, moved out of `convex/work.ts` by the wave 15
 * helpers split): everything one employee waits on the manager for, each entry dated by when it
 * began to wait, in one order, the longest wait first.
 */

type Harness = TestConvex<typeof schema>;

const HELD = { disposition: 'held' as const, reason: 'a write the manager approves' };

async function seedEmployee(
  harness: Harness,
  state: Doc<'agents'>['state'] = 'active',
): Promise<Doc<'agents'>> {
  return await harness.run(async (ctx) => {
    const id = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Aiko',
      userId: 'owner',
      state,
      createdAt: 1,
    });
    const agent = await ctx.db.get(id);
    if (!agent) throw new Error('agent missing');
    return agent;
  });
}

async function seedItem(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'workItems'>> & Pick<Doc<'workItems'>, 'state' | 'title'>,
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: fields.title,
        contentSummary: 'Synthetic.',
        contentRefs: [],
        observedAt: 1,
        createdAt: 1,
        ...fields,
      }),
  );
}

describe('needsYouOfEmployee', (): void => {
  it('lists a plan with its open questions and a held set with its held writes, dated by their stamps', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedEmployee(harness);
    const plan = await seedItem(harness, agent._id, {
      state: 'plan-pending',
      title: 'Draft the renewal note',
      waitingSince: 100,
    });
    const held = await seedItem(harness, agent._id, {
      state: 'actions-pending',
      title: 'Close REVOPS-2',
      waitingSince: 200,
      output: { actions: [{ tool: 'a' }, { tool: 'b' }, { tool: 'c' }] },
      actionVerdicts: [HELD, { disposition: 'auto' }, HELD],
    });
    await harness.run(async (ctx) => {
      const charterId = await ctx.db.insert('charters', {
        agentId: agent._id,
        version: '0.1',
        approved: true,
        approvedAt: 1,
        body: {},
        createdAt: 1,
      });
      for (const [key, answered] of [
        ['which-customer', false],
        ['which-quarter', true],
      ] as const) {
        await ctx.db.insert('managerQuestions', {
          agentId: agent._id,
          key,
          question: key,
          context: { touchedBy: 'plan', text: 'plan', words: [] },
          askedAt: 1,
          workItemId: plan,
          charterId,
          ...(answered ? { answer: { text: 'Q3', answeredAt: 2, via: 'dashboard' as const } } : {}),
        });
      }
    });

    const entries = await harness.run(async (ctx) => await needsYouOfEmployee(ctx, agent, 300));

    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'plan',
        key: `plan:${plan}`,
        subject: 'Draft the renewal note',
        employeeName: 'Aiko',
        waitingSince: 100,
        waitingAtLeast: false,
        workItemId: plan,
        questions: 1,
      }),
      expect.objectContaining({
        kind: 'held',
        key: `held:${held}`,
        waitingSince: 200,
        workItemId: held,
        heldWrites: 2,
      }),
    ]);
  });

  it('lists an undecided reorientation card, dated by its opening, and leaves a conflict’s question out of the plan’s count (16-O)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedEmployee(harness);
    const plan = await seedItem(harness, agent._id, {
      state: 'plan-pending',
      title: 'Draft the renewal note',
      waitingSince: 100,
    });
    const card = await harness.run(async (ctx) => {
      const charterId = await ctx.db.insert('charters', {
        agentId: agent._id,
        version: '0.1',
        approved: true,
        approvedAt: 1,
        body: {},
        createdAt: 1,
      });
      await ctx.db.insert('managerQuestions', {
        agentId: agent._id,
        key: 'conflict:r1',
        question: 'Two pages disagree.',
        context: { touchedBy: 'plan', text: 'Thresholds', words: [] },
        askedAt: 1,
        workItemId: plan,
        charterId,
        blocking: false,
        type: 'retrieval',
      });
      const fields = {
        agentId: agent._id,
        userId: 'owner',
        trigger: 'skill-recheck-due' as const,
        triggerSummary: 'A skill is due a re-check',
        evidence: {
          eventIds: [],
          pageRefs: [],
          relationIds: [],
          correctionIds: [],
          relationshipIds: [],
          skillIds: [],
          skillVersionIds: [],
        },
        affected: {
          charterClauses: [],
          agreements: [],
          relationships: [],
          skills: [],
          surfaces: [],
          workItems: [],
        },
        proposed: { kind: 'pending' as const },
        risk: 'low' as const,
        blockingWork: [],
        day: '2026-09-26',
      };
      await ctx.db.insert('reorientations', {
        ...fields,
        triggerKey: 'decided',
        status: 'dismissed',
        createdAt: 50,
      });
      return await ctx.db.insert('reorientations', {
        ...fields,
        triggerKey: 'open',
        status: 'open',
        createdAt: 150,
      });
    });

    const entries = await harness.run(async (ctx) => await needsYouOfEmployee(ctx, agent, 300));

    expect(entries).toEqual([
      expect.objectContaining({ kind: 'plan', workItemId: plan, questions: 0 }),
      expect.objectContaining({
        kind: 'reorientation',
        key: `reorientation:${card}`,
        subject: 'A skill is due a re-check',
        waitingSince: 150,
        reorientationId: card,
        risk: 'low',
      }),
    ]);
  });

  it('lists an employee’s newest twenty open cards and says in the log that older ones were left out (W16-R24)', async (): Promise<void> => {
    // The review's W16-R24: "silent caps with no record: `needsYou` 20 open cards oldest first".
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedEmployee(harness);
    await harness.run(async (ctx) => {
      for (let index = 1; index <= 21; index += 1) {
        await ctx.db.insert('reorientations', {
          agentId: agent._id,
          userId: 'owner',
          trigger: 'skill-recheck-due',
          triggerKey: `event-${index}`,
          triggerSummary: `Change ${index}`,
          evidence: {
            eventIds: [],
            pageRefs: [],
            relationIds: [],
            correctionIds: [],
            relationshipIds: [],
            skillIds: [],
            skillVersionIds: [],
          },
          affected: {
            charterClauses: [],
            agreements: [],
            relationships: [],
            skills: [],
            surfaces: [],
            workItems: [],
          },
          proposed: { kind: 'pending' },
          risk: 'low',
          blockingWork: [],
          day: '2026-09-26',
          status: 'open',
          createdAt: index,
        });
      }
    });
    const { result, warnings } = await warnedBy(
      async () => await harness.run(async (ctx) => await needsYouOfEmployee(ctx, agent, 300)),
    );
    const subjects = result.map((entry) => entry.subject);
    expect(subjects).toHaveLength(20);
    expect(subjects).toContain('Change 21');
    expect(subjects).not.toContain('Change 1');
    expect(warnings).toEqual([
      expect.objectContaining({ bound: 'NEEDS_YOU_CARD_READ', limit: 20, status: 'open' }),
    ]);
  });

  it("lists a deployed employee's one-to-one, waiting since its insert when no deploy was recorded", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agent = await seedEmployee(harness, 'deployed');

    const entries = await harness.run(async (ctx) => await needsYouOfEmployee(ctx, agent, 300));

    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'one-to-one',
        key: `one-to-one:${agent._id}`,
        waitingSince: agent._creationTime,
      }),
    ]);
  });
});

describe('longestWaitFirst and transferEntryOf', (): void => {
  it('orders the inbox by the longest wait, ties by key, with a handover dated by its ask', (): void => {
    const agentId = 'agent-1' as Id<'agents'>;
    const transfer = transferEntryOf({
      transferId: 'transfer-1' as Id<'managerTransfers'>,
      agentId,
      employeeName: 'Ben',
      zone: 'Asia/Singapore',
      fromAddress: 'old-manager@example.com',
      requestedAt: 50,
      expiresAt: 500,
    });
    const charter = (key: string, waitingSince: number): NeedsYouEntry => ({
      kind: 'charter',
      key,
      agentId,
      employeeName: 'Aiko',
      zone: 'Asia/Singapore',
      subject: 'charter',
      waitingSince,
      waitingAtLeast: false,
    });

    expect(transfer).toEqual({
      kind: 'transfer',
      key: 'transfer:transfer-1',
      agentId,
      employeeName: 'Ben',
      zone: 'Asia/Singapore',
      subject: 'Ben',
      waitingSince: 50,
      waitingAtLeast: false,
      transferId: 'transfer-1',
      fromAddress: 'old-manager@example.com',
      expiresAt: 500,
    });
    expect(
      [charter('charter:b', 60), transfer, charter('charter:a', 60)]
        .sort(longestWaitFirst)
        .map((entry) => entry.key),
    ).toEqual(['transfer:transfer-1', 'charter:a', 'charter:b']);
  });
});

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

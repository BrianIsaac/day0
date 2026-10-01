import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { SEED_AFTER_HANDOVER } from '../../convex/intakeSeed';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/*
 * The wave 9 review's U3-m2: an intake poll in flight when a handover moved the employee read
 * the queue with the old owner's token, and its seeds landed as the new owner's work. The seed
 * is fenced by the owner the poll read the employee under.
 */

type Harness = TestConvex<typeof schema>;

/** Seed Maya, now owned by `userId`. */
async function seedEmployee(harness: Harness, userId: string): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId,
        state: 'active',
        createdAt: 1,
      }),
  );
}

/** One listed Linear issue, as the poll seeds it. */
function listed(agentId: Id<'agents'>, startedUnder: string | null) {
  return {
    agentId,
    startedUnder,
    sourceCategory: 'ticket-queue' as const,
    sourceSystem: 'linear',
    externalId: 'issue-1',
    title: 'Close REVOPS-1',
    contentSummary: 'Close the ticket.',
    contentRefs: [],
    observedAt: 1,
  };
}

/** The employee's work items. */
async function itemsOf(harness: Harness, agentId: Id<'agents'>): Promise<number> {
  return await harness.run(
    async (ctx) =>
      (
        await ctx.db
          .query('workItems')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      ).length,
  );
}

describe('intakeSeed.seedListedItem: a poll in flight at a handover (U3-m2)', (): void => {
  it('seeds the item while the employee is still the owner the poll read it under', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, 'owner');

    const seeded = await harness.mutation(
      internal.intakeSeed.seedListedItem,
      listed(agentId, 'owner'),
    );

    expect(seeded).toEqual(expect.any(String));
    expect(await itemsOf(harness, agentId)).toBe(1);
  });

  it('refuses the seed once the employee was handed to another owner since the poll read it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, 'colleague');

    // Refused, not dropped: the sweep counts a refused seed as unseeded, so its checkpoint holds
    // and the new owner's first poll reads the item again.
    await expect(
      harness.mutation(internal.intakeSeed.seedListedItem, listed(agentId, 'owner')),
    ).rejects.toThrow(SEED_AFTER_HANDOVER);
    expect(await itemsOf(harness, agentId)).toBe(0);
  });

  it('refuses the seed for an employee that is gone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, 'owner');
    await harness.run(async (ctx) => {
      await ctx.db.delete(agentId);
    });

    await expect(
      harness.mutation(internal.intakeSeed.seedListedItem, listed(agentId, 'owner')),
    ).rejects.toThrow(SEED_AFTER_HANDOVER);
  });
});

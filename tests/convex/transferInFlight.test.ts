/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  acceptingTransferOf,
  isBeingHandedOver,
  settleHandoverAfterRun,
} from '../../convex/transferInFlight';
import { transferExpiresAt } from '../../src/agent/manager-transfer';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, fixtureAddressOf } from './fakes/manager-identity';

type Harness = TestConvex<typeof schema>;

/** An employee, with a handover request in the given state when one is named. */
async function seed(
  state?: Doc<'managerTransfers'>['state'],
): Promise<{ harness: Harness; agentId: Id<'agents'> }> {
  const harness = convexTest(schema, allConvexModules());
  const agentId = await harness.run(async (ctx) => {
    const id = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Maya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    if (state !== undefined) {
      await ctx.db.insert('managerTransfers', {
        agentId: id,
        agentName: 'Maya',
        fromOwnerKey: 'owner',
        fromAddress: MANAGER_ADDRESS,
        toAddress: fixtureAddressOf('colleague'),
        state,
        requestedAt: 1,
        expiresAt: transferExpiresAt(1),
        ...(state === 'asked' ? {} : { decidedAt: 2, toOwnerKey: 'colleague' }),
      });
    }
    return id;
  });
  return { harness, agentId };
}

/** The names of the functions scheduled so far. */
async function scheduled(harness: Harness): Promise<string[]> {
  const rows = await harness.run(
    async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
  );
  return rows.map((row) => row.name);
}

describe('transferInFlight: the work loop’s view of a finishing handover', (): void => {
  beforeEach((): void => {
    // A settle this schedules runs only when a test drains it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach((): void => {
    vi.useRealTimers();
  });

  it('reads an accepting request as the employee being handed over', async (): Promise<void> => {
    const { harness, agentId } = await seed('accepting');

    await expect(
      harness.run(async (ctx) => (await acceptingTransferOf(ctx.db, agentId))?.state),
    ).resolves.toBe('accepting');
    await expect(
      harness.run(async (ctx) => await isBeingHandedOver(ctx.db, agentId)),
    ).resolves.toBe(true);
  });

  it.each(['asked', 'accepted', 'declined', 'cancelled', 'expired'] as const)(
    'reads a %s request as nothing finishing',
    async (state): Promise<void> => {
      const { harness, agentId } = await seed(state);

      await expect(
        harness.run(async (ctx) => await isBeingHandedOver(ctx.db, agentId)),
      ).resolves.toBe(false);
    },
  );

  it('schedules the settle after a run only while a handover is finishing', async (): Promise<void> => {
    const finishing = await seed('accepting');
    const quiet = await seed();

    await expect(
      finishing.harness.run(async (ctx) => await settleHandoverAfterRun(ctx, finishing.agentId)),
    ).resolves.toBe(true);
    await expect(
      quiet.harness.run(async (ctx) => await settleHandoverAfterRun(ctx, quiet.agentId)),
    ).resolves.toBe(false);

    expect(await scheduled(finishing.harness)).toEqual(['transferAcceptance:settle']);
    expect(await scheduled(quiet.harness)).toEqual([]);
  });
});

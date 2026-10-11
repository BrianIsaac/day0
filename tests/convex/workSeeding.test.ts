/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { TicketSnapshot } from '../../src/work/ticket-ownership';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Seeding a work item from intake (`convex/workSeeding.ts`, moved out of `convex/work.ts` by the
 * wave 15 helpers split): a listed item gets one row however often it is listed, the row follows
 * the tracker while it is worked or waiting, and a ticket that leaves the queue withdraws the row
 * until it comes back.
 */

type Harness = TestConvex<typeof schema>;

const OPEN: TicketSnapshot = { assigned: false, state: 'Todo', doNotAutomate: false };

// A seeded or withdrawn row schedules its next step; the scheduler's timer is
// faked so nothing runs after the test.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** The module under the mode the test chose; `SURFACE_MODE` is read at import. */
async function seedingModule(): Promise<typeof import('../../convex/workSeeding')> {
  return await import('../../convex/workSeeding');
}

async function seedAgent(harness: Harness): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Aiko',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      }),
  );
}

function listing(agentId: Id<'agents'>, overrides: { title?: string; externalId?: string } = {}) {
  return {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: overrides.externalId ?? 'REVOPS-1',
    title: overrides.title ?? 'Add the close-summary audit note',
    contentSummary: 'Synthetic.',
    contentRefs: [],
  };
}

async function row(harness: Harness, id: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const found = await harness.run(async (ctx) => await ctx.db.get(id));
  if (!found) throw new Error('work item missing');
  return found;
}

async function eventTypes(harness: Harness, agentId: Id<'agents'>): Promise<string[]> {
  return await harness.run(async (ctx) =>
    (
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect()
    ).map((event) => event.type),
  );
}

describe('seedItemInTransaction', (): void => {
  it('seeds one discovered row, with its discovery, and brings it up to a later listing', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { seedItemInTransaction } = await seedingModule();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);

    const first = await harness.run(
      async (ctx) =>
        await seedItemInTransaction(ctx, { ...listing(agentId), tracker: OPEN, askedAt: 42 }),
    );
    const again = await harness.run(
      async (ctx) =>
        await seedItemInTransaction(ctx, listing(agentId, { title: 'Add the audit note' })),
    );

    expect(again).toBe(first);
    expect(await row(harness, first)).toMatchObject({
      state: 'discovered',
      title: 'Add the audit note',
      observedAt: 42,
    });
    expect(await eventTypes(harness, agentId)).toEqual(['work.discovered']);
  });

  it("dates a Slack ask by the message's own ts when intake passed no time", async (): Promise<void> => {
    useSurfaceMode('mock');
    const { seedItemInTransaction } = await seedingModule();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);

    const id = await harness.run(
      async (ctx) =>
        await seedItemInTransaction(ctx, {
          ...listing(agentId, { externalId: 'C0REVOPS1:1787770800.000100' }),
          sourceCategory: 'chat',
          sourceSystem: 'slack',
          observedAt: 5,
        }),
    );

    expect((await row(harness, id)).observedAt).toBe(1_787_770_800_000);
  });

  it("keys the row's claim on its tracker in real mode, with the item's other name", async (): Promise<void> => {
    useSurfaceMode('real');
    const { seedItemInTransaction } = await seedingModule();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        endpoint: 'https://mcp.linear.app/mcp',
        path: 'mcp',
        toolAllowlist: ['list_issues', 'save_comment'],
        credentialLanded: false,
        whereFound: [],
        createdAt: 1,
      } as never);
    });

    const id = await harness.run(
      async (ctx) =>
        await seedItemInTransaction(ctx, { ...listing(agentId), externalAlias: 'ENG-9' }),
    );

    expect(await row(harness, id)).toMatchObject({
      externalClaimKey: 'linear:REVOPS-1',
      externalAlias: 'ENG-9',
      externalClaimAlias: 'linear:ENG-9',
    });
  });
});

describe('refreshListedItem and listedRow', (): void => {
  it('withdraws a waiting row whose ticket left the queue and returns it when the ticket is back', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { listedRow, refreshListedItem, seedItemInTransaction, WITHDRAWN_FROM_QUEUE_PREFIX } =
      await seedingModule();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const id = await harness.run(async (ctx) => await seedItemInTransaction(ctx, listing(agentId)));

    await harness.run(async (ctx) => {
      const existing = await listedRow(ctx, listing(agentId));
      if (!existing) throw new Error('listed row missing');
      await refreshListedItem(ctx, existing, listing(agentId), 'moved to Done');
    });
    const withdrawn = await row(harness, id);
    await harness.run(async (ctx) => {
      await refreshListedItem(ctx, withdrawn, listing(agentId), undefined);
    });

    expect(withdrawn).toMatchObject({
      state: 'cancelled',
      skipReason: `${WITHDRAWN_FROM_QUEUE_PREFIX}moved to Done`,
    });
    expect((await row(harness, id)).state).toBe('discovered');
    expect(await eventTypes(harness, agentId)).toEqual([
      'work.discovered',
      'work.withdrawn',
      'work.returned',
    ]);
  });

  it('leaves a finished row as it finished', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { refreshListedItem, seedItemInTransaction } = await seedingModule();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const id = await harness.run(async (ctx) => await seedItemInTransaction(ctx, listing(agentId)));
    await harness.run(async (ctx) => {
      await ctx.db.patch(id, { state: 'completed' });
    });
    const finished = await row(harness, id);

    await harness.run(async (ctx) => {
      await refreshListedItem(
        ctx,
        finished,
        listing(agentId, { title: 'Renamed' }),
        'moved to Done',
      );
    });

    expect(await row(harness, id)).toMatchObject({
      state: 'completed',
      title: 'Add the close-summary audit note',
    });
  });
});

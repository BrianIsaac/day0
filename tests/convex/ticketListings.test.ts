/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  keepTicketListing,
  keptListingAt,
  listedSnapshotAt,
  recordListing,
  WORK_LISTED_EVENT,
} from '../../convex/ticketListings';
import type { TicketSnapshot } from '../../src/work/ticket-ownership';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/**
 * The tracker listing record (`convex/ticketListings.ts`, moved out of `convex/work.ts` by the
 * wave 15 helpers split): each change in how intake saw a ticket is kept once, the first listing
 * rides on the discovery, and the re-read before apply reads the latest accepted one.
 */

type Harness = TestConvex<typeof schema>;

const OPEN: TicketSnapshot = { assigned: false, state: 'Todo', doNotAutomate: false };
const TAKEN: TicketSnapshot = { assigned: true, assigneeId: 'u1', doNotAutomate: false };

beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000);
});

afterEach((): void => {
  vi.useRealTimers();
});

async function seedItem(harness: Harness): Promise<Doc<'workItems'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Aiko',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const id = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'discovered',
      observedAt: 1,
      createdAt: 1,
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error('work item missing');
    return row;
  });
}

async function listings(harness: Harness, id: Id<'workItems'>): Promise<Doc<'ticketListings'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('ticketListings')
        .withIndex('by_work_item_listed_at', (q) => q.eq('workItemId', id))
        .collect(),
  );
}

describe('keepTicketListing', (): void => {
  it('keeps one row for one moment, however often it is copied', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const row = await seedItem(harness);

    const written = await harness.run(async (ctx) => [
      await keepTicketListing(ctx, row, { tracker: OPEN, listedAt: 5 }),
      await keepTicketListing(ctx, row, { tracker: OPEN, listedAt: 5 }),
    ]);

    expect(written).toEqual([true, false]);
    expect(await listings(harness, row._id)).toHaveLength(1);
  });
});

describe('recordListing', (): void => {
  it('keeps a listing and its feed event only when the ticket or its refusal changed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const row = await seedItem(harness);

    await harness.run(async (ctx) => {
      await recordListing(ctx, row, OPEN);
    });
    vi.setSystemTime(2_000);
    await harness.run(async (ctx) => {
      await recordListing(ctx, row, { doNotAutomate: false, state: 'Todo', assigned: false });
    });
    vi.setSystemTime(3_000);
    await harness.run(async (ctx) => {
      await recordListing(ctx, row, OPEN, 'assigned to someone else');
    });
    await harness.run(async (ctx) => {
      await recordListing(ctx, row, undefined);
    });

    expect(
      (await listings(harness, row._id)).map((kept) => [kept.listedAt, kept.refused ?? null]),
    ).toEqual([
      [1_000, null],
      [3_000, 'assigned to someone else'],
    ]);
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
          .collect(),
    );
    expect(events.filter((event) => event.type === WORK_LISTED_EVENT)).toHaveLength(2);
  });
});

describe('keptListingAt and listedSnapshotAt', (): void => {
  it('reads the latest listing by then, passing over a refused one for the baseline', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const row = await seedItem(harness);
    await harness.run(async (ctx) => {
      await keepTicketListing(ctx, row, { tracker: OPEN, listedAt: 10 });
      await keepTicketListing(ctx, row, { tracker: TAKEN, listedAt: 20, refused: 'taken' });
    });

    const read = await harness.run(async (ctx) => ({
      latest: await keptListingAt(ctx, row, 25, false),
      accepted: await keptListingAt(ctx, row, 25, true),
      baseline: await listedSnapshotAt(ctx, row, 25),
      before: (await keptListingAt(ctx, row, 5, false)) ?? null,
    }));

    expect(read).toEqual({
      latest: { tracker: TAKEN, listedAt: 20, refused: 'taken' },
      accepted: { tracker: OPEN, listedAt: 10 },
      baseline: OPEN,
      before: null,
    });
  });

  it("falls back to the listing the item's discovery kept", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const row = await seedItem(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId: row.agentId,
        type: 'work.discovered',
        payload: { workItemId: row._id, tracker: OPEN },
        createdAt: row._creationTime,
      });
    });

    const first = await harness.run(
      async (ctx) => await keptListingAt(ctx, row, row._creationTime, true),
    );

    expect(first).toEqual({ tracker: OPEN, listedAt: row._creationTime });
  });
});

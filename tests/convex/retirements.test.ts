import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  firstRetiredRejection,
  ownerRetirements,
  RETIREMENT_READ_LIMIT,
  retiredClaimOn,
  retiredHolderName,
} from '../../convex/retirements';
import { allConvexModules } from './all-modules';

type Harness = TestConvex<typeof schema>;

/** One retirement row for the owner, with the claims and rejections it kept. */
async function retire(
  harness: Harness,
  args: {
    name?: string;
    retiredAt: number;
    claims?: Array<{ key: string; aliases?: string[] }>;
    rejections?: Array<{ keys: string[]; rejectedAt: number }>;
  },
): Promise<Id<'retirements'>> {
  return await harness.run(async (ctx): Promise<Id<'retirements'>> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: args.name ?? 'retired',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      title: 'held item',
      contentSummary: '',
      contentRefs: [],
      observedAt: 1,
      state: 'claimed',
      createdAt: 1,
    });
    const claimId = await ctx.db.insert('externalClaims', {
      userId: 'owner',
      key: 'linear:REVOPS-1',
      agentId,
      workItemId,
      claimedAt: 1,
    });
    return await ctx.db.insert('retirements', {
      userId: 'owner',
      agentId,
      agentName: args.name,
      retiredAt: args.retiredAt,
      rowCounts: {},
      revokedCredentials: 0,
      keptCredentials: 0,
      claims: (args.claims ?? []).map((claim) => ({
        claimId,
        key: claim.key,
        aliases: claim.aliases,
        workItemId,
        title: 'held item',
        state: 'claimed',
        claimedAt: 1,
      })),
      rejections: (args.rejections ?? []).map((rejection) => ({ workItemId, ...rejection })),
    });
  });
}

describe('the retired employees of an owner', (): void => {
  it("are read newest first, and only the owner's own", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await retire(harness, { name: 'first', retiredAt: 10 });
    await retire(harness, { name: 'second', retiredAt: 20 });
    await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'other@day0.local',
        name: 'theirs',
        userId: 'another-owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('retirements', {
        userId: 'another-owner',
        agentId,
        retiredAt: 30,
        rowCounts: {},
        revokedCredentials: 0,
        keptCredentials: 0,
        claims: [],
        rejections: [],
      });
    });
    const rows = await harness.run(async (ctx) => await ownerRetirements(ctx, 'owner'));
    expect(rows.map((row: Doc<'retirements'>) => row.agentName)).toEqual(['second', 'first']);
  });

  it('name a holder as retired, or as an employee when the older row kept no name', (): void => {
    expect(retiredHolderName({ agentName: 'Priya' })).toBe('Priya (retired)');
    expect(retiredHolderName({})).toBe('an employee (retired)');
  });
});

describe('retiredClaimOn', (): void => {
  it('finds the claim by its key or by an alias, and nothing for an item no retired employee holds', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await retire(harness, {
      name: 'Mateo',
      retiredAt: 5,
      claims: [{ key: 'linear:REVOPS-1', aliases: ['linear:uuid-1'] }],
    });
    const byKey = await harness.run(
      async (ctx) => await retiredClaimOn(ctx, 'owner', 'linear:REVOPS-1'),
    );
    expect(byKey?.retirement.agentName).toBe('Mateo');
    const byAlias = await harness.run(
      async (ctx) => await retiredClaimOn(ctx, 'owner', 'linear:uuid-1'),
    );
    expect(byAlias?.claim.key).toBe('linear:REVOPS-1');
    expect(
      await harness.run(async (ctx) => await retiredClaimOn(ctx, 'owner', 'linear:REVOPS-9')),
    ).toBeNull();
  });
});

describe('firstRetiredRejection', (): void => {
  it("returns the earliest rejection on any of the item's names across the owner's retirements", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await retire(harness, {
      name: 'later',
      retiredAt: 9,
      rejections: [{ keys: ['linear:REVOPS-1'], rejectedAt: 200 }],
    });
    await retire(harness, {
      name: 'earlier',
      retiredAt: 8,
      rejections: [{ keys: ['linear:uuid-1'], rejectedAt: 100 }],
    });
    const first = await harness.run(
      async (ctx) =>
        await firstRetiredRejection(ctx, 'owner', ['linear:REVOPS-1', 'linear:uuid-1']),
    );
    expect(first?.rejection.rejectedAt).toBe(100);
    expect(first?.retirement.agentName).toBe('earlier');
    expect(
      await harness.run(
        async (ctx) => await firstRetiredRejection(ctx, 'owner', ['linear:REVOPS-7']),
      ),
    ).toBeNull();
  });
});

describe('the read limit', (): void => {
  it('refuses an owner with more retirements than it reads, rather than skipping a boundary', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'retired',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      for (let index = 0; index <= RETIREMENT_READ_LIMIT; index += 1) {
        await ctx.db.insert('retirements', {
          userId: 'owner',
          agentId,
          retiredAt: index,
          rowCounts: {},
          revokedCredentials: 0,
          keptCredentials: 0,
          claims: [],
          rejections: [],
        });
      }
    });
    await expect(harness.run(async (ctx) => await ownerRetirements(ctx, 'owner'))).rejects.toThrow(
      `more than ${RETIREMENT_READ_LIMIT} retired employees`,
    );
  });
});

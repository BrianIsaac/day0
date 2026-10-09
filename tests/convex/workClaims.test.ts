/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { MutationCtx } from '../../convex/_generated/server';
import schema from '../../convex/schema';
import { CLAIMED_BY_COLLEAGUE_SKIP_PREFIX } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * The owner-wide claim on a provider item (`convex/workClaims.ts`, moved out of `convex/work.ts`
 * by the wave 15 helpers split): the first work item to ask takes the item, a colleague's row is
 * told who holds it, and a release sends back what the claim refused. Claims are real mode only.
 */

type Harness = TestConvex<typeof schema>;

const KEY = 'linear:REVOPS-1';

// A released claim re-admits refused rows, which schedules their next step;
// the scheduler's timer is faked so nothing runs after the test.
beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** The module under the mode the test chose; `SURFACE_MODE` is read at import. */
async function claimsModule(): Promise<typeof import('../../convex/workClaims')> {
  return await import('../../convex/workClaims');
}

async function employee(
  harness: Harness,
  name: string,
  state: Doc<'workItems'>['state'] = 'claimed',
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name,
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      externalClaimKey: KEY,
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state,
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

async function row(harness: Harness, id: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const found = await harness.run(async (ctx) => await ctx.db.get(id));
  if (!found) throw new Error('work item missing');
  return found;
}

/** A row read inside a transaction, so a helper is called with the row as that transaction sees it. */
async function inside(ctx: MutationCtx, id: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const found = await ctx.db.get(id);
  if (!found) throw new Error('work item missing');
  return found;
}

async function claims(harness: Harness): Promise<Doc<'externalClaims'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('externalClaims').collect());
}

describe('takeExternalClaim and externalClaimHeldElsewhere', (): void => {
  it('gives the item to the first row and names that holder to a colleague', async (): Promise<void> => {
    useSurfaceMode('real');
    const { externalClaimHeldElsewhere, takeExternalClaim } = await claimsModule();
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko');
    const ben = await employee(harness, 'Ben');

    const first = await harness.run(
      async (ctx) => await takeExternalClaim(ctx, await inside(ctx, aiko.workItemId), 10),
    );
    const asked = await harness.run(
      async (ctx) => await externalClaimHeldElsewhere(ctx, await inside(ctx, ben.workItemId), 11),
    );
    const second = await harness.run(
      async (ctx) => await takeExternalClaim(ctx, await inside(ctx, ben.workItemId), 12),
    );

    expect(first).toEqual({ key: KEY });
    const holder = {
      claimId: expect.any(String),
      agentId: aiko.agentId,
      workItemId: aiko.workItemId,
      name: 'Aiko',
      title: 'Add the close-summary audit note',
    };
    expect(asked).toEqual({ key: KEY, heldBy: { holder, state: 'claimed' } });
    expect(second).toEqual({ key: KEY, heldBy: { holder, state: 'claimed' } });
    expect((await claims(harness)).map((claim) => claim.workItemId)).toEqual([aiko.workItemId]);
  });

  it('takes no claim in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { takeExternalClaim } = await claimsModule();
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko');

    const taken = await harness.run(
      async (ctx) => await takeExternalClaim(ctx, await inside(ctx, aiko.workItemId), 10),
    );

    // `harness.run` returns an absent result as null.
    expect(taken).toBeNull();
    expect(await claims(harness)).toEqual([]);
  });

  it('releases a claim whose holder was cancelled and gives the item to the asker', async (): Promise<void> => {
    useSurfaceMode('real');
    const { takeExternalClaim } = await claimsModule();
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko');
    const ben = await employee(harness, 'Ben');
    await harness.run(async (ctx) => {
      await takeExternalClaim(ctx, await inside(ctx, aiko.workItemId), 10);
      await ctx.db.patch(aiko.workItemId, { state: 'cancelled' });
    });

    const taken = await harness.run(
      async (ctx) => await takeExternalClaim(ctx, await inside(ctx, ben.workItemId), 20),
    );

    expect(taken).toEqual({ key: KEY });
    expect(
      (await claims(harness)).map((claim) => [claim.workItemId, claim.releasedAt ?? null]),
    ).toEqual([
      [aiko.workItemId, 20],
      [ben.workItemId, null],
    ]);
  });
});

describe('retakeExternalClaim', (): void => {
  it("refuses a retry while a colleague holds the item, naming the colleague's card", async (): Promise<void> => {
    useSurfaceMode('real');
    const { retakeExternalClaim, takeExternalClaim } = await claimsModule();
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko');
    const ben = await employee(harness, 'Ben', 'cancelled');
    await harness.run(async (ctx) => {
      await takeExternalClaim(ctx, await inside(ctx, aiko.workItemId), 10);
    });

    await expect(
      harness.run(async (ctx) => await retakeExternalClaim(ctx, await inside(ctx, ben.workItemId))),
    ).rejects.toThrow('another employee holds this: Aiko (Add the close-summary audit note)');
  });
});

describe('claimRefusedVerdict', (): void => {
  it("words the skip for the employee's own card and for a colleague's", async (): Promise<void> => {
    useSurfaceMode('real');
    const { claimRefusedVerdict } = await claimsModule();
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko');
    const ben = await employee(harness, 'Ben');
    const claimId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('externalClaims', {
          userId: 'owner',
          key: KEY,
          agentId: aiko.agentId,
          workItemId: aiko.workItemId,
          claimedAt: 1,
        }),
    );
    const holder = {
      claimId,
      agentId: aiko.agentId,
      workItemId: aiko.workItemId,
      name: 'Aiko',
      title: 'Audit note',
    };

    expect(claimRefusedVerdict(await row(harness, aiko.workItemId), holder, 'executing')).toEqual({
      decision: 'skip',
      reason: 'already-claimed: state=executing',
      claimedBy: holder,
    });
    expect(claimRefusedVerdict(await row(harness, ben.workItemId), holder, 'executing')).toEqual({
      decision: 'skip',
      reason: `${CLAIMED_BY_COLLEAGUE_SKIP_PREFIX}Aiko holds it (Audit note)`,
      claimedBy: holder,
    });
  });
});

describe('releaseExternalClaim', (): void => {
  it('stamps the claim released and sends back the colleague it refused', async (): Promise<void> => {
    useSurfaceMode('real');
    const { claimRefusedVerdict, releaseExternalClaim, takeExternalClaim } = await claimsModule();
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko');
    const ben = await employee(harness, 'Ben');
    await harness.run(async (ctx) => {
      await takeExternalClaim(ctx, await inside(ctx, aiko.workItemId), 10);
      const refused = await takeExternalClaim(ctx, await inside(ctx, ben.workItemId), 11);
      if (!refused?.heldBy) throw new Error('expected a refusal');
      await ctx.db.patch(ben.workItemId, {
        state: 'skipped',
        verdict: claimRefusedVerdict(
          await inside(ctx, ben.workItemId),
          refused.heldBy.holder,
          'claimed',
        ),
      });
    });

    await harness.run(async (ctx) => {
      await releaseExternalClaim(ctx, aiko.workItemId, 30);
    });

    expect((await claims(harness))[0]?.releasedAt).toBe(30);
    expect(await row(harness, ben.workItemId)).toMatchObject({
      state: 'discovered',
      reevaluation: { trigger: 'claim-released' },
    });
  });
});

describe('releaseItemClaim, settleWriteTargetClaims and holdsAgainst', (): void => {
  it('lets go of the item but keeps the page field, settled when the holder finished', async (): Promise<void> => {
    useSurfaceMode('real');
    const { holdsAgainst, releaseItemClaim, settleWriteTargetClaims, takeExternalClaim } =
      await claimsModule();
    const harness = convexTest(schema, allConvexModules());
    const aiko = await employee(harness, 'Aiko');
    await harness.run(async (ctx) => {
      await takeExternalClaim(ctx, await inside(ctx, aiko.workItemId), 10);
      await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'looker:revenue-tile',
        agentId: aiko.agentId,
        workItemId: aiko.workItemId,
        writeTarget: { surface: 'looker', field: 'revenue-tile' },
        claimedAt: 10,
      });
    });

    // The settle time is after the row's creation by the harness clock.
    const finished = Date.now() + 60_000;
    await harness.run(async (ctx) => {
      await releaseItemClaim(ctx, aiko.workItemId, 40);
      await settleWriteTargetClaims(ctx, aiko.workItemId, finished);
    });

    const [item, field] = await claims(harness);
    expect(item?.releasedAt).toBe(40);
    expect(field).toMatchObject({ settledAt: finished });
    expect(field?.releasedAt).toBeUndefined();
    const earlier = await row(harness, aiko.workItemId);
    if (!field) throw new Error('field claim missing');
    expect(holdsAgainst(field, earlier)).toBe(true);
    expect(holdsAgainst(field, { ...earlier, _creationTime: finished + 1 })).toBe(false);
  });
});

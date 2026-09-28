/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

/** Seed one agent with one surface in the given verdict. */
async function seedSurface(
  harness: ReturnType<typeof convexTest>,
  verdict: 'absent' | 'declared' | 'proposed',
): Promise<Id<'surfaces'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'reopen test',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    return await ctx.db.insert('surfaces', {
      agentId,
      slug: 'northstar-crm',
      displayName: 'Northstar CRM',
      class: 'crm',
      verdict,
      whereFound: [],
      credentialLanded: false,
      createdAt: 1,
      reason: 'No approved surface found after searching: Northstar CRM, crm',
    });
  });
}

describe('reopenAbsent', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers();
  });

  afterEach((): void => {
    vi.useRealTimers();
  });

  it('puts an absent surface back to declared, records why and places its orientation job', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedSurface(harness, 'absent');
    await expect(
      harness.mutation(internal.surfaceReopen.reopenAbsent, {
        surfaceId,
        charterNamesSystems: false,
      }),
    ).resolves.toBe('oriented');
    const { surface, events } = await harness.run(async (ctx) => {
      const surface = await ctx.db.get(surfaceId);
      const events = await ctx.db.query('events').collect();
      return { surface, events };
    });
    expect(surface).toMatchObject({
      verdict: 'declared',
      reason: 'A linked page now records Northstar CRM; orientation runs again.',
    });
    expect(surface?.orientationJobId).toBeDefined();
    expect(events.map((event) => event.type)).toEqual(['surface.reopened']);
  });

  it("records surface.reoriented when the manager's re-run re-opened it, and not when a sync did", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const byManager = await seedSurface(harness, 'absent');
    await expect(
      harness.mutation(internal.surfaceReopen.reopenAbsent, {
        surfaceId: byManager,
        charterNamesSystems: false,
        byManager: true,
      }),
    ).resolves.toBe('oriented');
    const bySync = await seedSurface(harness, 'absent');
    await harness.mutation(internal.surfaceReopen.reopenAbsent, {
      surfaceId: bySync,
      charterNamesSystems: false,
    });
    const reoriented = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'surface.reoriented',
      ),
    );
    expect(reoriented.map((event) => event.payload)).toEqual([{ surfaceId: byManager }]);
  });

  it('re-opens a system the charter does not name to wait for the manager, with no orientation job (review m34)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedSurface(harness, 'absent');
    await expect(
      harness.mutation(internal.surfaceReopen.reopenAbsent, {
        surfaceId,
        charterNamesSystems: true,
      }),
    ).resolves.toBe('awaiting-proposal');
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({
      verdict: 'declared',
      reason:
        'A linked page now records Northstar CRM. The charter does not name it, so it waits for the manager to propose it.',
    });
    expect(surface?.orientationJobId).toBeUndefined();
  });

  it('orients a re-opened system the charter names, whatever else it names', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedSurface(harness, 'absent');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, {
        discoveryEvidence: [
          {
            kind: 'charter',
            ref: 'charter',
            quote: 'We use Northstar CRM.',
            current: true,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        ],
      });
    });
    await expect(
      harness.mutation(internal.surfaceReopen.reopenAbsent, {
        surfaceId,
        charterNamesSystems: true,
      }),
    ).resolves.toBe('oriented');
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({
      verdict: 'declared',
      reason: 'A linked page now records Northstar CRM; orientation runs again.',
    });
    expect(surface?.orientationJobId).toBeDefined();
  });

  it('leaves a surface that is no longer absent alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    for (const verdict of ['declared', 'proposed'] as const) {
      const surfaceId = await seedSurface(harness, verdict);
      await expect(
        harness.mutation(internal.surfaceReopen.reopenAbsent, {
          surfaceId,
          charterNamesSystems: false,
        }),
      ).resolves.toBe('not-absent');
      expect((await harness.run(async (ctx) => await ctx.db.get(surfaceId)))?.verdict).toBe(
        verdict,
      );
    }
  });
});

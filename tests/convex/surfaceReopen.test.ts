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
        reason: 'A linked page now records Northstar CRM; orientation runs again.',
      }),
    ).resolves.toBe(true);
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

  it('leaves a surface that is no longer absent alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    for (const verdict of ['declared', 'proposed'] as const) {
      const surfaceId = await seedSurface(harness, verdict);
      await expect(
        harness.mutation(internal.surfaceReopen.reopenAbsent, { surfaceId, reason: 'again' }),
      ).resolves.toBe(false);
      expect((await harness.run(async (ctx) => await ctx.db.get(surfaceId)))?.verdict).toBe(
        verdict,
      );
    }
  });
});

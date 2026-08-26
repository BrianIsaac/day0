/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
  restoreSurfaceMode();
});

/**
 * Seed one owned agent and run the demo seed as its owner.
 *
 * The caller has already selected the surface mode, so the modules imported
 * here evaluate under it.
 *
 * Returns:
 *   The seed result and the per-agent row counts it left behind.
 */
async function seedAsOwner(): Promise<{
  result: { skillsInstalled: number; mockEnvSeeded: boolean; mode: string };
  channels: number;
  tickets: number;
  tweets: number;
  spreadsheets: number;
  docs: number;
  skills: string[];
}> {
  const { api } = await import('../../convex/_generated/api');
  const harness = convexTest(schema, allConvexModules());
  const agentId = await harness.run(
    async (ctx): Promise<Id<'agents'>> =>
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'seed test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      }),
  );
  const result = await harness.withIdentity({ subject: 'owner' }).action(api.seed.seedDemo, {
    agentId,
  });
  const counts = await harness.run(async (ctx) => ({
    channels: (await ctx.db.query('mockSlackChannels').collect()).length,
    tickets: (await ctx.db.query('mockTickets').collect()).length,
    tweets: (await ctx.db.query('mockTweets').collect()).length,
    spreadsheets: (await ctx.db.query('mockSpreadsheets').collect()).length,
    docs: (await ctx.db.query('mockDocs').collect()).length,
    skills: (await ctx.db.query('skills').collect()).map((skill): string => skill.name),
  }));
  return { result, ...counts };
}

describe('demo seed', (): void => {
  it('installs the builtin skill and the mock environment in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const seeded = await seedAsOwner();
    expect(seeded.result).toEqual({ skillsInstalled: 1, mockEnvSeeded: true, mode: 'mock' });
    expect(seeded.skills).toEqual(['see-internal-docs']);
    expect(seeded.channels).toBeGreaterThan(0);
    expect(seeded.tickets).toBeGreaterThan(0);
    expect(seeded.tweets).toBeGreaterThan(0);
    expect(seeded.spreadsheets).toBeGreaterThan(0);
    expect(seeded.docs).toBeGreaterThan(0);
  });

  it('installs only the builtin skill in real mode, leaving every mock table empty', async (): Promise<void> => {
    useSurfaceMode('real');
    const seeded = await seedAsOwner();
    expect(seeded.result).toEqual({ skillsInstalled: 1, mockEnvSeeded: false, mode: 'real' });
    expect(seeded.skills).toEqual(['see-internal-docs']);
    expect([seeded.channels, seeded.tickets, seeded.tweets, seeded.spreadsheets, seeded.docs]).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it('refuses to seed an agent the caller does not own', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'seed test',
          userId: 'owner',
          state: 'deployed',
          createdAt: 1,
        }),
    );
    await expect(
      harness.withIdentity({ subject: 'stranger' }).action(api.seed.seedDemo, { agentId }),
    ).rejects.toThrow('forbidden');
  });
});

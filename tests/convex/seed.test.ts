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
  docs: Array<{ slug: string; title: string; body: string }>;
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
    docs: (await ctx.db.query('mockDocs').collect()).map(({ slug, title, body }) => ({
      slug,
      title,
      body,
    })),
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
    expect(seeded.docs.length).toBeGreaterThan(0);
  });

  it('puts docs-task answers and work procedures in runtime onboarding documents', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { docs } = await seedAsOwner();
    const bySlug = Object.fromEntries(docs.map((doc) => [doc.slug, `${doc.title}\n${doc.body}`]));

    expect(bySlug['team-overview']).toContain('09:30 SGT');
    expect(bySlug['team-overview']).toContain('q4-revenue-tracker');
    expect(bySlug['on-call']).toContain('Tier-2 (this week): Sara');
    expect(bySlug['onboarding']).toContain('Tuesday committee prep silently');
    expect(bySlug['escalation-paths']).toContain('touch a Salesforce record');
    expect(bySlug['escalation-paths']).toContain('surface a draft to the manager for review');

    const procedures = docs
      .filter((doc) => doc.slug.startsWith('how-to-'))
      .map((doc) => doc.body)
      .join('\n');
    expect(procedures).toContain('spreadsheet.appendRow');
    expect(procedures).toContain('slack.postMessage');
    expect(procedures).toContain('ticket.update');
    expect(procedures).toContain('twitter.reply');
  });

  it('installs only the builtin skill in real mode, leaving every mock table empty', async (): Promise<void> => {
    useSurfaceMode('real');
    const seeded = await seedAsOwner();
    expect(seeded.result).toEqual({ skillsInstalled: 1, mockEnvSeeded: false, mode: 'real' });
    expect(seeded.skills).toEqual(['see-internal-docs']);
    expect([seeded.channels, seeded.tickets, seeded.tweets, seeded.spreadsheets, seeded.docs.length]).toEqual([
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

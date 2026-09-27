import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

describe('mock documentation mirrors', (): void => {
  it('preserves source metadata when a page is upserted', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ids = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Team folder',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'mirror test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      return { sourceId, agentId };
    });
    const docId = await harness.mutation(internal.mock.upsertDoc, {
      agentId: ids.agentId,
      slug: 'source-onboarding',
      title: 'Onboarding',
      body: '# Onboarding',
      category: 'team-doc',
      sourceId: ids.sourceId,
      sourceRef: 'onboarding.md',
      sourceUrl: 'https://example.com/onboarding',
    });
    await expect(harness.run(async (ctx) => await ctx.db.get(docId))).resolves.toMatchObject({
      sourceId: ids.sourceId,
      sourceRef: 'onboarding.md',
      sourceUrl: 'https://example.com/onboarding',
    });
    await expect(
      harness.query(internal.mock.snapshotInternal, { agentId: ids.agentId }),
    ).resolves.toMatchObject({
      teamDocs: [{ slug: 'source-onboarding', title: 'Onboarding', body: '# Onboarding' }],
      howToGuides: [],
      spreadsheets: [],
      slackChannels: [],
      tweets: [],
      tickets: [],
    });
  });
});

describe('the sync generation fence on mirrors (step 14)', (): void => {
  it('refuses a mirror from a superseded sync and writes the running sync’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await harness.run(async (ctx) => ({
      sourceId: await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Team folder',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      }),
      agentId: await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'mirror test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      }),
    }));
    const stale = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const current = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const mirror = {
      agentId,
      slug: 'source-onboarding',
      title: 'Onboarding',
      body: '# Onboarding',
      category: 'team-doc' as const,
      sourceId,
      sourceRef: 'onboarding.md',
    };

    await expect(
      harness.mutation(internal.mock.upsertDoc, { ...mirror, syncRunId: stale }),
    ).rejects.toThrow('superseded by a newer one');
    expect(await harness.run(async (ctx) => await ctx.db.query('mockDocs').collect())).toEqual([]);

    await harness.mutation(internal.mock.upsertDoc, { ...mirror, syncRunId: current });
    expect(await harness.run(async (ctx) => await ctx.db.query('mockDocs').collect())).toEqual([
      expect.objectContaining({ slug: 'source-onboarding', sourceRef: 'onboarding.md' }),
    ]);
  });
});

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, fixtureAddressOf, managerIdentity } from './fakes/manager-identity';

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
        bossEmail: MANAGER_ADDRESS,
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
        bossEmail: MANAGER_ADDRESS,
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

describe('which mirrored pages an employee reads (transfer plan 6.2)', (): void => {
  /**
   * Seed an employee of `colleague` with one seeded office page and one page mirrored from each
   * of three sources: one of the owner's that it reads, one of the owner's it was deployed
   * without, and one of a previous owner's.
   */
  async function seedMirrors(harness: ReturnType<typeof convexTest>): Promise<Id<'agents'>> {
    return await harness.run(async (ctx) => {
      const source = async (userId: string, label: string): Promise<Id<'docSources'>> =>
        await ctx.db.insert('docSources', {
          userId,
          label,
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        });
      const own = await source('colleague', 'Colleague handbook');
      const unticked = await source('colleague', 'Colleague archive');
      const previous = await source('owner', 'Owner handbook');
      const agentId = await ctx.db.insert('agents', {
        bossEmail: fixtureAddressOf('colleague'),
        name: 'Maya',
        userId: 'colleague',
        excludedDocSourceIds: [unticked],
        state: 'active',
        createdAt: 1,
      });
      const page = async (slug: string, sourceId?: Id<'docSources'>): Promise<void> => {
        await ctx.db.insert('mockDocs', {
          agentId,
          slug,
          title: slug,
          body: `# ${slug}`,
          category: 'team-doc',
          ...(sourceId ? { sourceId, sourceRef: `${slug}.md` } : {}),
          updatedAt: 1,
        });
      };
      await page('office-welcome');
      await page('colleague-onboarding', own);
      await page('colleague-archive', unticked);
      await page('owner-onboarding', previous);
      return agentId;
    });
  }

  it("lists the seeded pages and its own owner's read sources, never another owner's mirror", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedMirrors(harness);
    const docs = await harness
      .withIdentity(managerIdentity('colleague'))
      .query(api.mock.listDocs, { agentId });
    expect(docs.map((doc) => doc.slug).sort()).toEqual(['colleague-onboarding', 'office-welcome']);
  });

  it("answers no page for a slug mirrored from another owner's source", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedMirrors(harness);
    const caller = harness.withIdentity(managerIdentity('colleague'));
    await expect(
      caller.query(api.mock.getDoc, { agentId, slug: 'owner-onboarding' }),
    ).resolves.toBeNull();
    await expect(
      caller.query(api.mock.getDoc, { agentId, slug: 'colleague-onboarding' }),
    ).resolves.toMatchObject({ slug: 'colleague-onboarding' });
  });

  it("gives a run's snapshot the same pages, so the employee never works from another owner's", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedMirrors(harness);
    const snapshot = await harness.query(internal.mock.snapshotInternal, { agentId });
    expect(snapshot.teamDocs.map((doc) => doc.slug).sort()).toEqual([
      'colleague-onboarding',
      'office-welcome',
    ]);
  });
});

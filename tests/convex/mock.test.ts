import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, fixtureAddressOf, managerIdentity } from './fakes/manager-identity';
import { MOCK_OFFICE_DOCS_READ } from '../../convex/mock';

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
    if (docId === null) throw new Error('the mirror was not written');
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
      .query(api.mock.listDocs, { agentId, paginationOpts: { numItems: 50, cursor: null } });
    expect(docs.page.map((doc) => doc.slug).sort()).toEqual([
      'colleague-onboarding',
      'office-welcome',
    ]);
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

describe('a mirror written for an employee that no longer reads its source (transfer plan 6.2)', (): void => {
  it("writes nothing for a page of another owner's source, as a sync begun before a handover would", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId } = await harness.run(async (ctx) => ({
      sourceId: await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Owner handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      }),
      agentId: await ctx.db.insert('agents', {
        bossEmail: fixtureAddressOf('colleague'),
        name: 'Maya',
        userId: 'colleague',
        state: 'active',
        createdAt: 1,
      }),
    }));

    await expect(
      harness.mutation(internal.mock.upsertDoc, {
        agentId,
        slug: 'owner-runbook',
        title: 'Runbook',
        body: '# Runbook',
        category: 'team-doc',
        sourceId,
        sourceRef: 'runbook.md',
      }),
    ).resolves.toBeNull();
    expect(await harness.run(async (ctx) => await ctx.db.query('mockDocs').collect())).toEqual([]);
  });
});

describe('no reader collects every mirror (M17, R6)', (): void => {
  /** An employee of `owner` holding `count` pages mirrored from one source, each `bytes` long. */
  async function seedLargeMirror(
    harness: ReturnType<typeof convexTest>,
    count: number,
    bytes: number,
  ): Promise<Id<'agents'>> {
    return await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Handbook',
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
        state: 'active',
        createdAt: 1,
      });
      for (let index = 0; index < count; index += 1) {
        const slug = `handbook-page-${String(index).padStart(2, '0')}`;
        await ctx.db.insert('mockDocs', {
          agentId,
          slug,
          title: `Handbook page ${index}`,
          body: `# Handbook page ${index}\n\n${'x'.repeat(bytes)}`,
          category: 'team-doc',
          sourceId,
          sourceRef: `${slug}.md`,
          updatedAt: 1,
        });
      }
      return agentId;
    });
  }

  it('lists the Docs tab a bounded page at a time, without bodies, and reaches every page', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    // The review's fixture: forty mirrors of about 532 KB, past one read's 16 MiB.
    const agentId = await seedLargeMirror(harness, 40, 532 * 1024);
    const caller = harness.withIdentity(managerIdentity('owner'));
    const slugs: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof listPage>> = await listPage(cursor);
      expect(page.page.length).toBeLessThanOrEqual(8);
      for (const doc of page.page) {
        expect(doc).not.toHaveProperty('body');
        slugs.push(doc.slug);
      }
      pages += 1;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(slugs).toEqual(
      Array.from(
        { length: 40 },
        (_value, index) => `handbook-page-${String(index).padStart(2, '0')}`,
      ),
    );

    async function listPage(at: string | null) {
      return await caller.query(api.mock.listDocs, {
        agentId,
        paginationOpts: { numItems: 50, cursor: at },
      });
    }
  });

  it("reads a mock office's documents up to its fixed size, and fails past it", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const seed = async (count: number): Promise<Id<'agents'>> =>
      await harness.run(async (ctx) => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'office test',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        for (let index = 0; index < count; index += 1) {
          await ctx.db.insert('mockDocs', {
            agentId,
            slug: `office-page-${String(index).padStart(2, '0')}`,
            title: `Office page ${index}`,
            body: `# Office page ${index}`,
            category: 'team-doc',
            updatedAt: 1,
          });
        }
        return agentId;
      });
    const full = await seed(MOCK_OFFICE_DOCS_READ);
    await expect(
      harness.query(internal.mock.snapshotInternal, { agentId: full }),
    ).resolves.toMatchObject({ teamDocs: expect.any(Array) });
    const past = await seed(MOCK_OFFICE_DOCS_READ + 1);
    await expect(harness.query(internal.mock.snapshotInternal, { agentId: past })).rejects.toThrow(
      `holds more than ${MOCK_OFFICE_DOCS_READ} documents`,
    );
  });

  it("seeds the hosted office within the snapshot's bound", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'office test',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.mockSeed.seedMockEnvironment, { agentId });
    const seeded = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('mockDocs')
          .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.length).toBeLessThanOrEqual(MOCK_OFFICE_DOCS_READ);
  });
});

describe('a mirror for an unlinked source (M18)', (): void => {
  it('refuses a mirror for an unlinked source, as a deploy mirroring across the unlink would write it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId } = await harness.run(async (ctx) => {
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
      // The unlink deletes the source row first and its pages and mirrors in scheduled pages
      // after, so a walk of the pages begun before it still holds pages to mirror.
      await ctx.db.delete(sourceId);
      return { agentId, sourceId };
    });

    await expect(
      harness.mutation(internal.mock.upsertDoc, {
        agentId,
        slug: 'source-onboarding',
        title: 'Onboarding',
        body: '# Onboarding',
        category: 'team-doc',
        sourceId,
        sourceRef: 'onboarding.md',
      }),
    ).resolves.toBeNull();
    expect(await harness.run(async (ctx) => await ctx.db.query('mockDocs').collect())).toEqual([]);
  });
});

describe('openTicketsForDraftedWork', (): void => {
  it("opens the office's next ticket for a drafted ticket item and returns the batch naming it", async (): Promise<void> => {
    const { openTicketsForDraftedWork } = await import('../../convex/mock');
    const harness = convexTest(schema, allConvexModules());
    const result = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'office test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('mockTickets', {
        agentId,
        slug: 'REVOPS-203',
        title: 'Seeded',
        body: 'Seeded.',
        status: 'open',
        comments: [],
        updatedAt: 1,
      });
      const items = await openTicketsForDraftedWork(ctx, agentId, [
        {
          sourceCategory: 'ticket-queue',
          sourceSystem: 'ticket',
          title: 'New laptop needed for the analyst starting Monday',
          contentSummary: 'Nora filed it.',
          contentRefs: [],
        },
      ]);
      const tickets = await ctx.db
        .query('mockTickets')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId))
        .collect();
      return { refs: items.map((item) => item.contentRefs), tickets };
    });
    expect(result.refs).toEqual([['ticket://REVOPS-204']]);
    expect(
      result.tickets.map((ticket) => [ticket.slug, ticket.title, ticket.status]).sort(),
    ).toEqual([
      ['REVOPS-203', 'Seeded', 'open'],
      ['REVOPS-204', 'New laptop needed for the analyst starting Monday', 'open'],
    ]);
  });
});

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { PAGE_TABLE_ROWS } from '../../convex/docPages';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';

type Harness = ReturnType<typeof convexTest>;

/**
 * One owner's source with three stored pages and a completed sync that could not read one of
 * them, which kept its earlier version.
 */
async function seed(harness: Harness): Promise<Id<'docSources'>> {
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'RevOps team wiki',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      credentialRefs: [],
      pageCount: 3,
      redactionCount: 0,
      state: 'completed',
      createdAt: 1,
      completedAt: 5_000,
      unread: { count: 1, pages: [{ ref: 'escalation.md', reason: 'the page timed out' }] },
    });
    await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
    const page = async (ref: string, title: string, url?: string): Promise<void> => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref,
        title,
        ...(url !== undefined ? { url } : {}),
        markdown: `# ${title}`,
        updatedAt: 4_000,
      });
    };
    await page('overview.md', 'Team overview', 'https://wiki.example/overview');
    await page('escalation.md', 'Escalation paths');
    await page('on-call.md', 'On-call rotation');
    return sourceId;
  });
}

const FIRST_PAGE = { numItems: 10, cursor: null };

describe('docPages.listForSource', (): void => {
  it("lists a source's pages without their bodies, marking the one the last sync could not read", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);

    const result = await harness
      .withIdentity(managerIdentity())
      .query(api.docPages.listForSource, { sourceId, paginationOpts: FIRST_PAGE });

    expect(result.isDone).toBe(true);
    // Re-pinned by 15-A: every row says its status and what decided it (A5), where the table
    // waited on the authority records.
    const undecided = { status: 'active', statusSource: 'default' };
    expect(result.page.map((row) => ({ ...row, _id: undefined }))).toEqual([
      {
        _id: undefined,
        ref: 'overview.md',
        title: 'Team overview',
        url: 'https://wiki.example/overview',
        updatedAt: 4_000,
        ...undecided,
      },
      {
        _id: undefined,
        ref: 'escalation.md',
        title: 'Escalation paths',
        updatedAt: 4_000,
        unreadReason: 'the page timed out',
        ...undecided,
      },
      {
        _id: undefined,
        ref: 'on-call.md',
        title: 'On-call rotation',
        updatedAt: 4_000,
        ...undecided,
      },
    ]);
  });

  it('says each page’s status, what decided it, who and when for the manager, and a relation still to answer (15-A)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);
    await harness.run(async (ctx) => {
      const pages = await ctx.db.query('docPages').collect();
      const byRef = new Map(pages.map((page) => [page.ref, page]));
      // The manager marked one a draft; another manager marked one before the handover.
      await ctx.db.patch(byRef.get('overview.md')!._id, {
        status: 'draft',
        statusSource: 'manager',
        decidedBy: 'boss@day0.local',
        decidedAt: 6_000,
      });
      await ctx.db.patch(byRef.get('on-call.md')!._id, {
        status: 'superseded',
        statusSource: 'manager',
        decidedBy: 'earlier@day0.local',
        decidedAt: 5_000,
        supersededBy: { sourceId, ref: 'overview.md' },
      });
      // A relation still to answer proposes a later version of the escalation page.
      await ctx.db.insert('docRelations', {
        userId: 'owner',
        from: { sourceId, ref: 'overview.md' },
        to: { sourceId, ref: 'escalation.md' },
        kind: 'possible_successor',
        evidence: [{ measure: 'title-version', value: 1 }],
        status: 'proposed',
        createdAt: 7_000,
      });
    });
    const result = await harness
      .withIdentity(managerIdentity())
      .query(api.docPages.listForSource, { sourceId, paginationOpts: FIRST_PAGE });
    const rows = Object.fromEntries(
      result.page.map(
        ({
          ref,
          status,
          statusSource,
          decidedAt,
          decidedBy,
          decidedByYou,
          possiblySuperseded,
          supersededBy,
        }) => [
          ref,
          {
            status,
            statusSource,
            decidedAt,
            decidedBy,
            decidedByYou,
            possiblySuperseded,
            supersededBy,
          },
        ],
      ),
    );
    expect(rows['overview.md']).toEqual({
      status: 'draft',
      statusSource: 'manager',
      decidedAt: 6_000,
      decidedByYou: true,
    });
    expect(rows['on-call.md']).toEqual({
      status: 'superseded',
      statusSource: 'manager',
      decidedAt: 5_000,
      decidedBy: 'earlier@day0.local',
      decidedByYou: false,
      supersededBy: 'Team overview',
    });
    expect(rows['escalation.md']).toEqual({
      status: 'active',
      statusSource: 'default',
      possiblySuperseded: true,
    });
  });

  it('names what superseded each page inside a bound on the page bytes it reads for it', async (): Promise<void> => {
    // The second pass's minor 5: each row's successor was read as a whole page row, up to 50 of
    // them at up to 768 KiB each, outside the read's byte bound.
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);
    await harness.run(async (ctx) => {
      const guides = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'How-to guides',
        kind: 'folder',
        locator: 'guides',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      // Three successors in another source, each near the largest a stored page may be.
      for (const name of ['one', 'two', 'three']) {
        await ctx.db.insert('docPages', {
          sourceId: guides,
          ref: `long-${name}.md`,
          title: `Long ${name}`,
          markdown: `# Long ${name}\n\n${'x'.repeat(700 * 1024)}`,
          updatedAt: 1,
        });
      }
      const superseded = async (ref: string, by: { sourceId: Id<'docSources'>; ref: string }) => {
        await ctx.db.insert('docPages', {
          sourceId,
          ref,
          title: ref,
          markdown: `# ${ref}`,
          updatedAt: 1,
          status: 'superseded',
          statusSource: 'manager',
          supersededBy: by,
        });
      };
      // A successor listed in the same table costs no read of its own.
      await superseded('old-overview.md', { sourceId, ref: 'overview.md' });
      await superseded('old-a.md', { sourceId: guides, ref: 'long-one.md' });
      // The same successor again is read once.
      await superseded('old-b.md', { sourceId: guides, ref: 'long-one.md' });
      await superseded('old-c.md', { sourceId: guides, ref: 'long-two.md' });
      await superseded('old-d.md', { sourceId: guides, ref: 'long-three.md' });
    });
    const result = await harness
      .withIdentity(managerIdentity())
      .query(api.docPages.listForSource, { sourceId, paginationOpts: FIRST_PAGE });
    const named = Object.fromEntries(result.page.map((row) => [row.ref, row.supersededBy]));
    expect(named).toMatchObject({
      'old-overview.md': 'Team overview',
      'old-a.md': 'Long one',
      'old-b.md': 'Long one',
      // Past the bound a successor is named by its ref, which the row holds, with no read.
      'old-c.md': 'long-two.md',
      'old-d.md': 'long-three.md',
    });
  });

  it('returns at most its row bound however many are asked for', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);
    await harness.run(async (ctx) => {
      for (let index = 0; index < PAGE_TABLE_ROWS + 5; index += 1) {
        await ctx.db.insert('docPages', {
          sourceId,
          ref: `extra-${index}.md`,
          title: `Extra ${index}`,
          markdown: '',
          updatedAt: 1,
        });
      }
    });

    const result = await harness.withIdentity(managerIdentity()).query(api.docPages.listForSource, {
      sourceId,
      paginationOpts: { numItems: 500, cursor: null },
    });

    expect(result.page).toHaveLength(PAGE_TABLE_ROWS);
    expect(result.isDone).toBe(false);
  });

  it("refuses another owner's source and lists nothing for one that is gone", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);

    await expect(
      harness
        .withIdentity(managerIdentity('stranger'))
        .query(api.docPages.listForSource, { sourceId, paginationOpts: FIRST_PAGE }),
    ).rejects.toThrow('forbidden');
    await harness.run(async (ctx) => await ctx.db.delete(sourceId));
    await expect(
      harness
        .withIdentity(managerIdentity())
        .query(api.docPages.listForSource, { sourceId, paginationOpts: FIRST_PAGE }),
    ).resolves.toEqual({ page: [], isDone: true, continueCursor: '' });
  });
});

describe('docPages.readState', (): void => {
  it('says when the last sync finished and how many listed pages it could not read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);

    await expect(
      harness.withIdentity(managerIdentity()).query(api.docPages.readState, { sourceId }),
    ).resolves.toEqual({ completedAt: 5_000, unreadCount: 1, unreadNamed: 1 });
  });

  it('answers null before any sync has completed, and for a source that is gone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);
    const owner = harness.withIdentity(managerIdentity());
    await harness.run(
      async (ctx) => await ctx.db.patch(sourceId, { lastCompletedSyncId: undefined }),
    );

    await expect(owner.query(api.docPages.readState, { sourceId })).resolves.toBeNull();
    await harness.run(async (ctx) => await ctx.db.delete(sourceId));
    await expect(owner.query(api.docPages.readState, { sourceId })).resolves.toBeNull();
  });
});

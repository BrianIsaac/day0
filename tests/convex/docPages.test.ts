import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { PAGE_TABLE_ROWS } from '../../convex/docPages';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

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
      .withIdentity({ subject: 'owner' })
      .query(api.docPages.listForSource, { sourceId, paginationOpts: FIRST_PAGE });

    expect(result.isDone).toBe(true);
    expect(result.page.map((row) => ({ ...row, _id: undefined }))).toEqual([
      {
        _id: undefined,
        ref: 'overview.md',
        title: 'Team overview',
        url: 'https://wiki.example/overview',
        updatedAt: 4_000,
      },
      {
        _id: undefined,
        ref: 'escalation.md',
        title: 'Escalation paths',
        updatedAt: 4_000,
        unreadReason: 'the page timed out',
      },
      { _id: undefined, ref: 'on-call.md', title: 'On-call rotation', updatedAt: 4_000 },
    ]);
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

    const result = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.docPages.listForSource, {
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
        .withIdentity({ subject: 'stranger' })
        .query(api.docPages.listForSource, { sourceId, paginationOpts: FIRST_PAGE }),
    ).rejects.toThrow('forbidden');
    await harness.run(async (ctx) => await ctx.db.delete(sourceId));
    await expect(
      harness
        .withIdentity({ subject: 'owner' })
        .query(api.docPages.listForSource, { sourceId, paginationOpts: FIRST_PAGE }),
    ).resolves.toEqual({ page: [], isDone: true, continueCursor: '' });
  });
});

describe('docPages.readState', (): void => {
  it('says when the last sync finished and how many listed pages it could not read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);

    await expect(
      harness.withIdentity({ subject: 'owner' }).query(api.docPages.readState, { sourceId }),
    ).resolves.toEqual({ completedAt: 5_000, unreadCount: 1, unreadNamed: 1 });
  });

  it('answers null before any sync has completed, and for a source that is gone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seed(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await harness.run(
      async (ctx) => await ctx.db.patch(sourceId, { lastCompletedSyncId: undefined }),
    );

    await expect(owner.query(api.docPages.readState, { sourceId })).resolves.toBeNull();
    await harness.run(async (ctx) => await ctx.db.delete(sourceId));
    await expect(owner.query(api.docPages.readState, { sourceId })).resolves.toBeNull();
  });
});

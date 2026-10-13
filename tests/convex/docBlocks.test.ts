import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { copyPageStatusToBlocks, replacePageBlocks } from '../../convex/docBlocks';
import type { PageStatus } from '../../src/docs/authority';
import { allConvexModules } from './all-modules';

/** Every split the backend runs, counted (W15-R25): the module's own, passed through. */
const splits = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/docs/blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/docs/blocks')>();
  return {
    ...actual,
    splitPage: (markdown: string) => {
      splits.count += 1;
      return actual.splitPage(markdown);
    },
  };
});

afterEach((): void => {
  vi.useRealTimers();
});

/** A runbook of three sections, the page most tests split. */
const RUNBOOK = [
  '# Refreshing the tile',
  '',
  'Open the pipeline dashboard.',
  '',
  '## When it is stale',
  '',
  'Press refresh twice.',
  '',
  '# Posting the result',
  '',
  'Post in the revops channel.',
].join('\n');

/** A linked source of `userId`'s and a completed run of it. */
async function sourceOf(
  harness: TestConvex<typeof schema>,
  userId = 'owner',
): Promise<{ sourceId: Id<'docSources'>; runId: Id<'docSyncRuns'> }> {
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId,
      label: 'Handbook',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      listing: 1,
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
      state: 'completed',
      createdAt: 2,
    });
    return { sourceId, runId };
  });
}

/**
 * Mark a source's library as v0.19.0 left it: owed the relations remeasure the 0.20.0 pass marks
 * every page-holding source with, until a sync has seen it (W15-R25).
 */
async function v019Library(
  harness: TestConvex<typeof schema>,
  sourceId: Id<'docSources'>,
): Promise<void> {
  await harness.run(
    async (ctx) => await ctx.db.patch(sourceId, { relationsRemeasure: { cursor: null } }),
  );
}

/** Split `markdown` into the page's stored blocks, as an upsert does. */
async function split(
  harness: TestConvex<typeof schema>,
  page: {
    sourceId: Id<'docSources'>;
    runId: Id<'docSyncRuns'>;
    userId?: string;
    pageRef?: string;
    status?: PageStatus;
  },
  markdown: string,
): Promise<number> {
  return await harness.run(
    async (ctx) =>
      await replacePageBlocks(ctx, {
        userId: page.userId ?? 'owner',
        sourceId: page.sourceId,
        pageRef: page.pageRef ?? 'runbooks/refresh.md',
        generation: page.runId,
        markdown,
        ...(page.status !== undefined ? { status: page.status } : {}),
      }),
  );
}

/** A page's stored blocks in document order. */
async function blocksOf(
  harness: TestConvex<typeof schema>,
  sourceId: Id<'docSources'>,
  pageRef = 'runbooks/refresh.md',
) {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('docBlocks')
        .withIndex('by_source_page', (q) => q.eq('sourceId', sourceId).eq('pageRef', pageRef))
        .collect(),
  );
}

describe('replacePageBlocks', (): void => {
  it("stores a page's blocks in document order, under the owner and the run that wrote them", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    expect(await split(harness, { sourceId, runId }, RUNBOOK)).toBe(3);
    const blocks = await blocksOf(harness, sourceId);
    expect(blocks.map((block) => [block.index, block.headingPath, block.text])).toEqual([
      [0, ['Refreshing the tile'], 'Open the pipeline dashboard.'],
      [1, ['Refreshing the tile', 'When it is stale'], 'Press refresh twice.'],
      [2, ['Posting the result'], 'Post in the revops channel.'],
    ]);
    expect(blocks.every((block) => block.userId === 'owner' && block.generation === runId)).toBe(
      true,
    );
  });

  it('changes nothing when run twice over the same page, so every block keeps its row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId }, RUNBOOK);
    const before = await blocksOf(harness, sourceId);
    expect(await split(harness, { sourceId, runId }, RUNBOOK)).toBe(0);
    expect(await blocksOf(harness, sourceId)).toEqual(before);
  });

  it('rewrites only the block that changed and deletes the blocks past a shorter page', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId }, RUNBOOK);
    const before = await blocksOf(harness, sourceId);
    const edited = RUNBOOK.replace('Press refresh twice.', 'Press refresh three times.');
    expect(await split(harness, { sourceId, runId }, edited)).toBe(1);
    const after = await blocksOf(harness, sourceId);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]._id).toBe(before[1]._id);
    expect(after[1].text).toBe('Press refresh three times.');
    const shorter = edited.slice(0, edited.indexOf('# Posting'));
    expect(await split(harness, { sourceId, runId }, shorter)).toBe(1);
    expect((await blocksOf(harness, sourceId)).map((block) => block.index)).toEqual([0, 1]);
  });

  it("keeps an unchanged block's row when a block is inserted above it, so a citation of it stands (W14-R2)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId }, RUNBOOK);
    const before = await blocksOf(harness, sourceId);
    const inserted = RUNBOOK.replace(
      '## When it is stale',
      '## Who to ask\n\nAsk the revenue operations lead.\n\n## When it is stale',
    );
    await split(harness, { sourceId, runId }, inserted);
    const after = await blocksOf(harness, sourceId);
    expect(after.map((block) => [block.index, block.text])).toEqual([
      [0, 'Open the pipeline dashboard.'],
      [1, 'Ask the revenue operations lead.'],
      [2, 'Press refresh twice.'],
      [3, 'Post in the revops channel.'],
    ]);
    const idOf = (text: string): string | undefined =>
      after.find((block) => block.text === text)?._id;
    for (const block of before) {
      expect(idOf(block.text)).toBe(block._id);
      expect(after.find((row) => row._id === block._id)?.hash).toBe(block.hash);
    }
  });
});

describe('replacePageBlocks and a page whose title is renamed (W15-R21)', (): void => {
  const LIMITS = [
    '# Close limits',
    '',
    '## Thresholds',
    '',
    'Escalate any variance above 5,000 USD.',
    '',
    '## Comment length',
    '',
    'An audit comment is at most 60 words.',
  ].join('\n');

  it('re-points a conflict’s evidence at the blocks whose text and inner headings are what they were, and at no other', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const page = await sourceOf(harness);
    await split(harness, page, LIMITS);
    const [thresholds, comments] = (await blocksOf(harness, page.sourceId)).map(
      (block) => block.hash,
    );
    const relationId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docRelations', {
          userId: 'owner',
          from: { sourceId: page.sourceId, ref: 'runbooks/refresh.md' },
          to: { sourceId: page.sourceId, ref: 'other.md' },
          kind: 'possible_conflict',
          evidence: [
            { measure: 'heading-figures', value: 2, blockRefs: [thresholds, 'other-1', comments] },
            { measure: 'shared-text', value: 40, blockRefs: [thresholds, 'other-2'] },
          ],
          status: 'confirmed',
          createdAt: 1,
        }),
    );
    // The H1 renamed, and the comment limit's figure changed with it.
    await split(
      harness,
      page,
      LIMITS.replace('# Close limits', '# Close limits for RevOps').replace('60 words', '90 words'),
    );
    const [renamed, changed] = (await blocksOf(harness, page.sourceId)).map((block) => block.hash);
    expect(renamed).not.toBe(thresholds);
    expect(changed).not.toBe(comments);
    expect((await harness.run(async (ctx) => await ctx.db.get(relationId)))?.evidence).toEqual([
      // The passage that only moved under a new title is named by its new hash; the one whose
      // figure changed keeps the hash no block holds, so it is measured afresh.
      { measure: 'heading-figures', value: 2, blockRefs: [renamed, 'other-1', comments] },
      { measure: 'shared-text', value: 40, blockRefs: [thresholds, 'other-2'] },
    ]);
  });
});

describe('splitStoredPage', (): void => {
  it('splits the page as stored when it runs, and nothing for a page gone by then', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbooks/refresh.md',
        title: 'Refresh',
        markdown: RUNBOOK,
        updatedAt: 1,
      });
    });
    const split = async (ref: string) =>
      await harness.mutation(internal.docBlocks.splitStoredPage, {
        sourceId,
        ref,
        generation: runId,
      });
    expect(await split('runbooks/refresh.md')).toBe(3);
    expect(await split('runbooks/refresh.md')).toBe(0);
    expect(await split('gone.md')).toBe(0);
    expect(await blocksOf(harness, sourceId)).toHaveLength(3);
  });
});

describe("a page's status on its blocks (15-A, the item 15-K carried)", (): void => {
  it('stores every block under the status of its page, and as active for a page nothing has decided', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId }, RUNBOOK);
    await split(harness, { sourceId, runId, pageRef: 'old.md', status: 'superseded' }, RUNBOOK);
    expect((await blocksOf(harness, sourceId)).map((block) => block.status)).toEqual([
      'active',
      'active',
      'active',
    ]);
    expect((await blocksOf(harness, sourceId, 'old.md')).map((block) => block.status)).toEqual([
      'superseded',
      'superseded',
      'superseded',
    ]);
  });

  it('patches a kept block whose status differs from its page, so its row and a citation of it stay', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId }, RUNBOOK);
    const before = await blocksOf(harness, sourceId);
    expect(await split(harness, { sourceId, runId, status: 'archived' }, RUNBOOK)).toBe(3);
    const after = await blocksOf(harness, sourceId);
    expect(after.map((block) => block._id)).toEqual(before.map((block) => block._id));
    expect(after.map((block) => block.status)).toEqual(['archived', 'archived', 'archived']);
    expect(await split(harness, { sourceId, runId, status: 'archived' }, RUNBOOK)).toBe(0);
  });

  it('keeps the status on a block it rewrites in place, which the 0.19.0 pass wrote', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId }, RUNBOOK);
    // The rows as the `docs-blocks-status` pass leaves a block stored before 0.19.0.
    await harness.run(async (ctx) => {
      for (const row of await ctx.db.query('docBlocks').collect()) {
        await ctx.db.patch(row._id, { status: 'active' });
      }
    });
    const edited = RUNBOOK.replace('Press refresh twice.', 'Press refresh three times.');
    await split(harness, { sourceId, runId }, edited);
    const after = await blocksOf(harness, sourceId);
    expect(after.map((block) => [block.text, block.status])).toEqual([
      ['Open the pipeline dashboard.', 'active'],
      ['Press refresh three times.', 'active'],
      ['Post in the revops channel.', 'active'],
    ]);
  });

  it("splits a stored page under the status its row holds, so a draft's blocks are drafts", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbooks/refresh.md',
        title: 'Refresh',
        markdown: RUNBOOK,
        updatedAt: 1,
        status: 'draft',
        statusSource: 'manager',
      });
    });
    await harness.mutation(internal.docBlocks.splitStoredPage, {
      sourceId,
      ref: 'runbooks/refresh.md',
      generation: runId,
    });
    expect((await blocksOf(harness, sourceId)).map((block) => block.status)).toEqual([
      'draft',
      'draft',
      'draft',
    ]);
  });

  it("copies a page's new status onto its blocks with no re-split, writing only the rows that differ", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId }, RUNBOOK);
    await split(harness, { sourceId, runId, pageRef: 'other.md' }, RUNBOOK);
    const before = await blocksOf(harness, sourceId);
    const copy = async (status: PageStatus): Promise<number> =>
      await harness.run(
        async (ctx) =>
          await copyPageStatusToBlocks(ctx, { sourceId, pageRef: 'runbooks/refresh.md', status }),
      );
    expect(await copy('superseded')).toBe(3);
    const after = await blocksOf(harness, sourceId);
    expect(after.map((block) => [block._id, block.hash, block.status])).toEqual(
      before.map((block) => [block._id, block.hash, 'superseded']),
    );
    expect(await copy('superseded')).toBe(0);
    expect((await blocksOf(harness, sourceId, 'other.md')).map((block) => block.status)).toEqual([
      'active',
      'active',
      'active',
    ]);
  });
});

describe('splitStoredPage and a page of long nested headings (W14-R1)', (): void => {
  it("writes the page's blocks inside a transaction's write limit, its paths bounded", async (): Promise<void> => {
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { sourceId, runId } = await sourceOf(harness);
    const han = (length: number, offset: number): string =>
      Array.from({ length }, (_unused, index) =>
        String.fromCodePoint(0x4e00 + ((index * 7 + offset * 13) % 2_000)),
      ).join('');
    // Reader 1's probe: past 16 MiB of rows while every block carried the whole 1,200-character path.
    const markdown = [
      ...[1, 2, 3, 4, 5].map((level) => `${'#'.repeat(level)} ${han(200, level)}`),
      ...Array.from(
        { length: 1_400 },
        (_unused, index) => `###### ${han(200, index)}\n\n${han(4, index)}`,
      ),
    ].join('\n\n');
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'nested.md',
        title: 'Nested',
        markdown,
        updatedAt: 1,
      });
    });
    await expect(
      harness.mutation(internal.docBlocks.splitStoredPage, {
        sourceId,
        ref: 'nested.md',
        generation: runId,
      }),
    ).resolves.toBe(1_400);
  }, 60_000);
});

describe('searchBlocks', (): void => {
  it("answers the owner's blocks of the sources asked, never another owner's", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ours = await sourceOf(harness);
    const other = await sourceOf(harness);
    const theirs = await sourceOf(harness, 'another');
    await split(harness, ours, RUNBOOK);
    await split(harness, other, RUNBOOK);
    await split(harness, { ...theirs, userId: 'another' }, RUNBOOK);
    const found = await harness.query(internal.docBlocks.searchBlocks, {
      userId: 'owner',
      sourceIds: [ours.sourceId, theirs.sourceId],
      query: 'twice',
    });
    expect(found.map((block) => [block.sourceId, block.index])).toEqual([[ours.sourceId, 1]]);
  });

  it('answers each found block with the hash its row holds, so a cite needs no second read (14-R, for 14-I)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await sourceOf(harness);
    await split(harness, source, RUNBOOK);
    const found = await harness.query(internal.docBlocks.searchBlocks, {
      userId: 'owner',
      sourceIds: [source.sourceId],
      query: 'twice',
    });
    const rows = await blocksOf(harness, source.sourceId);
    expect(found.map((block) => block.hash)).toEqual(
      found.map((block) => rows.find((row) => row._id === block._id)?.hash),
    );
    expect(found.every((block) => typeof block.hash === 'string' && block.hash !== '')).toBe(true);
  });

  it('searches each source on its own, so ten sources each answer their blocks', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sources: Id<'docSources'>[] = [];
    for (let index = 0; index < 10; index += 1) {
      const source = await sourceOf(harness);
      await split(harness, source, RUNBOOK);
      sources.push(source.sourceId);
    }
    const found = await harness.query(internal.docBlocks.searchBlocks, {
      userId: 'owner',
      sourceIds: sources,
      query: 'revops',
    });
    expect(found.map((block) => block.sourceId)).toEqual(sources);
    expect(found.every((block) => block.rank === 0 && block.index === 2)).toBe(true);
  });

  it('is cut to sixteen terms, as the backend reads no more', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await sourceOf(harness);
    await split(harness, source, RUNBOOK);
    const misses = Array.from({ length: 16 }, (_unused, index) => `zz${index}`);
    const search = async (query: string) =>
      await harness.query(internal.docBlocks.searchBlocks, {
        userId: 'owner',
        sourceIds: [source.sourceId],
        query,
      });
    expect(await search([...misses, 'revops'].join(' '))).toEqual([]);
    expect((await search([...misses.slice(1), 'revops'].join(' '))).map((b) => b.index)).toEqual([
      2,
    ]);
  });

  it('finds a Chinese word inside unspaced text through its bigrams', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await sourceOf(harness);
    await split(harness, source, '# 看板\n\n每个季度结束时请刷新管道看板然后在频道里发布结果');
    const found = await harness.query(internal.docBlocks.searchBlocks, {
      userId: 'owner',
      sourceIds: [source.sourceId],
      query: '管道看板',
    });
    expect(found.map((block) => block.text)).toEqual([
      '每个季度结束时请刷新管道看板然后在频道里发布结果',
    ]);
  });

  it("answers only the blocks of pages in the status asked for, by the index's own filter (15-A; K-1)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId, pageRef: 'current.md' }, RUNBOOK);
    await split(harness, { sourceId, runId, pageRef: 'old.md', status: 'superseded' }, RUNBOOK);
    const found = async (status?: PageStatus): Promise<string[]> =>
      [
        ...new Set(
          (
            await harness.query(internal.docBlocks.searchBlocks, {
              userId: 'owner',
              sourceIds: [sourceId],
              query: 'refresh',
              ...(status !== undefined ? { status } : {}),
            })
          ).map((block) => block.pageRef),
        ),
      ].sort();
    expect(await found('active')).toEqual(['current.md']);
    expect(await found('superseded')).toEqual(['old.md']);
    expect(await found()).toEqual(['current.md', 'old.md']);
  });

  it('refuses a search whose sources and blocks a source together pass what one read may hold (second pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sources: Id<'docSources'>[] = [];
    for (let index = 0; index < 9; index += 1) sources.push((await sourceOf(harness)).sourceId);
    await expect(
      harness.query(internal.docBlocks.searchBlocks, {
        userId: 'owner',
        sourceIds: sources,
        query: 'refresh',
        limit: 64,
      }),
    ).rejects.toThrow('at most 512 blocks');
    await expect(
      harness.query(internal.docBlocks.searchBlocks, {
        userId: 'owner',
        sourceIds: sources.slice(0, 8),
        query: 'refresh',
        limit: 64,
      }),
    ).resolves.toEqual([]);
  });

  it('refuses more sources or blocks a source than one search reads', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const source = await sourceOf(harness);
    await expect(
      harness.query(internal.docBlocks.searchBlocks, {
        userId: 'owner',
        sourceIds: Array.from({ length: 33 }, () => source.sourceId),
        query: 'refresh',
      }),
    ).rejects.toThrow('at most 32 sources');
    await expect(
      harness.query(internal.docBlocks.searchBlocks, {
        userId: 'owner',
        sourceIds: [source.sourceId],
        query: 'refresh',
        limit: 65,
      }),
    ).rejects.toThrow('1 to 64 blocks');
  });
});

describe('unchangedPage', (): void => {
  it('answers the stored page only under the hash it was stored with', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'hashed.md',
        title: 'Hashed',
        markdown: '# Hashed\n\n<credential: token, stored>',
        updatedAt: 1,
        contentHash: 'a'.repeat(32),
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'older.md',
        title: 'Older',
        markdown: '# Older',
        updatedAt: 1,
      });
    });
    // Re-pinned in the second pass: a page holding text is kept only once its blocks exist.
    await harness.mutation(internal.docBlocks.splitStoredPage, {
      sourceId,
      ref: 'hashed.md',
      generation: runId,
    });
    const ask = async (ref: string, contentHash: string) =>
      await harness.query(internal.docBlocks.unchangedPage, { sourceId, ref, contentHash });
    expect(await ask('hashed.md', 'a'.repeat(32))).toEqual({
      title: 'Hashed',
      markdown: '# Hashed\n\n<credential: token, stored>',
    });
    expect(await ask('hashed.md', 'b'.repeat(32))).toBeNull();
    expect(await ask('older.md', 'a'.repeat(32))).toBeNull();
    expect(await ask('missing.md', 'a'.repeat(32))).toBeNull();
  });
});

describe('unchangedPage and what the source said of the page (15-A)', (): void => {
  it("answers the status and the revision the page's source gave it, so the sync can tell a change with no edit", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbooks/refresh.md',
        title: 'Refresh',
        markdown: RUNBOOK,
        updatedAt: 1,
        contentHash: 'a'.repeat(32),
        status: 'archived',
        statusSource: 'source-native',
        nativeStatus: 'archived',
        sourceRevision: '12',
      });
    });
    await split(harness, { sourceId, runId, status: 'archived' }, RUNBOOK);
    expect(
      await harness.query(internal.docBlocks.unchangedPage, {
        sourceId,
        ref: 'runbooks/refresh.md',
        contentHash: 'a'.repeat(32),
      }),
    ).toEqual({
      title: 'Refresh',
      markdown: RUNBOOK,
      nativeStatus: 'archived',
      sourceRevision: '12',
    });
  });
});

describe('unchangedPage and a split that never landed (second pass)', (): void => {
  it('answers no page whose text holds blocks it has none of, so the sync stores and splits it again', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    // Re-taken in wave 16 (16-FD, W15-R25): a hash written with the page, before its split, is a
    // library as v0.19.0 left it, which is checked block for block until a 0.20.0 sync has seen
    // it; since then the split writes the hash.
    await v019Library(harness, sourceId);
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbooks/refresh.md',
        title: 'Refresh',
        markdown: RUNBOOK,
        updatedAt: 1,
        contentHash: 'a'.repeat(32),
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'headings.md',
        title: 'Headings',
        markdown: '# Only a heading',
        updatedAt: 1,
        contentHash: 'a'.repeat(32),
      });
    });
    const ask = async (ref: string) =>
      await harness.query(internal.docBlocks.unchangedPage, {
        sourceId,
        ref,
        contentHash: 'a'.repeat(32),
      });
    expect(await ask('runbooks/refresh.md')).toBeNull();
    // A page with no text under its headings has no block to miss.
    expect(await ask('headings.md')).toMatchObject({ title: 'Headings' });
    await split(harness, { sourceId, runId }, RUNBOOK);
    expect(await ask('runbooks/refresh.md')).toMatchObject({ title: 'Refresh' });
  });
});

describe('unchangedPage and the split a stored hash vouches for (W15-R25)', (): void => {
  /** A source with a sync running, which `upsertPage` writes for. */
  async function syncing(harness: TestConvex<typeof schema>) {
    const { sourceId, runId } = await sourceOf(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(runId, { state: 'running' });
      await ctx.db.patch(sourceId, { activeSyncId: runId });
    });
    return { sourceId, runId };
  }

  const store = async (
    harness: TestConvex<typeof schema>,
    page: { sourceId: Id<'docSources'>; runId: Id<'docSyncRuns'> },
    markdown: string,
    contentHash: string,
  ) =>
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId: page.sourceId,
      syncRunId: page.runId,
      ref: 'runbooks/refresh.md',
      title: 'Refresh',
      markdown,
      updatedAt: 1,
      contentHash,
    });

  it('keeps an unchanged page without splitting it again once its split has landed', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const page = await syncing(harness);
    const ask = async (contentHash: string) =>
      await harness.query(internal.docBlocks.unchangedPage, {
        sourceId: page.sourceId,
        ref: 'runbooks/refresh.md',
        contentHash,
      });
    await store(harness, page, RUNBOOK, 'a'.repeat(32));
    // Its split has not landed: the hash vouches for nothing yet, so the page is stored again.
    expect(await ask('a'.repeat(32))).toBeNull();
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    splits.count = 0;
    expect(await ask('a'.repeat(32))).toMatchObject({ title: 'Refresh', markdown: RUNBOOK });
    // The review's reader 1 (splittime.mts): every unchanged page was split again at every sync.
    expect(splits.count).toBe(0);
    // A changed page's new hash vouches for nothing until its own split lands.
    const edited = RUNBOOK.replace('Press refresh twice.', 'Press refresh three times.');
    await store(harness, page, edited, 'b'.repeat(32));
    expect(await ask('b'.repeat(32))).toBeNull();
    expect(await ask('a'.repeat(32))).toBeNull();
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    expect(await ask('b'.repeat(32))).toMatchObject({ markdown: edited });
  });

  it('stamps no hash from a split that reads a page stored again since it was scheduled', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const page = await syncing(harness);
    await store(harness, page, RUNBOOK, 'a'.repeat(32));
    const edited = RUNBOOK.replace('Press refresh twice.', 'Press refresh three times.');
    await store(harness, page, edited, 'b'.repeat(32));
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    const stored = await harness.run(async (ctx) => await ctx.db.query('docPages').unique());
    expect([stored?.markdown, stored?.contentHash]).toEqual([edited, 'b'.repeat(32)]);
  });
});

describe('unchangedPage and a re-split that never landed (W14-R23)', (): void => {
  it("answers no page whose stored blocks are an older version's, so the sync stores and splits it again", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    // Re-taken in wave 16 (16-FD, W15-R25), as the second pass's case above.
    await v019Library(harness, sourceId);
    // The page changed and was stored; its split failed, so its blocks are still the old text's.
    await split(harness, { sourceId, runId }, RUNBOOK);
    const edited = RUNBOOK.replace('Press refresh twice.', 'Press refresh three times.');
    const pageId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docPages', {
          sourceId,
          ref: 'runbooks/refresh.md',
          title: 'Refresh',
          markdown: edited,
          updatedAt: 1,
          contentHash: 'a'.repeat(32),
        }),
    );
    const ask = async () =>
      await harness.query(internal.docBlocks.unchangedPage, {
        sourceId,
        ref: 'runbooks/refresh.md',
        contentHash: 'a'.repeat(32),
      });
    expect(await ask()).toBeNull();
    // A page that lost a section keeps no stale block either.
    const shorter = edited.slice(0, edited.indexOf('# Posting'));
    await harness.run(async (ctx) => {
      await ctx.db.patch(pageId, { markdown: shorter });
    });
    expect(await ask()).toBeNull();
    await split(harness, { sourceId, runId }, shorter);
    expect(await ask()).toMatchObject({ title: 'Refresh', markdown: shorter });
  });

  it("answers no page whose blocks hold another status than its row's, so its next split restates them", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId }, RUNBOOK);
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbooks/refresh.md',
        title: 'Refresh',
        markdown: RUNBOOK,
        updatedAt: 1,
        contentHash: 'a'.repeat(32),
        status: 'archived',
        statusSource: 'source-native',
      });
    });
    const ask = async () =>
      await harness.query(internal.docBlocks.unchangedPage, {
        sourceId,
        ref: 'runbooks/refresh.md',
        contentHash: 'a'.repeat(32),
      });
    expect(await ask()).toBeNull();
    await split(harness, { sourceId, runId, status: 'archived' }, RUNBOOK);
    expect(await ask()).toMatchObject({ title: 'Refresh' });
  });
});

describe('prunePageBlocks', (): void => {
  it('deletes the blocks of a page that is gone, and leaves those of a page stored again', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await sourceOf(harness);
    await split(harness, { sourceId, runId, pageRef: 'gone.md' }, RUNBOOK);
    await split(harness, { sourceId, runId, pageRef: 'back.md' }, RUNBOOK);
    await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'back.md',
        title: 'Back',
        markdown: RUNBOOK,
        updatedAt: 1,
      });
    });
    await harness.mutation(internal.docBlocks.prunePageBlocks, { sourceId, pageRef: 'gone.md' });
    await harness.mutation(internal.docBlocks.prunePageBlocks, { sourceId, pageRef: 'back.md' });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await blocksOf(harness, sourceId, 'gone.md')).toEqual([]);
    expect(await blocksOf(harness, sourceId, 'back.md')).toHaveLength(3);
  });
});

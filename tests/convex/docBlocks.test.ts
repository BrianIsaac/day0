import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { replacePageBlocks } from '../../convex/docBlocks';
import { allConvexModules } from './all-modules';

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

/** Split `markdown` into the page's stored blocks, as an upsert does. */
async function split(
  harness: TestConvex<typeof schema>,
  page: { sourceId: Id<'docSources'>; runId: Id<'docSyncRuns'>; userId?: string; pageRef?: string },
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
    const { sourceId } = await sourceOf(harness);
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

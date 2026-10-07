import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  MAX_BLOCKS_PER_PAGE,
  SEARCH_SCAN_LIMIT,
  blockSearchQuery,
  splitPage,
  type DocBlock,
} from '../src/docs/blocks';

/*
 * The block store behind the documentation search (wave 14, 14-I; the wave file's section 6.1).
 * Real mode only, as stored pages are (R3): mock mode and the frozen evaluation read the whole
 * mirror and never these rows.
 *
 * Writers: `replacePageBlocks`, called by `docSources.upsertPage` in the page's own transaction
 * (so a page and its blocks never disagree) and by the `docs-backfill-blocks` pass;
 * `prunePageBlocks`, scheduled by `docSources.prunePages` for a page a finish removed; and
 * `docSources.deleteSourceRows` for a removed source. Readers: `searchBlocks` (14-R's selection
 * calls it from `docSelection`) and `unchangedPage` (the sync's skip of an unchanged page).
 * Nothing here is public, so no caller reaches it without a guarded public function first.
 */

/** The most blocks one search answers for one source; at most the backend's scan limit. */
export const SEARCH_LIMIT_PER_SOURCE = 64;

/** The most sources one call searches; each is its own query (two equalities on `sourceId` are an AND). */
export const SEARCH_SOURCES_LIMIT = 32;

/** One bounded page of a pruned page's blocks: under a mutation's read and write limits. */
const PRUNE_READ = { numItems: 200, maximumBytesRead: 4 * 1024 * 1024 } as const;

/** A stored page's identity and Markdown, as the replace reads it. */
export interface PageToSplit {
  /** The source owner's key (`docSources.userId`). */
  readonly userId: string;
  readonly sourceId: Id<'docSources'>;
  readonly pageRef: string;
  /** The run writing this version of the page. */
  readonly generation: Id<'docSyncRuns'>;
  /** The page as stored: already redacted. */
  readonly markdown: string;
}

/** A block as `searchBlocks` answers it: enough to cite and to re-score, not the index's text. */
export interface FoundBlock {
  readonly _id: Id<'docBlocks'>;
  readonly sourceId: Id<'docSources'>;
  readonly pageRef: string;
  readonly index: number;
  readonly headingPath: string[];
  readonly text: string;
  readonly kind: Doc<'docBlocks'>['kind'];
  readonly chars: number;
  /** Its place in its own source's answer, from 0: the backend's relevance order. */
  readonly rank: number;
}

/** Whether a stored block row already holds a split block, field for field. */
function sameBlock(row: Doc<'docBlocks'>, block: DocBlock, userId: string): boolean {
  return (
    row.userId === userId &&
    row.hash === block.hash &&
    row.searchText === block.searchText &&
    row.chars === block.chars
  );
}

/** The row a block is stored as. */
function blockRow(
  page: PageToSplit,
  block: DocBlock,
): Omit<Doc<'docBlocks'>, '_id' | '_creationTime'> {
  return {
    userId: page.userId,
    sourceId: page.sourceId,
    pageRef: page.pageRef,
    generation: page.generation,
    index: block.index,
    headingPath: [...block.headingPath],
    text: block.text,
    searchText: block.searchText,
    kind: block.kind,
    hash: block.hash,
    chars: block.chars,
  };
}

/**
 * Make a page's stored blocks the blocks of its Markdown, in the caller's transaction.
 *
 * Block by block in document order: a row that already holds the same block is left as it is
 * (its id, so a citation of it, and the run that wrote it stay), a row that differs is
 * rewritten, a missing one inserted, and the rows past the page's new end deleted. So running
 * it twice over the same Markdown changes nothing, which the backfill relies on.
 *
 * @param ctx - The writing mutation's context.
 * @param page - The page and the run writing it.
 * @returns How many block rows it inserted, rewrote or deleted.
 */
export async function replacePageBlocks(ctx: MutationCtx, page: PageToSplit): Promise<number> {
  const blocks = splitPage(page.markdown);
  const stored = await ctx.db
    .query('docBlocks')
    .withIndex('by_source_page', (q) =>
      q.eq('sourceId', page.sourceId).eq('pageRef', page.pageRef).lt('index', blocks.length),
    )
    .take(MAX_BLOCKS_PER_PAGE);
  const byIndex = new Map(stored.map((row) => [row.index, row]));
  let changed = 0;
  for (const block of blocks) {
    const row = byIndex.get(block.index);
    if (row !== undefined && sameBlock(row, block, page.userId)) continue;
    if (row === undefined) await ctx.db.insert('docBlocks', blockRow(page, block));
    else await ctx.db.replace(row._id, blockRow(page, block));
    changed += 1;
  }
  return changed + (await deleteBlocksFrom(ctx, page.sourceId, page.pageRef, blocks.length));
}

/** Delete a page's blocks from `index` on, in rounds a page never outgrows. */
async function deleteBlocksFrom(
  ctx: MutationCtx,
  sourceId: Id<'docSources'>,
  pageRef: string,
  index: number,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const tail = await ctx.db
      .query('docBlocks')
      .withIndex('by_source_page', (q) =>
        q.eq('sourceId', sourceId).eq('pageRef', pageRef).gte('index', index),
      )
      .take(MAX_BLOCKS_PER_PAGE);
    for (const row of tail) await ctx.db.delete(row._id);
    deleted += tail.length;
    if (tail.length < MAX_BLOCKS_PER_PAGE) return deleted;
  }
}

/**
 * Delete one bounded page of the blocks of a page a finishing sync removed, and schedule the
 * next. Internal; scheduled by `docSources.prunePages`, so the finish's own page stays small
 * whatever a page's block count. A page stored again under the same ref before this runs owns
 * its blocks (its upsert replaced them), so they are left.
 *
 * @returns How many blocks this page deleted.
 */
export const prunePageBlocks = internalMutation({
  args: { sourceId: v.id('docSources'), pageRef: v.string() },
  handler: async (ctx, args): Promise<number> => {
    const back = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', args.sourceId).eq('ref', args.pageRef))
      .unique();
    if (back !== null) return 0;
    const page = await ctx.db
      .query('docBlocks')
      .withIndex('by_source_page', (q) =>
        q.eq('sourceId', args.sourceId).eq('pageRef', args.pageRef),
      )
      .paginate({ ...PRUNE_READ, cursor: null });
    for (const row of page.page) await ctx.db.delete(row._id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.docBlocks.prunePageBlocks, args);
    return page.page.length;
  },
});

/**
 * The stored page under a ref whose hash is the one given: the sync keeps it as stored, with no
 * redaction and no split (P8-10). Internal; reads one page, writes nothing.
 *
 * @returns The stored title, address and (redacted) Markdown, or null when the page is not
 *   stored, was stored without a hash, or has changed.
 */
export const unchangedPage = internalQuery({
  args: { sourceId: v.id('docSources'), ref: v.string(), contentHash: v.string() },
  handler: async (ctx, args): Promise<{ title: string; url?: string; markdown: string } | null> => {
    const page = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', args.sourceId).eq('ref', args.ref))
      .unique();
    if (page === null || page.contentHash !== args.contentHash) return null;
    return {
      title: page.title,
      ...(page.url !== undefined ? { url: page.url } : {}),
      markdown: page.markdown,
    };
  },
});

/**
 * Search an owner's blocks in the given sources. Internal: 14-R's `docSelection` is the public
 * reader, guarded there.
 *
 * The query is cut to the sixteen terms the backend reads (`blockSearchQuery`; it drops later
 * ones without a word), so a caller orders its terms first. Each source is its own query,
 * filtered by owner and that source: two filter expressions, inside the backend's eight, since
 * two equalities on `sourceId` would be an AND. Each answers at most `limit` blocks in the
 * backend's relevance order, within its 1,024-result scan.
 *
 * @returns Every source's blocks, source by source in the order given, each with its rank.
 * @throws Error past `SEARCH_SOURCES_LIMIT` sources or `SEARCH_LIMIT_PER_SOURCE` blocks.
 */
export const searchBlocks = internalQuery({
  args: {
    userId: v.string(),
    sourceIds: v.array(v.id('docSources')),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<FoundBlock[]> => {
    const limit = args.limit ?? 12;
    if (args.sourceIds.length > SEARCH_SOURCES_LIMIT) {
      throw new Error(`A block search reads at most ${SEARCH_SOURCES_LIMIT} sources.`);
    }
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > Math.min(SEARCH_LIMIT_PER_SOURCE, SEARCH_SCAN_LIMIT)
    ) {
      throw new Error(`A block search answers 1 to ${SEARCH_LIMIT_PER_SOURCE} blocks a source.`);
    }
    const query = blockSearchQuery(args.query);
    if (query === '') return [];
    const perSource = await Promise.all(
      [...new Set(args.sourceIds)].map(
        async (sourceId) =>
          await ctx.db
            .query('docBlocks')
            .withSearchIndex('by_text', (q) =>
              q.search('searchText', query).eq('userId', args.userId).eq('sourceId', sourceId),
            )
            .take(limit),
      ),
    );
    return perSource.flatMap((rows) =>
      rows.map(
        (row, rank): FoundBlock => ({
          _id: row._id,
          sourceId: row.sourceId,
          pageRef: row.pageRef,
          index: row.index,
          headingPath: row.headingPath,
          text: row.text,
          kind: row.kind,
          chars: row.chars,
          rank,
        }),
      ),
    );
  },
});

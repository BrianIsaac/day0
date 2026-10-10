import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  MAX_BLOCKS_PER_PAGE,
  SEARCH_SCAN_LIMIT,
  blockSearchQuery,
  splitPage,
  type DocBlock,
} from '../src/docs/blocks';
import { PAGE_STATUSES, pageStatusOf, type PageStatus } from '../src/docs/authority';

/*
 * The block store behind the documentation search (wave 14, 14-I; the wave file's section 6.1).
 * Real mode only, as stored pages are (R3): mock mode and the frozen evaluation read the whole
 * mirror and never these rows.
 *
 * Writers: `replacePageBlocks`, through `splitStoredPage`, which `docSources.upsertPage`
 * schedules for each page it writes (it splits the page as stored when it runs, so it converges
 * on the newest write), and directly in the `docs-backfill-blocks` pass;
 * `copyPageStatusToBlocks`, for a page whose status changed and whose text did not (wave 15,
 * 15-A: every block carries its page's status, which the search filters on); `prunePageBlocks`, scheduled by `docSources.prunePages` for a page a finish removed; and
 * `docSources.deleteSourceRows` for a removed source. Readers: `searchBlocks` (14-R's selection
 * calls it from `docSelection`) and `unchangedPage` (the sync's skip of an unchanged page).
 * Nothing here is public, so no caller reaches it without a guarded public function first.
 */

/** The most blocks one search answers for one source; at most the backend's scan limit. */
export const SEARCH_LIMIT_PER_SOURCE = 64;

/** The most sources one call searches; each is its own query (two equalities on `sourceId` are an AND). */
export const SEARCH_SOURCES_LIMIT = 32;

/**
 * The most blocks one search call reads across its sources: a CJK block's text and search text
 * can reach about 16 KB, so 512 stays well inside a query's 16 MiB read.
 */
export const SEARCH_BLOCKS_LIMIT = 512;

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
  /** The page's status (`pageStatusOf`), which every block of it carries; absent reads as active. */
  readonly status?: PageStatus;
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
  /** The row's hash, which a plan's cite keeps so its check needs no second read (14-R). */
  readonly hash: string;
  /** Its place in its own source's answer, from 0: the backend's relevance order. */
  readonly rank: number;
}

/**
 * Whether a stored block row already holds a split block, field for field. Its status is not part
 * of the block: a kept row whose status differs from its page's is patched, never rewritten.
 */
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
    status: pageStatusOf(page),
  };
}

/**
 * Make a page's stored blocks the blocks of its Markdown, in the caller's transaction.
 *
 * A row that already holds the same block keeps it wherever the block now sits on the page (its
 * id, so a citation of it, and the run that wrote it stay; only its place is moved), so an edit
 * above a cited section leaves the cite standing (W14-R2). A block no row holds takes the row
 * left at its place, or any row left over, or a new one; the rows left after that are deleted.
 * Every row carries the page's status (wave 15): a kept row whose status differs is patched.
 * So running it twice over the same Markdown and status changes nothing, which the backfill
 * relies on.
 *
 * @param ctx - The writing mutation's context.
 * @param page - The page, its status and the run writing it.
 * @returns How many block rows it inserted, rewrote, moved, restated or deleted.
 */
export async function replacePageBlocks(ctx: MutationCtx, page: PageToSplit): Promise<number> {
  const blocks = splitPage(page.markdown);
  const stored = await ctx.db
    .query('docBlocks')
    .withIndex('by_source_page', (q) => q.eq('sourceId', page.sourceId).eq('pageRef', page.pageRef))
    .take(MAX_BLOCKS_PER_PAGE);
  const { kept, rewritten, left } = matchStoredBlocks(stored, blocks, page.userId);
  const status = pageStatusOf(page);
  let changed = 0;
  for (const [index, row] of kept) {
    if (row.index === index && row.status === status) continue;
    await ctx.db.patch(row._id, { index, status });
    changed += 1;
  }
  for (const { block, row } of rewritten) {
    if (row === undefined) await ctx.db.insert('docBlocks', blockRow(page, block));
    else await ctx.db.replace(row._id, blockRow(page, block));
    changed += 1;
  }
  for (const row of left) await ctx.db.delete(row._id);
  // A page stored with more rows than one read takes (none since the split's bound) loses the rest.
  return (
    changed +
    left.length +
    (await deleteBlocksFrom(ctx, page.sourceId, page.pageRef, blocks.length))
  );
}

/** How a page's stored rows meet its blocks: the rows kept as they are, the blocks to write, the rows left. */
interface StoredBlockMatch {
  /** Each block's index whose row already holds it. */
  readonly kept: ReadonlyMap<number, Doc<'docBlocks'>>;
  /** Each block no row holds, with the row it takes (none: a new row). */
  readonly rewritten: ReadonlyArray<{ block: DocBlock; row: Doc<'docBlocks'> | undefined }>;
  readonly left: readonly Doc<'docBlocks'>[];
}

/**
 * Match a page's stored rows to its blocks by content first, in document order (two equal
 * blocks take two rows in order), then the rest by place.
 */
function matchStoredBlocks(
  stored: readonly Doc<'docBlocks'>[],
  blocks: readonly DocBlock[],
  userId: string,
): StoredBlockMatch {
  const byHash = new Map<string, Doc<'docBlocks'>[]>();
  for (const row of [...stored].sort((a, b) => a.index - b.index)) {
    byHash.set(row.hash, [...(byHash.get(row.hash) ?? []), row]);
  }
  const kept = new Map<number, Doc<'docBlocks'>>();
  const unmatched: DocBlock[] = [];
  for (const block of blocks) {
    const candidates = byHash.get(block.hash) ?? [];
    const at = candidates.findIndex((row) => sameBlock(row, block, userId));
    if (at < 0) {
      unmatched.push(block);
      continue;
    }
    kept.set(block.index, candidates[at]);
    candidates.splice(at, 1);
  }
  const taken = new Set([...kept.values()].map((row) => row._id));
  const free = new Map(
    stored.filter((row) => !taken.has(row._id)).map((row) => [row.index, row] as const),
  );
  const rewritten = unmatched.map((block) => {
    const row = free.get(block.index) ?? free.values().next().value;
    if (row !== undefined) free.delete(row.index);
    return { block, row };
  });
  return { kept, rewritten, left: [...free.values()] };
}

/**
 * Copy a page's status onto its stored blocks with no re-split, in the caller's transaction: the
 * write for a page whose status changed and whose text did not (a status rides beside the page's
 * hash, so an unchanged page is never split again). Only a row whose status differs is written;
 * at most `MAX_BLOCKS_PER_PAGE` rows, a page's bound.
 *
 * @param ctx - The writing mutation's context.
 * @param page - The page and the status it now has.
 * @returns How many block rows it patched.
 */
export async function copyPageStatusToBlocks(
  ctx: MutationCtx,
  page: {
    readonly sourceId: Id<'docSources'>;
    readonly pageRef: string;
    readonly status: PageStatus;
  },
): Promise<number> {
  const stored = await ctx.db
    .query('docBlocks')
    .withIndex('by_source_page', (q) => q.eq('sourceId', page.sourceId).eq('pageRef', page.pageRef))
    .take(MAX_BLOCKS_PER_PAGE);
  let patched = 0;
  for (const row of stored) {
    if (row.status === page.status) continue;
    await ctx.db.patch(row._id, { status: page.status });
    patched += 1;
  }
  return patched;
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
 * Split a stored page into its blocks, as it is stored when this runs. Internal; scheduled by
 * `docSources.upsertPage` for each page it writes, so the page's own transaction stays one
 * page's size. A page gone by then leaves its blocks to `prunePageBlocks`. Every block takes the
 * status the page's row holds then.
 *
 * @returns How many block rows it inserted, rewrote, restated or deleted.
 */
export const splitStoredPage = internalMutation({
  args: { sourceId: v.id('docSources'), ref: v.string(), generation: v.id('docSyncRuns') },
  handler: async (ctx, args): Promise<number> => {
    const [source, page] = await Promise.all([
      ctx.db.get(args.sourceId),
      ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) => q.eq('sourceId', args.sourceId).eq('ref', args.ref))
        .unique(),
    ]);
    if (source === null || page === null) return 0;
    return await replacePageBlocks(ctx, {
      userId: source.userId,
      sourceId: args.sourceId,
      pageRef: args.ref,
      generation: args.generation,
      markdown: page.markdown,
      status: pageStatusOf(page),
    });
  },
});

/** A page kept as stored: what the sync mirrors of it, and what its source last said of it. */
export interface UnchangedPage {
  readonly title: string;
  readonly url?: string;
  readonly markdown: string;
  readonly nativeStatus?: PageStatus;
  readonly sourceRevision?: string;
}

/**
 * Whether a page's stored blocks are the blocks of its stored text, each under the page's status:
 * as many, in document order, hash for hash. A page whose split never landed holds none, and one
 * whose re-split failed still holds the blocks of its older text (W14-R23), which would stay
 * current and citable.
 */
async function blocksAreThePages(
  ctx: QueryCtx,
  page: Pick<Doc<'docPages'>, 'sourceId' | 'ref' | 'markdown' | 'status'>,
): Promise<boolean> {
  const blocks = splitPage(page.markdown);
  const stored = await ctx.db
    .query('docBlocks')
    .withIndex('by_source_page', (q) => q.eq('sourceId', page.sourceId).eq('pageRef', page.ref))
    .take(MAX_BLOCKS_PER_PAGE + 1);
  if (stored.length !== blocks.length) return false;
  const status = pageStatusOf(page);
  return blocks.every(
    (block, index) => stored[index].hash === block.hash && stored[index].status === status,
  );
}

/**
 * The stored page under a ref whose hash is the one given: the sync keeps it as stored, with no
 * redaction and no split (P8-10). Internal; reads one page and its blocks, writes nothing.
 *
 * @returns The stored title, address and (redacted) Markdown, with what the page's source said
 *   of it when it was last read (its native status and revision, which ride beside the hash:
 *   15-A), or null when the page is not stored, was stored without a hash, has changed, or its
 *   stored blocks are not the blocks of its text under its status (its split failed, or never
 *   landed), so the sync stores it again and its split is scheduled again.
 */
export const unchangedPage = internalQuery({
  args: { sourceId: v.id('docSources'), ref: v.string(), contentHash: v.string() },
  handler: async (ctx, args): Promise<UnchangedPage | null> => {
    const page = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', args.sourceId).eq('ref', args.ref))
      .unique();
    if (page === null || page.contentHash !== args.contentHash) return null;
    // A page whose split did not land is not kept: its next store schedules the split again.
    if (!(await blocksAreThePages(ctx, page))) return null;
    return {
      title: page.title,
      ...(page.url !== undefined ? { url: page.url } : {}),
      markdown: page.markdown,
      ...(page.nativeStatus !== undefined ? { nativeStatus: page.nativeStatus } : {}),
      ...(page.sourceRevision !== undefined ? { sourceRevision: page.sourceRevision } : {}),
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
 * backend's relevance order, within its 1,024-result scan. With `status`, only the blocks of
 * pages in that status are answered, by the index's own filter (a third expression; K-1): the
 * selection asks for `active`, so a superseded page's blocks never take a place in an answer.
 *
 * @returns Every source's blocks, source by source in the order given, each with its rank.
 * @throws Error past `SEARCH_SOURCES_LIMIT` sources, `SEARCH_LIMIT_PER_SOURCE` blocks a source or
 *   `SEARCH_BLOCKS_LIMIT` blocks in all.
 */
export const searchBlocks = internalQuery({
  args: {
    userId: v.string(),
    sourceIds: v.array(v.id('docSources')),
    query: v.string(),
    limit: v.optional(v.number()),
    status: v.optional(v.union(...PAGE_STATUSES.map((status) => v.literal(status)))),
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
    const sourceIds = [...new Set(args.sourceIds)];
    if (sourceIds.length * limit > SEARCH_BLOCKS_LIMIT) {
      throw new Error(
        `A block search reads at most ${SEARCH_BLOCKS_LIMIT} blocks: fewer sources, or fewer a source.`,
      );
    }
    const query = blockSearchQuery(args.query);
    if (query === '') return [];
    const perSource = await Promise.all(
      sourceIds.map(
        async (sourceId) =>
          await ctx.db
            .query('docBlocks')
            .withSearchIndex('by_text', (q) => {
              const owned = q
                .search('searchText', query)
                .eq('userId', args.userId)
                .eq('sourceId', sourceId);
              return args.status === undefined ? owned : owned.eq('status', args.status);
            })
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
          hash: row.hash,
          rank,
        }),
      ),
    );
  },
});

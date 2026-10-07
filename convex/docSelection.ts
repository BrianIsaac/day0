import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { SEARCH_BLOCKS_LIMIT, SEARCH_SOURCES_LIMIT, type FoundBlock } from './docBlocks';
import { MAX_BLOCKS_PER_PAGE } from '../src/docs/blocks';
import {
  DOCUMENTATION_SITES,
  alwaysIncludedPages,
  scoutQueries,
  selectDocumentation,
  type SelectableBlock,
  type SelectablePage,
  type SelectedDocumentation,
  type SelectionRequest,
} from '../src/docs/select';

/*
 * The documentation selection's reads (wave 14, 14-R; the wave file's section 6.2). Real mode
 * only (R3): `mock.snapshotInternal` calls `selectedDocumentation` when a real-mode caller passes
 * a selection, and mock mode and the frozen evaluation read the whole mirror.
 *
 * Nothing here is public. The pages are the employee's readable mirror (`readableDocs`: its
 * inherited sources, wave 9's visibility rule), and the search reads only those pages' sources,
 * under the owner's key, one query a source (`docBlocks.searchBlocks`).
 */

/** The most blocks one scout query asks of one source: the best of each field is enough to rank. */
const SCOUT_LIMIT_PER_SOURCE = 12;

/** The validator of a `SelectionRequest`, as `snapshotInternal` takes it. */
export const selectionRequestValidator = v.object({
  site: v.union(...DOCUMENTATION_SITES.map((site) => v.literal(site))),
  title: v.string(),
  summary: v.string(),
  target: v.optional(v.object({ slug: v.string(), displayName: v.string() })),
  shape: v.optional(v.object({ surfaceClass: v.string(), operation: v.string() })),
  roleFunction: v.string(),
  requester: v.optional(v.string()),
  writtenBrowserSurfaces: v.array(v.string()),
});

/** A mirrored page's key: its source and ref, or the office slug for a page with no source. */
function pageKeyOf(sourceId: Id<'docSources'> | undefined, ref: string): string {
  return sourceId === undefined ? `office:${ref}` : `${sourceId}:${ref}`;
}

/** The readable mirror as the selection reads it, with each source's label for the cite lines. */
async function selectablePages(
  ctx: QueryCtx,
  docs: readonly Doc<'mockDocs'>[],
): Promise<SelectablePage[]> {
  const sourceIds = [...new Set(docs.flatMap((doc) => (doc.sourceId ? [doc.sourceId] : [])))];
  const labels = new Map(
    await Promise.all(
      sourceIds.map(
        async (id): Promise<[Id<'docSources'>, string]> => [
          id,
          (await ctx.db.get(id))?.label ?? '',
        ],
      ),
    ),
  );
  return docs.map((doc): SelectablePage => {
    const ref =
      doc.sourceId !== undefined && doc.sourceRef !== undefined ? doc.sourceRef : doc.slug;
    return {
      key: pageKeyOf(doc.sourceId, ref),
      slug: doc.slug,
      title: doc.title,
      category: doc.category,
      body: doc.body,
      citeSource: doc.sourceId === undefined ? 'office' : labels.get(doc.sourceId) || 'source',
      citePage: ref,
    };
  });
}

/** Whether a page is still stored: a block can outlive its page by one scheduler tick. */
async function pageStored(
  ctx: QueryCtx,
  sourceId: Id<'docSources'>,
  pageRef: string,
): Promise<boolean> {
  const page = await ctx.db
    .query('docPages')
    .withIndex('by_source_ref', (q) => q.eq('sourceId', sourceId).eq('ref', pageRef))
    .unique();
  return page !== null;
}

/** A found or stored block as the selection reads it. */
function selectableBlock(
  block: Pick<FoundBlock, '_id' | 'sourceId' | 'pageRef' | 'index' | 'headingPath' | 'text'>,
): SelectableBlock {
  return {
    id: block._id,
    pageKey: pageKeyOf(block.sourceId, block.pageRef),
    index: block.index,
    headingPath: block.headingPath,
    text: block.text,
  };
}

/**
 * The blocks the scout finds: one search a query string, each over the employee's sources in
 * runs of at most `SEARCH_SOURCES_LIMIT` (each source its own query inside `searchBlocks`),
 * dropping a block whose page is no longer stored.
 */
async function scoutedBlocks(
  ctx: QueryCtx,
  userId: string,
  sourceIds: readonly Id<'docSources'>[],
  queries: readonly string[],
): Promise<SelectableBlock[]> {
  const runs: Id<'docSources'>[][] = [];
  for (let start = 0; start < sourceIds.length; start += SEARCH_SOURCES_LIMIT) {
    runs.push(sourceIds.slice(start, start + SEARCH_SOURCES_LIMIT));
  }
  const found = (
    await Promise.all(
      queries.flatMap((query) =>
        runs.map(
          async (run) =>
            await ctx.runQuery(internal.docBlocks.searchBlocks, {
              userId,
              sourceIds: run,
              query,
              limit: Math.max(
                1,
                Math.min(SCOUT_LIMIT_PER_SOURCE, Math.floor(SEARCH_BLOCKS_LIMIT / run.length)),
              ),
            }),
        ),
      ),
    )
  ).flat();
  const unique = new Map(found.map((block) => [block._id, block]));
  const pages = new Map<string, Promise<boolean>>();
  const stored = (block: FoundBlock): Promise<boolean> => {
    const key = pageKeyOf(block.sourceId, block.pageRef);
    if (!pages.has(key)) pages.set(key, pageStored(ctx, block.sourceId, block.pageRef));
    return pages.get(key)!;
  };
  const kept = await Promise.all(
    [...unique.values()].map(async (block) => ((await stored(block)) ? [block] : [])),
  );
  return kept.flat().map(selectableBlock);
}

/** The stored blocks of the pages always included, in document order; none for a page not stored. */
async function storedPageBlocks(
  ctx: QueryCtx,
  docs: readonly Doc<'mockDocs'>[],
  keys: ReadonlySet<string>,
): Promise<Map<string, SelectableBlock[]>> {
  const entries = await Promise.all(
    docs.flatMap((doc) => {
      const { sourceId, sourceRef } = doc;
      if (sourceId === undefined || sourceRef === undefined) return [];
      const key = pageKeyOf(sourceId, sourceRef);
      if (!keys.has(key)) return [];
      return [
        (async (): Promise<[string, SelectableBlock[]]> => {
          if (!(await pageStored(ctx, sourceId, sourceRef))) return [key, []];
          const rows = await ctx.db
            .query('docBlocks')
            .withIndex('by_source_page', (q) => q.eq('sourceId', sourceId).eq('pageRef', sourceRef))
            .take(MAX_BLOCKS_PER_PAGE);
          return [key, rows.map(selectableBlock)];
        })(),
      ];
    }),
  );
  return new Map(entries);
}

/**
 * Select the documentation one real-mode prompt carries, inside the caller's query: the
 * employee's readable pages, the blocks the search scouts from their sources under the owner's
 * key, and the stored blocks of the pages always included (`selectDocumentation`).
 *
 * @param ctx - The snapshot's query context.
 * @param agent - The employee; with no owner key nothing is searched.
 * @param docs - The pages the employee reads (`readableDocs`), in the mirror's order.
 * @param request - What the selection is for.
 */
export async function selectedDocumentation(
  ctx: QueryCtx,
  agent: Pick<Doc<'agents'>, 'userId'> | null,
  docs: readonly Doc<'mockDocs'>[],
  request: SelectionRequest,
): Promise<SelectedDocumentation> {
  const pages = await selectablePages(ctx, docs);
  const sourceIds = [...new Set(docs.flatMap((doc) => (doc.sourceId ? [doc.sourceId] : [])))];
  const userId = agent?.userId;
  const scouted =
    userId === undefined || sourceIds.length === 0
      ? []
      : await scoutedBlocks(ctx, userId, sourceIds, scoutQueries(request, pages));
  const pageBlocks = await storedPageBlocks(
    ctx,
    docs,
    new Set(alwaysIncludedPages(pages, request)),
  );
  return selectDocumentation({ request, pages, scouted, pageBlocks });
}

/**
 * The cited blocks of a plan that no longer stand: a block row deleted, or its page gone.
 * Internal; the closing phase reads it before it authors (wave 14, 14-R).
 *
 * @returns The ids, of those given, that are gone; an id that names no block row is gone.
 * @throws Error past `SEARCH_BLOCKS_LIMIT` ids.
 */
export const missingCitedBlocks = internalQuery({
  args: { blockIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const ids = [...new Set(args.blockIds)];
    if (ids.length > SEARCH_BLOCKS_LIMIT) {
      throw new Error(`A plan's cites are checked ${SEARCH_BLOCKS_LIMIT} blocks at most.`);
    }
    const standing = await Promise.all(
      ids.map(async (id) => {
        const blockId = ctx.db.normalizeId('docBlocks', id);
        const block = blockId === null ? null : await ctx.db.get(blockId);
        return block !== null && (await pageStored(ctx, block.sourceId, block.pageRef));
      }),
    );
    return ids.filter((_id, index) => !standing[index]);
  },
});

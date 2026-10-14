import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  type DatabaseReader,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  SEARCH_BLOCKS_LIMIT,
  SEARCH_SOURCES_LIMIT,
  notCurrentRefs,
  storedPageStatus,
  type FoundBlock,
} from './docBlocks';
import {
  citeConflictOf,
  planSelectionOf,
  standingConflictsOn,
  type CarriedPage,
} from './docConflicts';
import { MAX_BLOCKS_PER_PAGE } from '../src/docs/blocks';
import { agentReadsSource } from '../src/docs/agent-sources';
import {
  SOURCE_AUTHORITIES,
  pageStatusOf,
  sourceAuthorityOf,
  type PageStatus,
} from '../src/docs/authority';
import type { CiteConflict } from '../src/work/types';
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
 *
 * Only current pages are read, in all three places (wave 15, 15-A; A5, A20, A-1): the scout by
 * the index's `status` filter, and the always-included set and the whole mirror through
 * `currentDocs`, which drops a mirrored page that is superseded, archived or a draft. The
 * mirror itself keeps every page: the employee's Docs tab still shows them.
 */

/**
 * The mirrored pages that are current, in the order given: every office page with no source, and
 * each page of a source whose status is `active` (A20: a draft is left out of what an employee
 * works from, as a superseded or archived page is). What a run's snapshot reads, with a
 * selection or whole.
 *
 * @param db - Any database reader.
 * @param docs - The employee's readable mirror.
 */
export async function currentDocs(
  db: DatabaseReader,
  docs: readonly Doc<'mockDocs'>[],
): Promise<Doc<'mockDocs'>[]> {
  // One range of small rows a source says which of its pages are not current (W15-R7): a query
  // a mirrored page passed Convex's 4,096 index ranges at about 4,090 pages.
  const sourceIds = [...new Set(docs.flatMap((doc) => (doc.sourceId ? [doc.sourceId] : [])))];
  const notCurrent = new Map(
    await Promise.all(
      sourceIds.map(async (sourceId) => [sourceId, await notCurrentRefs(db, sourceId)] as const),
    ),
  );
  const current = await Promise.all(
    docs.map(async (doc) => {
      if (doc.sourceId === undefined || doc.sourceRef === undefined) return true;
      const left = notCurrent.get(doc.sourceId);
      // A source with more not-current pages than one read takes is read a page at a time.
      return left === undefined
        ? (await storedPageStatus(db, doc.sourceId, doc.sourceRef)) === 'active'
        : !left.has(doc.sourceRef);
    }),
  );
  return docs.filter((_doc, index) => current[index]);
}

/*
 * The selection's own reads.
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

/**
 * Each source's name in a cite line: its label, and for two readable sources of one label the
 * label with its place among them, oldest first ("Handbook (1)", "Handbook (2)"), so no two
 * sources print one cite and a plan's cite names one page (W14-R27).
 */
function citeNames(sources: readonly Doc<'docSources'>[]): Map<Id<'docSources'>, string> {
  const byLabel = new Map<string, Doc<'docSources'>[]>();
  for (const source of sources) {
    const label = source.label || 'source';
    byLabel.set(label, [...(byLabel.get(label) ?? []), source]);
  }
  const names = new Map<Id<'docSources'>, string>();
  for (const [label, sharing] of byLabel) {
    const ordered = [...sharing].sort((left, right) => left._creationTime - right._creationTime);
    ordered.forEach((source, index) => {
      names.set(source._id, ordered.length === 1 ? label : `${label} (${index + 1})`);
    });
  }
  return names;
}

/** The sources of the pages given, each read once. */
async function sourcesOf(
  ctx: QueryCtx,
  docs: readonly Doc<'mockDocs'>[],
): Promise<Doc<'docSources'>[]> {
  const sourceIds = [...new Set(docs.flatMap((doc) => (doc.sourceId ? [doc.sourceId] : [])))];
  const rows = await Promise.all(sourceIds.map(async (id) => await ctx.db.get(id)));
  return rows.filter((row): row is Doc<'docSources'> => row !== null);
}

/** The readable mirror as the selection reads it, with each source's name for the cite lines. */
function selectablePages(
  docs: readonly Doc<'mockDocs'>[],
  sources: readonly Doc<'docSources'>[],
): SelectablePage[] {
  const names = citeNames(sources);
  const byId = new Map(sources.map((source) => [source._id, source]));
  return docs.map((doc): SelectablePage => {
    const ref =
      doc.sourceId !== undefined && doc.sourceRef !== undefined ? doc.sourceRef : doc.slug;
    const source = doc.sourceId === undefined ? undefined : byId.get(doc.sourceId);
    return {
      key: pageKeyOf(doc.sourceId, ref),
      slug: doc.slug,
      title: doc.title,
      category: doc.category,
      body: doc.body,
      citeSource: doc.sourceId === undefined ? 'office' : (names.get(doc.sourceId) ?? 'source'),
      citePage: ref,
      ...(doc.sourceId !== undefined ? { sourceId: doc.sourceId } : {}),
      ...(source !== undefined ? { authority: sourceAuthorityOf(source) } : {}),
      updatedAt: doc.updatedAt,
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

/** A found or stored block as the selection reads it, with the hash its cite keeps. */
function selectableBlock(
  block: Pick<
    FoundBlock,
    '_id' | 'sourceId' | 'pageRef' | 'index' | 'headingPath' | 'text' | 'hash'
  >,
): SelectableBlock {
  return {
    id: block._id,
    pageKey: pageKeyOf(block.sourceId, block.pageRef),
    index: block.index,
    headingPath: block.headingPath,
    text: block.text,
    hash: block.hash,
  };
}

/**
 * The sources one selection scouts, the most trusted first (official over team over personal),
 * each trust in the order given: at most as many as leave every search one block a source
 * inside `SEARCH_BLOCKS_LIMIT`, so "at most 512 blocks a selection" holds however many sources
 * an owner links (W14-R28). Past that many, the least trusted are not scouted; their pages are
 * still carried when they are always included.
 */
function scoutedSources(
  sources: readonly Doc<'docSources'>[],
  queries: number,
): Id<'docSources'>[] {
  const rank = (source: Doc<'docSources'>): number =>
    SOURCE_AUTHORITIES.indexOf(sourceAuthorityOf(source));
  return [...sources]
    .sort((left, right) => rank(left) - rank(right))
    .slice(0, Math.floor(SEARCH_BLOCKS_LIMIT / Math.max(1, queries)))
    .map((source) => source._id);
}

/**
 * The blocks the scout finds: one search a query string, each over the employee's sources in
 * runs of at most `SEARCH_SOURCES_LIMIT` (each source its own query inside `searchBlocks`), of
 * current pages only (the index's `status` filter), dropping a block whose page is no longer
 * stored. Every search of one selection together reads at most `SEARCH_BLOCKS_LIMIT` blocks, the
 * bound one call keeps, since they share one query's read limit.
 */
async function scoutedBlocks(
  ctx: QueryCtx,
  scout: {
    readonly userId: string;
    readonly sources: readonly Doc<'docSources'>[];
    readonly queries: readonly string[];
  },
): Promise<SelectableBlock[]> {
  const sourceIds = scoutedSources(scout.sources, scout.queries.length);
  if (sourceIds.length === 0 || scout.queries.length === 0) return [];
  const runs: Id<'docSources'>[][] = [];
  for (let start = 0; start < sourceIds.length; start += SEARCH_SOURCES_LIMIT) {
    runs.push(sourceIds.slice(start, start + SEARCH_SOURCES_LIMIT));
  }
  // At least one: `scoutedSources` took no more sources than the limit holds a block each for.
  const limit = Math.min(
    SCOUT_LIMIT_PER_SOURCE,
    Math.floor(SEARCH_BLOCKS_LIMIT / (sourceIds.length * scout.queries.length)),
  );
  const found = (
    await Promise.all(
      scout.queries.flatMap((query) =>
        runs.map(
          async (run) =>
            await ctx.runQuery(internal.docBlocks.searchBlocks, {
              userId: scout.userId,
              sourceIds: run,
              query,
              limit,
              status: 'active',
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
 * key, and the stored blocks of the pages always included (`selectDocumentation`), each cited
 * block with its hash.
 *
 * @param ctx - The snapshot's query context.
 * @param input - The employee (with no owner key nothing is searched), the current pages it
 *   reads (`readableDocs` through `currentDocs`, in the mirror's order) and what the selection
 *   is for.
 */
export async function selectedDocumentation(
  ctx: QueryCtx,
  input: {
    readonly agent: Pick<Doc<'agents'>, 'userId'> | null;
    readonly docs: readonly Doc<'mockDocs'>[];
    readonly request: SelectionRequest;
  },
): Promise<SelectedDocumentation> {
  const { docs, request } = input;
  const sources = await sourcesOf(ctx, docs);
  const pages = selectablePages(docs, sources);
  const userId = input.agent?.userId;
  const scouted =
    userId === undefined || sources.length === 0
      ? []
      : await scoutedBlocks(ctx, { userId, sources, queries: scoutQueries(request, pages) });
  const always = alwaysIncludedPages(pages, request);
  const pageBlocks = await storedPageBlocks(ctx, docs, new Set(always));
  // The confirmed conflicts that stand on a block this selection may carry: their cite lines are
  // printed `[conflict]` (15-A). A selection that meets none reads no page for it.
  const hashes = new Set(
    [...scouted, ...[...pageBlocks.values()].flat()].flatMap((block) =>
      block.hash === undefined ? [] : [block.hash],
    ),
  );
  // The pages those blocks are of, for an owner whose confirmed conflicts pass one read: there
  // the conflicts are read by the page, so an older one is not missed (W15-R19; 17-C).
  const carriedKeys = new Set(
    [...scouted, ...[...pageBlocks.values()].flat()].map((block) => block.pageKey),
  );
  const carried = (): CarriedPage[] =>
    docs.flatMap((doc) =>
      doc.sourceId !== undefined &&
      doc.sourceRef !== undefined &&
      carriedKeys.has(pageKeyOf(doc.sourceId, doc.sourceRef))
        ? [{ sourceId: doc.sourceId, ref: doc.sourceRef }]
        : [],
    );
  const standing =
    userId === undefined ? [] : await standingConflictsOn(ctx, userId, hashes, carried);
  const conflicts = new Map(
    standing.flatMap((conflict) =>
      conflict.blocks.map((hash): [string, CiteConflict] => [hash, citeConflictOf(conflict)]),
    ),
  );
  return selectDocumentation({ request, pages, scouted, pageBlocks, always, conflicts });
}

/** A cited block that no longer stands, and what is known of why. */
export interface GoneBlock {
  /** The block's id as it was cited; one that names no row is gone. */
  readonly id: string;
  /** The page it was on, as a cite names a page (`<source>/<page>`), when its row still says. */
  readonly page?: string;
  /** The status the page has now, when that is why the cite no longer stands. */
  readonly status?: Exclude<PageStatus, 'active'>;
  /** The title of the page that superseded it, when one is named and stored. */
  readonly supersededBy?: string;
}

/** What one read finds of a cited block's page. */
interface CitedPage {
  /** The page as a cite names it. */
  readonly name: string;
  readonly stored: boolean;
  /** Whether the employee asking still reads the page's source; true when none is asking. */
  readonly readable: boolean;
  readonly status: PageStatus;
  readonly supersededBy?: string;
}

/**
 * The most successors one check of a plan's cites reads the whole row of, for its title: a page
 * row holds its whole text, and the cited page's own row is read beside it.
 */
const SUCCESSOR_ROWS_READ = 4;

/** The blocks of a successor past that bound that are read for its first heading. */
const SUCCESSOR_BLOCKS_READ = 4;

/**
 * The most rows past `SUCCESSOR_ROWS_READ` one check reads for a successor whose first heading may
 * have been cut (W17-R17): past them a cut title is named by its heading as kept.
 */
const SUCCESSOR_CUT_ROWS_READ = 2;

/**
 * The characters a block keeps of one heading, and of its whole heading path, each level cut to
 * its share (`src/docs/blocks.ts`'s `HEADING_PATH_CHARS` and `HEADING_PATH_TOTAL_CHARS`, which it
 * does not export; a mirror test splits a page to hold them equal).
 */
const BLOCK_HEADING_CHARS = 200;
const BLOCK_HEADING_PATH_CHARS = 300;

/**
 * Whether a block's first heading may have been cut to its share of the path (W17-R17): it holds
 * as many characters as a block keeps of it. A title that long is rare; its row is read for it.
 */
function firstHeadingMayBeCut(path: readonly string[]): boolean {
  const share = Math.min(
    BLOCK_HEADING_CHARS,
    Math.floor(BLOCK_HEADING_PATH_CHARS / Math.max(1, path.length)),
  );
  return [...(path[0] ?? '')].length >= share;
}

/**
 * The title of the page that superseded a cited one. Its row gives it exactly, for the first
 * `SUCCESSOR_ROWS_READ` of one check; past that it is the first heading of the page's first
 * blocks, small rows (W15-R20: a whole row a superseded cite, with the cited page's own, put a
 * plan of a dozen long pages over the read limit). A reader writes a page's title as its first
 * heading and a Markdown file's title is its first level-one heading, so the two agree but for a
 * file that opens with a lower heading; a page with no heading in those blocks is left unnamed. A
 * heading as long as a block keeps of it may have been cut, and the row is read for the title
 * then too (W17-R17), for at most `SUCCESSOR_CUT_ROWS_READ` of one check.
 *
 * @param takeRow - Asks the check for one of its whole-row reads; false once they are spent.
 * @param takeCutRow - Asks for one of its reads of a cut title's row; false once they are spent.
 */
async function successorTitle(
  ctx: QueryCtx,
  successor: { readonly sourceId: Id<'docSources'>; readonly ref: string },
  takeRow: () => boolean,
  takeCutRow: () => boolean,
): Promise<string | undefined> {
  const rowTitle = async (): Promise<string | undefined> =>
    (
      await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) =>
          q.eq('sourceId', successor.sourceId).eq('ref', successor.ref),
        )
        .unique()
    )?.title;
  if (takeRow()) return await rowTitle();
  const blocks = await ctx.db
    .query('docBlocks')
    .withIndex('by_source_page', (q) =>
      q.eq('sourceId', successor.sourceId).eq('pageRef', successor.ref),
    )
    .take(SUCCESSOR_BLOCKS_READ);
  const path = blocks.find((block) => block.headingPath.length > 0)?.headingPath;
  if (path !== undefined && firstHeadingMayBeCut(path) && takeCutRow()) return await rowTitle();
  return path?.[0];
}

/** One check's whole-row reads of successors: its first few, and the few of cut titles past them. */
interface SuccessorRowReads {
  readonly take: () => boolean;
  readonly takeCut: () => boolean;
}

/** A check's row reads, each kind counted to its bound. */
function successorRowReads(): SuccessorRowReads {
  const spent = { rows: 0, cut: 0 };
  const taker = (kind: 'rows' | 'cut', most: number) => (): boolean => {
    if (spent[kind] >= most) return false;
    spent[kind] += 1;
    return true;
  };
  return {
    take: taker('rows', SUCCESSOR_ROWS_READ),
    takeCut: taker('cut', SUCCESSOR_CUT_ROWS_READ),
  };
}

/** One cited block's page, read once: its row, its source and the page that superseded it. */
async function citedPage(
  ctx: QueryCtx,
  block: Pick<Doc<'docBlocks'>, 'sourceId' | 'pageRef'>,
  agent: Pick<Doc<'agents'>, 'userId' | 'excludedDocSourceIds'> | null | undefined,
  rows: SuccessorRowReads,
): Promise<CitedPage> {
  const [page, source] = await Promise.all([
    ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', block.sourceId).eq('ref', block.pageRef))
      .unique(),
    ctx.db.get(block.sourceId),
  ]);
  const supersededBy =
    page?.supersededBy === undefined
      ? undefined
      : await successorTitle(ctx, page.supersededBy, rows.take, rows.takeCut);
  return {
    name: `${source?.label || 'source'}/${block.pageRef}`,
    stored: page !== null,
    // The employee reads a source of its own owner's that it was not deployed without.
    readable:
      agent === undefined ||
      (agent !== null &&
        source !== null &&
        source.userId === agent.userId &&
        agentReadsSource(agent, source._id)),
    status: page === null ? 'active' : pageStatusOf(page),
    ...(supersededBy !== undefined ? { supersededBy } : {}),
  };
}

/**
 * The cited blocks of a plan that no longer stand as they were cited: the row deleted, its page
 * gone, the block it was cited under no longer on its page, **its page no longer current**
 * (superseded, archived or a draft: a status changes with no change of text, so every cited
 * hash still stands on a superseded page; 15-A), or its source no longer one the employee reads
 * (W14-R25). A cite is read by its hash on its page, the id only a hint to the page (W14-R2): a
 * block that moved, or a row that a re-split gave another block, still stands while the page
 * holds the cited block. Each cited page is read once however many of its blocks are cited
 * (W14-R28). Internal; the work loop reads it before the first phase writes and before the
 * closing phase authors (wave 14, 14-R).
 *
 * @returns Of the blocks given, those that are gone or changed, each once, with its page and,
 *   for a page no longer current, its status and what superseded it.
 * @throws Error past `SEARCH_BLOCKS_LIMIT` blocks; a caller checks a long list in parts.
 */
export const changedCitedBlocks = internalQuery({
  args: {
    /** The employee running the plan; with none, readability is not checked. */
    agentId: v.optional(v.id('agents')),
    blocks: v.array(v.object({ id: v.string(), hash: v.optional(v.string()) })),
  },
  handler: async (ctx, args): Promise<GoneBlock[]> => {
    if (args.blocks.length > SEARCH_BLOCKS_LIMIT) {
      throw new Error(`A plan's cites are checked ${SEARCH_BLOCKS_LIMIT} blocks at a time.`);
    }
    const agent = args.agentId === undefined ? undefined : await ctx.db.get(args.agentId);
    const onPage = async (block: Doc<'docBlocks'>, hash: string): Promise<boolean> =>
      (await ctx.db
        .query('docBlocks')
        .withIndex('by_source_page_hash', (q) =>
          q.eq('sourceId', block.sourceId).eq('pageRef', block.pageRef).eq('hash', hash),
        )
        .first()) !== null;
    const pages = new Map<string, Promise<CitedPage>>();
    const rows = successorRowReads();
    const pageOf = (block: Doc<'docBlocks'>): Promise<CitedPage> => {
      const key = pageKeyOf(block.sourceId, block.pageRef);
      if (!pages.has(key)) pages.set(key, citedPage(ctx, block, agent, rows));
      return pages.get(key)!;
    };
    const checked = await Promise.all(
      args.blocks.map(async (cited): Promise<GoneBlock | null> => {
        const blockId = ctx.db.normalizeId('docBlocks', cited.id);
        const block = blockId === null ? null : await ctx.db.get(blockId);
        if (block === null) return { id: cited.id };
        const page = await pageOf(block);
        if (!page.stored || !page.readable) return { id: cited.id, page: page.name };
        if (page.status !== 'active') {
          return {
            id: cited.id,
            page: page.name,
            status: page.status,
            ...(page.status === 'superseded' && page.supersededBy !== undefined
              ? { supersededBy: page.supersededBy }
              : {}),
          };
        }
        const stands =
          cited.hash === undefined ||
          block.hash === cited.hash ||
          (await onPage(block, cited.hash));
        return stands ? null : { id: cited.id, page: page.name };
      }),
    );
    const gone = new Map<string, GoneBlock>();
    for (const entry of checked) {
      if (entry !== null && !gone.has(entry.id)) gone.set(entry.id, entry);
    }
    return [...gone.values()];
  },
});

/**
 * Keep the blocks an item's plan was selected from on the item, each with its hash then
 * (`workItems.selectedBlocks`; wave 16, 16-FD; W15-R17): a block rewritten in place keeps its id,
 * so the gone-cite check of a plan with no cites compares the hash, and reads the item's own
 * record however many other items' selections the employee has had since. Internal; called by the
 * work loop once the plan site's selection is read. A block given without a hash, or an id that is
 * not a block's, is left out.
 */
export const recordPlanSelection = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    blocks: v.array(v.object({ id: v.string(), hash: v.optional(v.string()) })),
  },
  handler: async (ctx, args): Promise<null> => {
    const item = await ctx.db.get(args.workItemId);
    if (item === null) return null;
    const selectedBlocks = args.blocks.flatMap((block) => {
      const id = ctx.db.normalizeId('docBlocks', block.id);
      return id === null || block.hash === undefined ? [] : [{ id, hash: block.hash }];
    });
    await ctx.db.patch(item._id, { selectedBlocks });
    return null;
  },
});

/**
 * The blocks an item's plan was drafted from, when its planner cited none: those its plan-site
 * selection kept on the item, with their hashes (`workItems.selectedBlocks`, W15-R17); for an
 * item selected before that was kept, the block ids its newest plan-site selection recorded
 * (`work.documentation-selected`), among the employee's newest selection records. The closing
 * check reads these for a plan with no cites, so it is not vacuous (W14-R25). Internal; reads
 * the item and, for an older item, the employee's newest selection records; writes nothing.
 *
 * @returns The blocks, each with its hash where it was kept, or none when the item has no
 *   recorded plan selection.
 */
export const plannedFromBlocks = internalQuery({
  args: { agentId: v.id('agents'), workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<Array<{ id: string; hash?: string }>> => {
    // A kept selection that holds no block (its blocks came without hashes) says nothing: the
    // event's ids are read instead, so the check is never vacuous.
    const item = await ctx.db.get(args.workItemId);
    if (item?.selectedBlocks !== undefined && item.selectedBlocks.length > 0) {
      return item.selectedBlocks.map((block) => ({ id: block.id, hash: block.hash }));
    }
    // A redraft whose selection failed read the whole mirror: an earlier draft's record names
    // nothing it was drafted from (W16-R11).
    const selection = await planSelectionOf(ctx, { _id: args.workItemId, agentId: args.agentId });
    return selection === undefined || selection === 'fell-back'
      ? []
      : selection.blockIds.map((id) => ({ id }));
  },
});

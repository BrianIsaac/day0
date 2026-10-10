import { ConvexError, v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { firstBlockStatus } from './docBlocks';
import { appendEvent } from './eventLog';
import { getCallerOrThrow, verifiedAddressOf } from './ownership';
import {
  RELATIONS_OF_A_PAGE,
  decideByHand,
  readersOf,
  restatePage,
  stampStatusChanges,
  statusSourceOf,
  SUCCESSOR_NOT_CURRENT,
} from './docStatus';
import {
  pageStatusOf,
  sourceAuthorityOf,
  type PageStatus,
  type RelationKind,
  type SourceAuthority,
  type StatusSource,
} from '../src/docs/authority';
import { MAX_BLOCKS_PER_PAGE, blockSearchQuery } from '../src/docs/blocks';
import { frontMatterStatus } from '../src/docs/status';
import type { CiteConflict, PlanCite } from '../src/work/types';
import {
  RELATION_CANDIDATES_PER_PAGE,
  headingFigures,
  measureRelation,
  type MeasuredBlock,
  type MeasuredPage,
  type ProposedRelation,
} from '../src/docs/relations';

/*
 * Relations between stored pages (wave 15, 15-A; the wave file's section 6.2): the proposals a
 * finishing sync writes for the pages it stored or changed (`measurePage`, over
 * `src/docs/relations.ts`), and the manager's decision on each (`decide`). A relation is
 * confirmed on a card and never by code: a proposal changes no page's status, holds no plan and
 * tags no cite. A confirmed successor supersedes the older page (`docStatus.restatePage`); a
 * confirmed conflict between two active pages of equal trust stands (`standingConflictOf`) until
 * the manager says which page is right or that both hold.
 *
 * This module imports nothing of `docSources` or of anything that reaches `work`.
 */

/** A page's name within its owner's documentation. */
interface PageName {
  readonly sourceId: Id<'docSources'>;
  readonly ref: string;
}

/** A page as a card and an event name it. */
export interface NamedPage extends PageName {
  /** The page's stored title. */
  readonly title: string;
  /** Its source's label. */
  readonly source: string;
}

/** The blocks one search answers a source while a page's candidates are looked for. */
const CANDIDATE_BLOCKS_PER_SOURCE = 4;

/** The most of an owner's sources one page's candidates are looked for in. */
const CANDIDATE_SOURCES = 32;

/** The most pages a page's front matter may name that are looked up by name. */
const NAMED_PAGES = 4;

/** A page's key for the measures: its source and ref. */
function keyOf(page: PageName): string {
  return `${page.sourceId}:${page.ref}`;
}

/** A stored page of a source, by its ref. */
async function pageAt(ctx: QueryCtx, name: PageName): Promise<Doc<'docPages'> | null> {
  return await ctx.db
    .query('docPages')
    .withIndex('by_source_ref', (q) => q.eq('sourceId', name.sourceId).eq('ref', name.ref))
    .unique();
}

/** A stored page as the measures read it, with its blocks in document order. */
async function measured(ctx: QueryCtx, page: Doc<'docPages'>): Promise<MeasuredPage> {
  const rows = await ctx.db
    .query('docBlocks')
    .withIndex('by_source_page', (q) => q.eq('sourceId', page.sourceId).eq('pageRef', page.ref))
    .take(MAX_BLOCKS_PER_PAGE);
  return {
    key: keyOf(page),
    ref: page.ref,
    title: page.title,
    markdown: page.markdown,
    updatedAt: page.updatedAt,
    blocks: rows.map(
      (row): MeasuredBlock => ({ hash: row.hash, headingPath: row.headingPath, text: row.text }),
    ),
  };
}

/**
 * The owner's other active pages a page may relate to: the pages its front matter names, then
 * the pages whose blocks the search index answers for its title and for its headings, most
 * blocks first. At most `RELATION_CANDIDATES_PER_PAGE`, so one page's measure reads a bounded
 * number of pages whatever the library holds.
 */
async function candidatesOf(
  ctx: QueryCtx,
  owner: { readonly userId: string; readonly sources: readonly Doc<'docSources'>[] },
  page: Doc<'docPages'>,
  blocks: readonly MeasuredBlock[],
): Promise<PageName[]> {
  const self = keyOf(page);
  const found = new Map<string, { name: PageName; hits: number }>();
  const hit = (name: PageName, weight: number): void => {
    const key = keyOf(name);
    if (key === self) return;
    found.set(key, { name, hits: (found.get(key)?.hits ?? 0) + weight });
  };
  // A page its front matter names is a candidate whatever the search says of it.
  const front = frontMatterStatus(page.markdown);
  for (const named of [...front.supersedes, ...front.supersededBy].slice(0, NAMED_PAGES)) {
    for (const source of owner.sources) {
      for (const ref of [named, `${named}.md`]) {
        if ((await pageAt(ctx, { sourceId: source._id, ref })) !== null) {
          hit({ sourceId: source._id, ref }, 1_000);
        }
      }
    }
  }
  const headings = [...new Set(blocks.map((block) => block.headingPath.at(-1) ?? ''))].join(' ');
  const queries = [blockSearchQuery(page.title), blockSearchQuery(headings)].filter(
    (text, index, all) => text !== '' && all.indexOf(text) === index,
  );
  for (const text of queries) {
    const answers = await Promise.all(
      owner.sources.map(
        async (source) =>
          await ctx.db
            .query('docBlocks')
            .withSearchIndex('by_text', (q) =>
              q
                .search('searchText', text)
                .eq('userId', owner.userId)
                .eq('sourceId', source._id)
                .eq('status', 'active'),
            )
            .take(CANDIDATE_BLOCKS_PER_SOURCE),
      ),
    );
    for (const row of answers.flat()) hit({ sourceId: row.sourceId, ref: row.pageRef }, 1);
  }
  return [...found.values()]
    .sort((left, right) => right.hits - left.hits)
    .slice(0, RELATION_CANDIDATES_PER_PAGE)
    .map((entry) => entry.name);
}

/** The relations between two pages, in either direction. */
async function relationsBetween(
  ctx: QueryCtx,
  one: PageName,
  other: PageName,
): Promise<Doc<'docRelations'>[]> {
  const [from, to] = await Promise.all([
    ctx.db
      .query('docRelations')
      .withIndex('by_from', (q) => q.eq('from.sourceId', one.sourceId).eq('from.ref', one.ref))
      .take(RELATIONS_OF_A_PAGE),
    ctx.db
      .query('docRelations')
      .withIndex('by_to', (q) => q.eq('to.sourceId', one.sourceId).eq('to.ref', one.ref))
      .take(RELATIONS_OF_A_PAGE),
  ]);
  return [
    ...from.filter((row) => keyOf(row.to) === keyOf(other)),
    ...to.filter((row) => keyOf(row.from) === keyOf(other)),
  ];
}

/** The block hashes a conflict's evidence names. */
function conflictBlocks(relation: Pick<Doc<'docRelations'>, 'evidence'>): string[] {
  return relation.evidence.find((entry) => entry.measure === 'heading-figures')?.blockRefs ?? [];
}

/**
 * Whether a pair already holds the relation a proposal would write, so it is not proposed again:
 * versions of one document (a duplicate or a successor) once, whatever the manager decided; a
 * conflict while one is open or confirmed and its blocks still disagree, or was set aside over
 * the same blocks. A conflict the manager set aside is proposed again only when the blocks that
 * disagree are other blocks, which is to say a page changed. A conflict whose own blocks no
 * longer disagree is drawn on no card and holds nothing, so it stands in the way of no later one;
 * left unanswered, it is a proposal nobody can answer, and is deleted here.
 */
async function alreadyHeld(
  ctx: MutationCtx,
  existing: readonly Doc<'docRelations'>[],
  proposed: ProposedRelation,
): Promise<boolean> {
  if (proposed.kind !== 'possible_conflict') {
    return existing.some((row) => row.kind !== 'possible_conflict');
  }
  const blocks = new Set(
    proposed.evidence.find((entry) => entry.measure === 'heading-figures')?.blockRefs ?? [],
  );
  let held = false;
  for (const row of existing) {
    if (row.kind !== 'possible_conflict') continue;
    if (row.status === 'dismissed') {
      held ||= conflictBlocks(row).every((hash) => blocks.has(hash));
    } else if ((await disagreementOf(ctx, row)) !== undefined) {
      held = true;
    } else if (row.status === 'proposed') {
      await ctx.db.delete(row._id);
    }
  }
  return held;
}

/**
 * Delete the proposals that name a page its source no longer has (`docSources.prunePages` calls
 * it with the pages a finish removed): drawn on no card, they could never be answered, and they
 * filled the read of the cards still to answer. What the manager decided is kept: it is their
 * answer, and a confirmed successor's older page is restated only by a decision.
 *
 * @param ctx - The pruning mutation's context.
 * @param sourceId - The source the pages left.
 * @param refs - The removed pages' refs.
 */
export async function forgetProposalsOf(
  ctx: MutationCtx,
  sourceId: Id<'docSources'>,
  refs: readonly string[],
): Promise<void> {
  for (const ref of refs) {
    const [from, to] = await Promise.all([
      ctx.db
        .query('docRelations')
        .withIndex('by_from', (q) => q.eq('from.sourceId', sourceId).eq('from.ref', ref))
        .take(RELATIONS_OF_A_PAGE),
      ctx.db
        .query('docRelations')
        .withIndex('by_to', (q) => q.eq('to.sourceId', sourceId).eq('to.ref', ref))
        .take(RELATIONS_OF_A_PAGE),
    ]);
    for (const relation of [...from, ...to]) {
      if (relation.status === 'proposed') await ctx.db.delete(relation._id);
    }
  }
}

/** A stored page with its source's label, as a card and an event name it. */
function named(page: Doc<'docPages'>, source: Doc<'docSources'>): NamedPage {
  return { sourceId: page.sourceId, ref: page.ref, title: page.title, source: source.label };
}

/** The owner's employees that read either of two sources, each once. */
async function readersOfEither(
  ctx: QueryCtx,
  sources: readonly Doc<'docSources'>[],
): Promise<Doc<'agents'>[]> {
  const readers = new Map<Id<'agents'>, Doc<'agents'>>();
  for (const source of new Map(sources.map((source) => [source._id, source])).values()) {
    for (const agent of await readersOf(ctx, source)) readers.set(agent._id, agent);
  }
  return [...readers.values()];
}

/**
 * Measure one page a sync stored or changed against the owner's other active pages, and write a
 * `proposed` relation for each pair the measures relate that holds none yet. Internal; the sync
 * calls it a page at a time once its generation has completed and its statuses stand, fenced on
 * that generation still being the source's newest (its last completed one, or the one running).
 * Reads the page, its blocks and at most `RELATION_CANDIDATES_PER_PAGE`
 * other pages with theirs. Writes relation rows and `documentation.relation-proposed` on the
 * record of each employee that reads either page; no page's status, no plan and no cite changes.
 * It stops at `room` new proposals, which is what its sync has left of its cap, so the cap is the
 * most a sync proposes whatever its last page holds.
 *
 * @returns How many relations it proposed.
 */
export const measurePage = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    syncRunId: v.id('docSyncRuns'),
    ref: v.string(),
    /** The new proposals this call may still write; absent, every one its candidates hold. */
    room: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<number> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) return 0;
    if (source.activeSyncId !== args.syncRunId && source.lastCompletedSyncId !== args.syncRunId) {
      return 0;
    }
    const page = await pageAt(ctx, args);
    if (page === null || pageStatusOf(page) !== 'active') return 0;
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (q) => q.eq('userId', source.userId))
      .take(CANDIDATE_SOURCES);
    const self = await measured(ctx, page);
    const now = Date.now();
    let proposed = 0;
    for (const candidate of await candidatesOf(
      ctx,
      { userId: source.userId, sources },
      page,
      self.blocks,
    )) {
      if (proposed >= (args.room ?? RELATION_CANDIDATES_PER_PAGE)) break;
      const other = await pageAt(ctx, candidate);
      const otherSource = sources.find((row) => row._id === candidate.sourceId);
      if (other === null || otherSource === undefined || pageStatusOf(other) !== 'active') continue;
      const relation = measureRelation(self, await measured(ctx, other));
      if (relation === undefined) continue;
      if (await alreadyHeld(ctx, await relationsBetween(ctx, page, other), relation)) continue;
      const [from, to] = relation.from === self.key ? [page, other] : [other, page];
      const relationId = await ctx.db.insert('docRelations', {
        userId: source.userId,
        from: { sourceId: from.sourceId, ref: from.ref },
        to: { sourceId: to.sourceId, ref: to.ref },
        kind: relation.kind,
        evidence: relation.evidence.map((entry) => ({ ...entry })),
        status: 'proposed',
        createdAt: now,
      });
      const sourceOf = (row: Doc<'docPages'>): Doc<'docSources'> =>
        row.sourceId === source._id ? source : otherSource;
      for (const agent of await readersOfEither(ctx, [source, otherSource])) {
        await appendEvent(ctx, {
          agentId: agent._id,
          type: 'documentation.relation-proposed',
          payload: {
            relationId,
            kind: relation.kind,
            from: named(from, sourceOf(from)),
            to: named(to, sourceOf(to)),
            evidence: relation.evidence.map(({ measure, value }) => ({ measure, value })),
          },
          createdAt: now,
        });
      }
      proposed += 1;
    }
    return proposed;
  },
});

/** One bounded read of the blocks a generation wrote: under a query's read limit. */
const GENERATION_BLOCKS_READ = { numItems: 400, maximumBytesRead: 4 * 1024 * 1024 } as const;

/** The most runs a sync measures the pages of: itself and those before it back to a complete walk. */
const GENERATIONS_MEASURED = 6;

/**
 * The runs whose pages a completed sync measures: its own, and every run of the source before it
 * back to (and with) the complete walk before it, newest first. A resumed sync stored its first
 * pages under the run it took over, and a page whose split landed after its sync's measure is
 * reached by the next sync's: both are covered this way, and a pair measured twice is proposed
 * once. Reads a few run rows.
 */
async function generationsOf(
  ctx: QueryCtx,
  sourceId: Id<'docSources'>,
  runId: Id<'docSyncRuns'>,
): Promise<Id<'docSyncRuns'>[]> {
  const runs = await ctx.db
    .query('docSyncRuns')
    .withIndex('by_source', (q) => q.eq('sourceId', sourceId))
    .order('desc')
    .take(2 * GENERATIONS_MEASURED);
  const from = runs.findIndex((run) => run._id === runId);
  if (from < 0) return [];
  const earlier = runs.slice(from + 1);
  const walkBefore = earlier.findIndex((run) => run.state === 'completed');
  return [
    runId,
    ...(walkBefore < 0 ? earlier : earlier.slice(0, walkBefore + 1)).map((run) => run._id),
  ].slice(0, GENERATIONS_MEASURED);
}

/** The runs whose pages a completed sync measures ({@link generationsOf}). Internal. */
export const generationsToMeasure = internalQuery({
  args: { sourceId: v.id('docSources'), runId: v.id('docSyncRuns') },
  handler: async (ctx, args): Promise<Id<'docSyncRuns'>[]> =>
    await generationsOf(ctx, args.sourceId, args.runId),
});

/** What is left to measure: the runs whose pages are, in order, and the place in the first's. */
export interface MeasuringPlan {
  readonly generations: Id<'docSyncRuns'>[];
  readonly cursor: string | null;
}

const measuringPlanValidator = v.object({
  generations: v.array(v.id('docSyncRuns')),
  cursor: v.union(v.string(), v.null()),
});

/**
 * What a completed sync's measuring has to measure (W15-R5): first what an earlier sync's was
 * stopped short of by its cap on new proposals (`docSources.relationsOwed`), from the place it
 * stopped, then the runs of its own look-back that are not among those. Internal; reads the
 * source and a few run rows.
 *
 * @returns The plan, or null when the run is no longer the source's running or last completed
 *   one: a newer sync measures instead, and reads what is owed itself.
 */
export const measuringPlan = internalQuery({
  args: { sourceId: v.id('docSources'), runId: v.id('docSyncRuns') },
  handler: async (ctx, args): Promise<MeasuringPlan | null> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) return null;
    if (source.activeSyncId !== args.runId && source.lastCompletedSyncId !== args.runId) {
      return null;
    }
    const own = await generationsOf(ctx, args.sourceId, args.runId);
    const owed = source.relationsOwed;
    if (owed === undefined || owed.generations.length === 0) {
      return { generations: own, cursor: null };
    }
    return {
      generations: [...owed.generations, ...own.filter((id) => !owed.generations.includes(id))],
      cursor: owed.cursor,
    };
  },
});

/**
 * Record what a sync's measuring left unmeasured, or that it left nothing (W15-R5). Internal;
 * called by `docSyncActions.proposeRelations` when its cap on new proposals stops it, and when it
 * reaches the end. Writes `docSources.relationsOwed` only for the source's running or last
 * completed run, so a measuring a newer sync has overtaken changes nothing.
 */
export const settleRelationsOwed = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    /** What is left; null when every page was measured. */
    owed: v.union(measuringPlanValidator, v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) return null;
    if (source.activeSyncId !== args.runId && source.lastCompletedSyncId !== args.runId) {
      return null;
    }
    if (args.owed === null && source.relationsOwed === undefined) return null;
    await ctx.db.patch(source._id, { relationsOwed: args.owed ?? undefined });
    return null;
  },
});

/**
 * One bounded page of the pages a run stored or changed, by the blocks it wrote: a block a sync
 * writes or rewrites carries the run that stored its page (`docBlocks.generation`, read here by
 * `by_source_generation`), so the pages whose text is new since the last walk are found by an
 * index, whatever the source holds. Internal; reads block rows, writes nothing.
 *
 * @returns The distinct page refs on this page of the read, and where it goes on (null: done).
 */
export const pagesWrittenBy = internalQuery({
  args: {
    sourceId: v.id('docSources'),
    generation: v.id('docSyncRuns'),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ refs: string[]; next: string | null }> => {
    const page = await ctx.db
      .query('docBlocks')
      .withIndex('by_source_generation', (q) =>
        q.eq('sourceId', args.sourceId).eq('generation', args.generation),
      )
      .paginate({ ...GENERATION_BLOCKS_READ, cursor: args.cursor });
    return {
      refs: [...new Set(page.page.map((block) => block.pageRef))],
      next: page.isDone ? null : page.continueCursor,
    };
  },
});

/** A source's trust as it bears on one of its pages: the page's own, when the manager set one. */
function authorityOf(page: Doc<'docPages'>, source: Doc<'docSources'>): SourceAuthority {
  return page.authorityOverride ?? sourceAuthorityOf(source);
}

/** A confirmed conflict that stands: its two pages, the heading and the figures they disagree on. */
export interface StandingConflict {
  readonly relationId: Id<'docRelations'>;
  readonly from: NamedPage;
  readonly to: NamedPage;
  /** The heading the disagreement sits under, as the first page writes it. */
  readonly heading: string;
  /** What each page says there, as written. */
  readonly figures: { readonly from: string; readonly to: string };
  /** The hashes of the blocks that disagree, on both pages. */
  readonly blocks: readonly string[];
}

/** The blocks of a page under the given hashes, as the measures read them, each with its status. */
async function blocksUnder(
  ctx: QueryCtx,
  page: PageName,
  hashes: readonly string[],
): Promise<Array<MeasuredBlock & { readonly status: PageStatus }>> {
  const rows = await Promise.all(
    hashes.map(
      async (hash) =>
        await ctx.db
          .query('docBlocks')
          .withIndex('by_source_page_hash', (q) =>
            q.eq('sourceId', page.sourceId).eq('pageRef', page.ref).eq('hash', hash),
          )
          .first(),
    ),
  );
  return rows.flatMap((row) =>
    row === null
      ? []
      : [
          {
            hash: row.hash,
            headingPath: row.headingPath,
            text: row.text,
            status: row.status ?? 'active',
          },
        ],
  );
}

/**
 * What a conflict's two pages say, read from the blocks its evidence names: small rows, so a
 * conflict that no longer disagrees, or one of whose pages is no longer current (a block carries
 * its page's status), is set aside before either page's row, which holds its whole text, is read.
 */
async function disagreementOf(
  ctx: QueryCtx,
  relation: Doc<'docRelations'>,
): Promise<{ heading: string; figures: { from: string; to: string } } | undefined> {
  const hashes = conflictBlocks(relation);
  const [from, to] = await Promise.all([
    blocksUnder(ctx, relation.from, hashes),
    blocksUnder(ctx, relation.to, hashes),
  ]);
  if ([...from, ...to].some((block) => block.status !== 'active')) return undefined;
  const [first] = headingFigures({ blocks: from }, { blocks: to });
  return first === undefined
    ? undefined
    : { heading: first.heading, figures: { from: first.left, to: first.right } };
}

/**
 * A relation as a conflict that stands, or undefined: the manager confirmed it, both its pages
 * are stored and active, their trust is equal (official over team over personal settles a
 * disagreement between unequal pages by itself), and the blocks its evidence names still
 * disagree. Read by the selection, which tags the cites of those blocks, and by the plan's
 * decision, which holds a plan that cites one.
 *
 * @param ctx - A query's or a mutation's context.
 * @param relation - The relation's row, or null when it is gone.
 */
export async function standingConflictOf(
  ctx: QueryCtx,
  relation: Doc<'docRelations'> | null,
): Promise<StandingConflict | undefined> {
  return (await standingWithPages(ctx, relation))?.conflict;
}

/**
 * `standingConflictOf`, with the two page rows it read, for a caller that draws them (the cards)
 * and so reads, and counts, each once.
 */
async function standingWithPages(
  ctx: QueryCtx,
  relation: Doc<'docRelations'> | null,
): Promise<
  | {
      conflict: StandingConflict;
      from: Doc<'docPages'>;
      to: Doc<'docPages'>;
      /** The trust the two pages share. */
      trust: SourceAuthority;
    }
  | undefined
> {
  if (relation === null || relation.kind !== 'possible_conflict') return undefined;
  if (relation.status !== 'confirmed') return undefined;
  // The blocks first: a settled conflict costs a few small rows and no page's text.
  const disagreement = await disagreementOf(ctx, relation);
  if (disagreement === undefined) return undefined;
  const [from, to, fromSource, toSource] = await Promise.all([
    pageAt(ctx, relation.from),
    pageAt(ctx, relation.to),
    ctx.db.get(relation.from.sourceId),
    ctx.db.get(relation.to.sourceId),
  ]);
  if (from === null || to === null || fromSource === null || toSource === null) return undefined;
  if (pageStatusOf(from) !== 'active' || pageStatusOf(to) !== 'active') return undefined;
  const trust = authorityOf(from, fromSource);
  if (trust !== authorityOf(to, toSource)) return undefined;
  return {
    trust,
    conflict: {
      relationId: relation._id,
      from: named(from, fromSource),
      to: named(to, toSource),
      ...disagreement,
      blocks: conflictBlocks(relation),
    },
    from,
    to,
  };
}

/**
 * The most conflicts an owner's manager confirmed that one read takes, newest first: each is an
 * answer given by hand on a card, and its row is under a kilobyte (`RELATION_EVIDENCE_BLOCKS`),
 * so the read stays under a megabyte.
 */
export const CONFIRMED_CONFLICTS_READ = 512;

/**
 * The conflicts the owner's manager confirmed, newest first, read by their own index: the kept
 * versions, the confirmed successors and the dismissed proposals, which only ever grow, take no
 * place in the read (the second pass's major 2). A conflict the manager settled by saying which
 * page is right stays among them, and stands again if that page is made current again.
 */
async function confirmedConflicts(ctx: QueryCtx, userId: string): Promise<Doc<'docRelations'>[]> {
  return await ctx.db
    .query('docRelations')
    .withIndex('by_user_kind_status', (q) =>
      q.eq('userId', userId).eq('kind', 'possible_conflict').eq('status', 'confirmed'),
    )
    .order('desc')
    .take(CONFIRMED_CONFLICTS_READ);
}

/**
 * The owner's confirmed conflicts whose evidence names any of the given block hashes and that
 * stand (`standingConflictOf`), by block hash: what the selection tags. The relation rows are
 * read first, and a conflict's pages only when one of its blocks is among those asked about, so
 * a selection that meets no conflict reads no page for it.
 *
 * @param ctx - The selection's query context.
 * @param userId - The owner's key.
 * @param hashes - The hashes of the blocks the selection may carry.
 */
export async function standingConflictsOn(
  ctx: QueryCtx,
  userId: string,
  hashes: ReadonlySet<string>,
): Promise<Map<string, StandingConflict>> {
  const byHash = new Map<string, StandingConflict>();
  if (hashes.size === 0) return byHash;
  for (const relation of await confirmedConflicts(ctx, userId)) {
    if (!conflictBlocks(relation).some((hash) => hashes.has(hash))) continue;
    const standing = await standingConflictOf(ctx, relation);
    if (standing === undefined) continue;
    for (const hash of standing.blocks) byHash.set(hash, standing);
  }
  return byHash;
}

/** A standing conflict as a cite carries it: the relation, the heading and the two pages. */
export function citeConflictOf(conflict: StandingConflict): CiteConflict {
  return {
    relationId: conflict.relationId,
    heading: conflict.heading,
    pages: [
      { title: conflict.from.title, source: conflict.from.source },
      { title: conflict.to.title, source: conflict.to.source },
    ],
  };
}

/**
 * The conflict a drafted plan rests on, if one still stands: the first of its cites that was
 * disputed when the plan was drafted (`PlanCite.conflict`) and whose relation is still a
 * confirmed conflict between two active pages of equal trust. Read at the plan's decision, and
 * again at each later look, so a conflict the manager settled since holds nothing.
 *
 * @param ctx - The deciding mutation's context.
 * @param plan - The work item's plan, as stored.
 */
export async function citedConflictOf(
  ctx: QueryCtx,
  plan: unknown,
): Promise<CiteConflict | undefined> {
  const cites =
    typeof plan === 'object' && plan !== null && 'cites' in plan && Array.isArray(plan.cites)
      ? (plan.cites as ReadonlyArray<Pick<PlanCite, 'conflict'>>)
      : [];
  const relationIds = [
    ...new Set(cites.flatMap((cite) => (cite.conflict ? [cite.conflict.relationId] : []))),
  ];
  for (const id of relationIds) {
    const relationId = ctx.db.normalizeId('docRelations', id);
    const standing =
      relationId === null ? undefined : await standingConflictOf(ctx, await ctx.db.get(relationId));
    if (standing !== undefined) return citeConflictOf(standing);
  }
  return undefined;
}

/** What the manager may answer a relation's card. */
export const RELATION_DECISIONS = [
  /** "{B} supersedes {A}": the relation's `from` is the later version of its `to`. */
  'supersedes',
  /** "Keep both": versions of one document, both current. */
  'keep-both',
  /** "Not the same": the measures were wrong. */
  'not-the-same',
  /** "They disagree": the conflict is real; hold what relies on it and ask. */
  'disagree',
  /** "{A} is right" and "{B} is right": the other page gives way. */
  'from-is-right',
  'to-is-right',
  /** "Both hold": each page is right where it applies; keep both, no tag. */
  'both-hold',
  /** "Undo": the answer is taken back, with what it set off, and the card asks again. */
  'undo',
] as const;

/** One answer to a relation's card. */
export type RelationDecision = (typeof RELATION_DECISIONS)[number];

/** Why a decision was refused: the card it answers is no longer the relation's. */
export const DECISION_NOT_OFFERED = 'That card has changed: this answer is no longer offered.';

/**
 * The answers a relation offers as it stands. An answered relation offers "Undo", so no answer
 * is one the manager cannot take back; all but a confirmed conflict, which keeps its own three
 * answers while it stands, and whose "{A} is right" is taken back on the superseded page's own
 * row ("This is current" or "Clear"), after which the conflict stands again. A proposed conflict
 * between pages that are not trusted alike offers no "They disagree": no conflict stands between
 * them (`standingConflictOf`), so the answer would hold nothing.
 *
 * @param relation - The relation as stored.
 * @param equalTrust - Whether its two pages are trusted alike; read only for a proposed conflict.
 */
export function decisionsOffered(
  relation: Pick<Doc<'docRelations'>, 'kind' | 'status'>,
  equalTrust = true,
): readonly RelationDecision[] {
  if (relation.kind === 'possible_conflict') {
    if (relation.status === 'proposed') {
      return equalTrust
        ? ['disagree', 'from-is-right', 'to-is-right', 'both-hold']
        : ['from-is-right', 'to-is-right', 'both-hold'];
    }
    return relation.status === 'confirmed'
      ? ['from-is-right', 'to-is-right', 'both-hold']
      : ['undo'];
  }
  return relation.status === 'proposed' ? ['supersedes', 'keep-both', 'not-the-same'] : ['undo'];
}

/** What a decision makes of the relation's row. */
function decided(
  decision: RelationDecision,
): Pick<Doc<'docRelations'>, 'status'> & { kind?: RelationKind } {
  switch (decision) {
    case 'supersedes':
      return { kind: 'possible_successor', status: 'confirmed' };
    case 'keep-both':
      return { kind: 'possible_duplicate', status: 'confirmed' };
    case 'disagree':
    case 'from-is-right':
    case 'to-is-right':
      return { status: 'confirmed' };
    case 'not-the-same':
    case 'both-hold':
      return { status: 'dismissed' };
    case 'undo':
      return { status: 'proposed' };
    default: {
      const unknown: never = decision;
      throw new Error(`unhandled decision ${String(unknown)}`);
    }
  }
}

/**
 * What became of the older page once "{B} supersedes {A}" was recorded: its status and what
 * decided it. A confirmed relation is the rules' fourth word, so a page its source calls current,
 * or the manager decided by hand, is not superseded by it, and the card says so.
 */
export interface SupersedeOutcome {
  readonly older: PageStatus;
  readonly by: StatusSource;
}

/**
 * Answer a relation's card (the Documentation tab's relation and conflict cards). Public; the
 * caller must own the relation. Writes the relation's standing with the caller's verified
 * address and the time, `documentation.relation-decided` on the record of each employee that
 * reads either page, and what the answer sets off: "supersedes" restates the older page, which
 * a confirmed successor supersedes (its blocks, its readers' parked work and the skills that
 * read it follow, `docStatus.restatePage`); "{A} is right" marks the other page superseded by it
 * in the manager's name; "They disagree" leaves both pages current and lets the conflict stand
 * (`standingConflictOf`); "Undo" makes the relation a proposal again, with nobody's name on it,
 * and restates the page a confirmed successor had superseded; the rest change no page.
 *
 * @returns For "supersedes", what became of the older page; null for every other answer.
 * @throws ConvexError when the relation is gone, its card no longer offers the answer (a confirmed
 *   conflict that no longer stands among them), or the page the answer would make stand in for
 *   the other is not current.
 */
export const decide = mutation({
  args: {
    relationId: v.id('docRelations'),
    decision: v.union(...RELATION_DECISIONS.map((decision) => v.literal(decision))),
  },
  handler: async (ctx, args): Promise<SupersedeOutcome | null> => {
    const caller = await getCallerOrThrow(ctx);
    const relation = await ctx.db.get(args.relationId);
    if (relation === null) throw new ConvexError('That relation is no longer stored.');
    if (relation.userId !== caller.ownerKey) throw new Error('forbidden');
    const [from, to, fromSource, toSource] = await Promise.all([
      pageAt(ctx, relation.from),
      pageAt(ctx, relation.to),
      ctx.db.get(relation.from.sourceId),
      ctx.db.get(relation.to.sourceId),
    ]);
    const equalTrust =
      from === null ||
      to === null ||
      fromSource === null ||
      toSource === null ||
      authorityOf(from, fromSource) === authorityOf(to, toSource);
    if (!decisionsOffered(relation, equalTrust).includes(args.decision)) {
      throw new ConvexError(DECISION_NOT_OFFERED);
    }
    // A confirmed conflict takes its answers only while it stands (W15-R6): once one page was
    // named right, a second answer from a card drawn before would supersede the other page too.
    if (
      relation.kind === 'possible_conflict' &&
      relation.status === 'confirmed' &&
      (await standingConflictOf(ctx, relation)) === undefined
    ) {
      throw new ConvexError(DECISION_NOT_OFFERED);
    }
    // The page an answer makes stand in for the other must be current itself.
    const successor =
      args.decision === 'supersedes' || args.decision === 'from-is-right'
        ? from
        : args.decision === 'to-is-right'
          ? to
          : null;
    if (successor !== null && pageStatusOf(successor) !== 'active') {
      throw new ConvexError(SUCCESSOR_NOT_CURRENT);
    }
    const now = Date.now();
    const decidedBy = verifiedAddressOf(caller);
    await ctx.db.patch(
      relation._id,
      args.decision === 'undo'
        ? { ...decided(args.decision), decidedBy: undefined, decidedAt: undefined }
        : {
            ...decided(args.decision),
            ...(decidedBy !== undefined ? { decidedBy } : {}),
            decidedAt: now,
          },
    );
    if (from === null || to === null || fromSource === null || toSource === null) return null;
    // A successor confirmed, or one whose confirmation is taken back: the older page is restated.
    if (
      args.decision === 'supersedes' ||
      (args.decision === 'undo' && relation.kind === 'possible_successor')
    ) {
      const change = await restatePage(ctx, { source: toSource, page: to, now });
      await stampStatusChanges(ctx, toSource, [change], now);
    } else if (args.decision === 'from-is-right' || args.decision === 'to-is-right') {
      const [right, wrong, wrongSource] =
        args.decision === 'from-is-right' ? [from, to, toSource] : [to, from, fromSource];
      await decideByHand(ctx, {
        source: wrongSource,
        page: wrong,
        status: 'superseded',
        supersededBy: { sourceId: right.sourceId, ref: right.ref },
        decidedBy,
        now,
      });
    }
    for (const agent of await readersOfEither(ctx, [fromSource, toSource])) {
      await appendEvent(ctx, {
        agentId: agent._id,
        type: 'documentation.relation-decided',
        payload: {
          relationId: relation._id,
          kind: decided(args.decision).kind ?? relation.kind,
          decision: args.decision,
          from: named(from, fromSource),
          to: named(to, toSource),
        },
        createdAt: now,
      });
    }
    if (args.decision !== 'supersedes') return null;
    const older = (await ctx.db.get(to._id)) ?? to;
    return { older: pageStatusOf(older), by: statusSourceOf(older) };
  },
});

/** A page as a relation's card draws it: when its source last had it, and how far it is trusted. */
type CardPage = NamedPage & { readonly updatedAt: number; readonly authority: SourceAuthority };

/** A stored page as a relation's card draws it. */
function cardPage(page: Doc<'docPages'>, source: Doc<'docSources'>): CardPage {
  return {
    ...named(page, source),
    updatedAt: page.updatedAt,
    authority: authorityOf(page, source),
  };
}

/** A relation as its card draws it. */
export interface RelationCardRow {
  readonly _id: Id<'docRelations'>;
  readonly kind: RelationKind;
  readonly status: 'proposed' | 'confirmed';
  readonly from: CardPage;
  readonly to: CardPage;
  /** The measures that proposed it, strongest first. */
  readonly evidence: Array<{ measure: string; value: number }>;
  /** For a conflict: the heading and the figures each page gives, when its blocks still disagree. */
  readonly disagreement?: { heading: string; figures: { from: string; to: string } };
  /** The answers the card offers as the relation stands. */
  readonly offered: RelationDecision[];
}

/** The most cards of each kind one read of the tab draws. */
export const RELATION_CARDS_READ = 20;

/**
 * The most proposals one read of the tab looks through for the cards it draws: a proposal one of
 * whose pages is no longer current is passed over by a small row each, so such rows above a live
 * card do not hide it.
 */
const PROPOSALS_READ = 5 * RELATION_CARDS_READ;

/**
 * The most page bytes the cards' read draws, counted at three bytes a character (the most UTF-8
 * takes): a card reads its two pages' rows, which carry their whole Markdown, so the cards are
 * drawn while their pages fit one query's read and the rest once those are answered.
 */
export const CARD_PAGES_BYTES = 8 * 1024 * 1024;

/** An upper bound on the bytes reading a page's row takes. */
function rowBytes(page: Doc<'docPages'> | null): number {
  return page === null ? 0 : 3 * (page.markdown.length + page.title.length);
}

/**
 * The relations the manager has still to answer: every proposed relation, and every confirmed
 * conflict that stands, newest first, at most `RELATION_CARDS_READ` of each and
 * `CARD_PAGES_BYTES` of their pages a read. Public; the caller's own. A relation one of whose
 * pages is gone or no longer current is not drawn (its source's unlink deletes it; a page that
 * came back draws it again). The confirmed conflicts are the ones the selection reads
 * (`confirmedConflicts`), so a conflict that holds a plan has its card. Writes nothing.
 */
export const listOpen = query({
  args: {},
  handler: async (ctx): Promise<RelationCardRow[]> => {
    const caller = await getCallerOrThrow(ctx);
    const [proposed, confirmed] = await Promise.all([
      ctx.db
        .query('docRelations')
        .withIndex('by_user_status', (q) =>
          q.eq('userId', caller.ownerKey).eq('status', 'proposed'),
        )
        .order('desc')
        .take(PROPOSALS_READ),
      confirmedConflicts(ctx, caller.ownerKey),
    ]);
    const cards: RelationCardRow[] = [];
    let bytes = 0;
    for (const relation of proposed) {
      if (cards.length >= RELATION_CARDS_READ) break;
      // By a small row first: a proposal whose page a block says is no longer current is passed
      // over for none of the read's page bytes. A page with no block is judged by its row, below.
      const statuses = await Promise.all(
        [relation.from, relation.to].map(
          async (page) => await firstBlockStatus(ctx.db, page.sourceId, page.ref),
        ),
      );
      if (statuses.some((status) => status !== undefined && status !== 'active')) continue;
      const disagreement =
        relation.kind === 'possible_conflict' ? await disagreementOf(ctx, relation) : undefined;
      if (relation.kind === 'possible_conflict' && disagreement === undefined) continue;
      const [from, to, fromSource, toSource] = await Promise.all([
        pageAt(ctx, relation.from),
        pageAt(ctx, relation.to),
        ctx.db.get(relation.from.sourceId),
        ctx.db.get(relation.to.sourceId),
      ]);
      bytes += rowBytes(from) + rowBytes(to);
      if (bytes > CARD_PAGES_BYTES) return cards;
      if (from === null || to === null || fromSource === null || toSource === null) continue;
      if (pageStatusOf(from) !== 'active' || pageStatusOf(to) !== 'active') continue;
      cards.push({
        _id: relation._id,
        kind: relation.kind,
        status: 'proposed',
        from: cardPage(from, fromSource),
        to: cardPage(to, toSource),
        evidence: relation.evidence.map(({ measure, value }) => ({ measure, value })),
        ...(disagreement !== undefined ? { disagreement } : {}),
        offered: [
          ...decisionsOffered(
            relation,
            authorityOf(from, fromSource) === authorityOf(to, toSource),
          ),
        ],
      });
    }
    const proposedCards = cards.length;
    for (const relation of confirmed) {
      if (cards.length >= proposedCards + RELATION_CARDS_READ) break;
      // Its blocks first, then its two pages, each read once and counted once.
      const standing = await standingWithPages(ctx, relation);
      if (standing === undefined) continue;
      bytes += rowBytes(standing.from) + rowBytes(standing.to);
      if (bytes > CARD_PAGES_BYTES) return cards;
      const { conflict } = standing;
      cards.push({
        _id: relation._id,
        kind: relation.kind,
        status: 'confirmed',
        from: { ...conflict.from, updatedAt: standing.from.updatedAt, authority: standing.trust },
        to: { ...conflict.to, updatedAt: standing.to.updatedAt, authority: standing.trust },
        evidence: relation.evidence.map(({ measure, value }) => ({ measure, value })),
        disagreement: { heading: conflict.heading, figures: conflict.figures },
        offered: [...decisionsOffered(relation)],
      });
    }
    return cards;
  },
});

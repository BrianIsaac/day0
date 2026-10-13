import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { RELATIONS_OF_A_PAGE } from './docStatus';
import type { PageStatus } from '../src/docs/authority';
import { MAX_BLOCKS_PER_PAGE, blockSearchQuery } from '../src/docs/blocks';
import { frontMatterStatus } from '../src/docs/status';
import {
  RELATION_CANDIDATES_PER_PAGE,
  headingFigures,
  type MeasuredBlock,
  type MeasuredPage,
  type ProposedRelation,
} from '../src/docs/relations';

/*
 * The proposals a finishing sync writes (wave 15, 15-A; split out of `convex/docRelations.ts` by
 * wave 16's 16-s, decision D-8): a stored page as the measures read it, the owner's other pages
 * it may relate to, whether a pair already holds the relation a proposal would write, what a
 * conflict's two pages say under the blocks its evidence names, the runs whose pages a completed
 * sync measures, and the proposals a page its source dropped leaves behind (`forgetProposalsOf`,
 * called by `docSources.prunePages`). The registered functions that call the rest
 * (`measurePage`, `generationsToMeasure`, `measuringPlan`) stay in `convex/docRelations.ts` under
 * their paths.
 *
 * This module sits below `convex/docRelations.ts` and `convex/docConflicts.ts`, and imports
 * nothing of `docSources` or of anything that reaches `work`.
 */

/** A page's name within its owner's documentation. */
export interface PageName {
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

/**
 * The most of a page's own blocks its search in its own source passes over before the
 * `CANDIDATE_BLOCKS_PER_SOURCE` it keeps: a page's own text answers its title and headings best,
 * so in its own source its blocks took every place and a copy beside it was never measured
 * (found on the 16-FD bed: the company folder's team copy of the tile runbook).
 */
const OWN_BLOCKS_PASSED = 16;

/** The most pages a page's front matter may name that are looked up by name. */
const NAMED_PAGES = 4;

/** A page's key for the measures: its source and ref. */
function keyOf(page: PageName): string {
  return `${page.sourceId}:${page.ref}`;
}

/** A stored page of a source, by its ref. */
export async function pageAt(ctx: QueryCtx, name: PageName): Promise<Doc<'docPages'> | null> {
  return await ctx.db
    .query('docPages')
    .withIndex('by_source_ref', (q) => q.eq('sourceId', name.sourceId).eq('ref', name.ref))
    .unique();
}

/**
 * Whether a source holds a page under a ref that the measures can read: its first block, one small
 * row. The test that a page a front matter names exists, which read the page's whole row from
 * every source it looked in (W15-R20; the review's R2-K, 32 sources each holding a 700 KB
 * `readme.md`, threw the measure over the read limit). A block, not the page's listing row: a
 * page its source lists and Day0 could not store has a listing and nothing to measure, and would
 * take one of a page's three candidates for nothing (the second pass). A stored page of headings
 * alone has no block, shares no text and is no candidate either.
 */
async function holdsBlocks(ctx: QueryCtx, name: PageName): Promise<boolean> {
  const first = await ctx.db
    .query('docBlocks')
    .withIndex('by_source_page', (q) => q.eq('sourceId', name.sourceId).eq('pageRef', name.ref))
    .first();
  return first !== null;
}

/**
 * The kinds of source whose reader gives no edit time: a page's time is when it was read (a list
 * of URLs, an MCP server), or when a fresh checkout wrote its file (git), so it dates no successor
 * and its card says "last read". The rule for a page stored before 0.21.0, whose row does not say
 * which its time is ({@link editedAtSource}).
 */
export const KINDS_WITHOUT_EDIT_TIME: ReadonlySet<Doc<'docSources'>['kind']> = new Set([
  'urls',
  'mcp',
  'git',
]);

/**
 * Whether a stored page's time is when its source says it was edited (wave 17, 17-FD; D-8 (a)):
 * what its row says (`datedBySource`, the reader's own word, false where it fell back to the time
 * it read the page; a folder's file time counts as its source's, X-3), and for a row that does
 * not say, the rule by its source's kind. Only an edit time dates a successor, and a card says
 * "edited" of nothing else.
 */
export function editedAtSource(
  page: Pick<Doc<'docPages'>, 'datedBySource'>,
  source: Pick<Doc<'docSources'>, 'kind'>,
): boolean {
  return page.datedBySource ?? !KINDS_WITHOUT_EDIT_TIME.has(source.kind);
}

/**
 * A stored page as the measures read it, with its blocks in document order.
 *
 * @param source - The page's source: whether its reader gives an edit time, for a page whose
 *   row does not say (RM19 (a); {@link editedAtSource}).
 */
export async function measured(
  ctx: QueryCtx,
  page: Doc<'docPages'>,
  source: Pick<Doc<'docSources'>, 'kind'>,
): Promise<MeasuredPage> {
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
    edited: editedAtSource(page, source),
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
export async function candidatesOf(
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
        if (await holdsBlocks(ctx, { sourceId: source._id, ref })) {
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
      owner.sources.map(async (source) => {
        const own = source._id === page.sourceId;
        const rows = await ctx.db
          .query('docBlocks')
          .withSearchIndex('by_text', (q) =>
            q
              .search('searchText', text)
              .eq('userId', owner.userId)
              .eq('sourceId', source._id)
              .eq('status', 'active'),
          )
          .take(CANDIDATE_BLOCKS_PER_SOURCE + (own ? OWN_BLOCKS_PASSED : 0));
        return rows
          .filter((row) => !own || row.pageRef !== page.ref)
          .slice(0, CANDIDATE_BLOCKS_PER_SOURCE);
      }),
    );
    for (const row of answers.flat()) hit({ sourceId: row.sourceId, ref: row.pageRef }, 1);
  }
  return [...found.values()]
    .sort((left, right) => right.hits - left.hits)
    .slice(0, RELATION_CANDIDATES_PER_PAGE)
    .map((entry) => entry.name);
}

/** The relations between two pages, in either direction. */
export async function relationsBetween(
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

/** Whether a proposal's or a relation's evidence holds a page's front matter naming the other. */
function namesSuccessor(relation: {
  readonly evidence: ReadonlyArray<{ readonly measure: string }>;
}): boolean {
  return relation.evidence.some((entry) => entry.measure === 'names-successor');
}

/** Whether a relation was proposed as a successor by its pages' edit dates alone (RM19 (a)). */
function datedSuccessor(relation: Pick<Doc<'docRelations'>, 'kind' | 'evidence'>): boolean {
  const measures = new Set(relation.evidence.map((entry) => entry.measure));
  return (
    relation.kind === 'possible_successor' &&
    measures.has('edit-dates') &&
    !measures.has('names-successor') &&
    !measures.has('title-version')
  );
}

/** The block hashes a conflict's evidence names. */
export function conflictBlocks(relation: Pick<Doc<'docRelations'>, 'evidence'>): string[] {
  return relation.evidence.find((entry) => entry.measure === 'heading-figures')?.blockRefs ?? [];
}

/**
 * Whether a pair already holds the relation a proposal would write, so it is not proposed again:
 * versions of one document (a duplicate or a successor) once, whatever the manager decided, but
 * for a duplicate nobody answered, which gives way to a successor the measures now find (RM19
 * (a): a copy its source dated later, measured again by the remeasure, is deleted here and
 * proposed as the successor), for a successor nobody answered that rested on the pages' dates
 * alone, which gives way to the duplicate the measures find once a page is known to be dated by
 * the time it was read (D-8 (a)), and for an answer of "Not the same" or "Keep both" given before a
 * page's front matter named the other, which a successor so named is proposed over (W15-R22); a
 * conflict while one is open or confirmed and its blocks still disagree, or was set aside over
 * the same blocks. A conflict the manager set aside is proposed again only when the blocks that
 * disagree are other blocks, which is to say a page changed. A conflict whose own blocks no
 * longer disagree is drawn on no card and holds nothing, so it stands in the way of no later one;
 * left unanswered, it is a proposal nobody can answer, and is deleted here. A duplicate of the
 * pair nobody answered goes when its conflict has, or is about to have, a card (the joins' W3d:
 * the tab drew two cards for one pair); where the conflict was set aside it stays, the pair's
 * one card.
 */
export async function alreadyHeld(
  ctx: MutationCtx,
  existing: readonly Doc<'docRelations'>[],
  proposed: ProposedRelation,
): Promise<boolean> {
  if (proposed.kind !== 'possible_conflict') {
    let held = false;
    for (const row of existing) {
      if (row.kind === 'possible_conflict') continue;
      if (
        proposed.kind === 'possible_successor' &&
        row.kind === 'possible_duplicate' &&
        row.status === 'proposed'
      ) {
        await ctx.db.delete(row._id);
        continue;
      }
      if (
        proposed.kind === 'possible_duplicate' &&
        row.status === 'proposed' &&
        datedSuccessor(row)
      ) {
        await ctx.db.delete(row._id);
        continue;
      }
      // A page's front matter that names the other since the manager answered is new word from
      // its author: "Not the same" or "Keep both" given without it is asked again (W15-R22).
      if (
        namesSuccessor(proposed) &&
        !namesSuccessor(row) &&
        row.status !== 'proposed' &&
        !(row.status === 'confirmed' && row.kind === 'possible_successor')
      ) {
        continue;
      }
      held = true;
    }
    return held;
  }
  const blocks = new Set(
    proposed.evidence.find((entry) => entry.measure === 'heading-figures')?.blockRefs ?? [],
  );
  let held = false;
  // Whether a conflict of the pair is drawn on a card as it stands.
  let drawn = false;
  for (const row of existing) {
    if (row.kind !== 'possible_conflict') continue;
    if (row.status === 'dismissed') {
      held ||= conflictBlocks(row).every((hash) => blocks.has(hash));
    } else if ((await disagreementOf(ctx, row)) !== undefined) {
      held = true;
      drawn = true;
    } else if (row.status === 'proposed') {
      await ctx.db.delete(row._id);
    }
  }
  if (!held || drawn) {
    for (const row of existing) {
      if (row.kind === 'possible_duplicate' && row.status === 'proposed') {
        await ctx.db.delete(row._id);
      }
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
export function named(page: Doc<'docPages'>, source: Doc<'docSources'>): NamedPage {
  return { sourceId: page.sourceId, ref: page.ref, title: page.title, source: source.label };
}

/** The most runs a sync measures the pages of: itself and those before it back to a complete walk. */
const GENERATIONS_MEASURED = 6;

/**
 * The runs whose pages a completed sync measures: its own, and every run of the source before it
 * back to (and with) the complete walk before it, newest first. A resumed sync stored its first
 * pages under the run it took over, and a page whose split landed after its sync's measure is
 * reached by the next sync's: both are covered this way, and a pair measured twice is proposed
 * once. Reads a few run rows.
 */
export async function generationsOf(
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
export async function disagreementOf(
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

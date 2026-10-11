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
 * conflict's two pages say under the blocks its evidence names, and the runs whose pages a
 * completed sync measures. The registered functions that call these (`measurePage`,
 * `generationsToMeasure`, `measuringPlan`) stay in `convex/docRelations.ts` under their paths.
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

/** A stored page as the measures read it, with its blocks in document order. */
export async function measured(ctx: QueryCtx, page: Doc<'docPages'>): Promise<MeasuredPage> {
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

/** The block hashes a conflict's evidence names. */
export function conflictBlocks(relation: Pick<Doc<'docRelations'>, 'evidence'>): string[] {
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
export async function alreadyHeld(
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

import { v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { editedAtSource } from '../src/docs/relations';

/*
 * The existing library measured once by the dated successor (wave 16, 16-FD; RM19 (a), K-3): the
 * `docs-relations-remeasure` pass marks every source that stores a page owed the measure from its
 * start (`docSources.relationsRemeasure`); a completed sync's measuring, once its own pages are
 * measured, measures the source's stored pages from that mark a bounded read at a time
 * (`docSyncActions.proposeRelations`), writing back how far it reached, and clears the mark at the
 * end. The measure is a pair a transaction (`docRelations.measurePair`), as for a page a sync
 * stores: a pair is proposed once, and only the manager's answer on its card changes a page.
 *
 * The mark is also set by a fill that changes what a kept page's row says of its time where a
 * proposal of the page rests on it (W17-R16, `remeasureAfterDating`), so a dated successor that
 * no longer holds goes at the next measure.
 *
 * This module sits below `convex/docRelations.ts` and `convex/docStatus.ts`, and imports nothing
 * of `docSources` or of anything that reaches `work`.
 */

/** One bounded read of a source's blocks, for the pages they belong to: under a query's limit. */
const REMEASURE_BLOCKS_READ = { numItems: 400, maximumBytesRead: 4 * 1024 * 1024 } as const;

/** Whether a run is the source's running or last completed one: a newer sync measures instead. */
function currentRun(source: Doc<'docSources'>, runId: Id<'docSyncRuns'>): boolean {
  return source.activeSyncId === runId || source.lastCompletedSyncId === runId;
}

/** The next pages the remeasure owes, from the place it reached. */
export interface PagesOwed {
  /** Where this read began: what is written back when the measuring stops inside it. */
  readonly cursor: string | null;
  /** The distinct page refs of this read, in the source's page order. */
  readonly refs: string[];
  /** Where the next read begins; null when this read reached the source's last page. */
  readonly next: string | null;
}

/**
 * The next bounded read of the pages a source owes the remeasure, by its blocks in page order
 * (`docBlocks.by_source_page`): small rows, so a read of pages of any length stays bounded. A
 * page whose blocks this read ends inside is read again at the next, and measured once. Internal;
 * reads the source and its blocks, writes nothing.
 *
 * @returns The read, or null when nothing is owed or the run is no longer the source's running
 *   or last completed one.
 */
export const pagesOwed = internalQuery({
  args: { sourceId: v.id('docSources'), runId: v.id('docSyncRuns') },
  handler: async (ctx, args): Promise<PagesOwed | null> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null || source.relationsRemeasure === undefined) return null;
    if (!currentRun(source, args.runId)) return null;
    const { cursor } = source.relationsRemeasure;
    const read = await ctx.db
      .query('docBlocks')
      .withIndex('by_source_page', (q) => q.eq('sourceId', args.sourceId))
      .paginate({ ...REMEASURE_BLOCKS_READ, cursor });
    return {
      cursor,
      refs: [...new Set(read.page.map((block) => block.pageRef))],
      next: read.isDone ? null : read.continueCursor,
    };
  },
});

/**
 * Record how far the remeasure reached, or that it reached the end. Internal; written only for
 * the source's running or last completed run, and only while the source is owed the remeasure,
 * so a measuring a newer sync has overtaken, or one that finished, changes nothing.
 */
export const settleRemeasure = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    /** Where the next measure begins; null when every page was measured. */
    owed: v.union(v.object({ cursor: v.union(v.string(), v.null()) }), v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null || source.relationsRemeasure === undefined) return null;
    if (!currentRun(source, args.runId)) return null;
    await ctx.db.patch(source._id, { relationsRemeasure: args.owed ?? undefined });
    return null;
  },
});

/**
 * The most relations of a page, each way, a dating fill reads to tell whether a proposal rests on
 * the page's time: a page's relations are bounded by `docStatus.RELATIONS_OF_A_PAGE`, which this
 * module cannot import (`docStatus` imports it).
 */
const DATING_RELATIONS_READ = 32;

/**
 * Mark a page's source owed the remeasure when a fill changes what the page's row says of its
 * time and an unanswered proposal of the page rests on its time (W17-R16): a successor proposed
 * by the pages' edit dates, or a duplicate a successor would now replace. The K-2 fill wrote the
 * field and nothing else, and a kept page is never measured again, so a 0.20.0 dated successor
 * whose page turned out dated by its read stood beside a card saying "last read". At the next
 * measure the pair is measured again and the proposal gives way (`alreadyHeld`).
 *
 * Its cost, where it marks: while a source is owed the remeasure its pages are not kept by their
 * revision and a page kept by its hash is checked block for block (as for a library v0.19.0
 * left), until the measuring that follows the sync clears the mark. A fill that leaves the answer
 * as the kind gave it, or a page with no such proposal, marks nothing.
 *
 * @param ctx - The filling mutation's context.
 * @param source - The page's source as the mutation read it.
 * @param page - The page's row before the fill.
 * @param datedBySource - What the fill writes.
 * @returns Whether the source was marked.
 */
export async function remeasureAfterDating(
  ctx: MutationCtx,
  source: Doc<'docSources'>,
  page: Pick<Doc<'docPages'>, 'sourceId' | 'ref' | 'datedBySource'>,
  datedBySource: boolean,
): Promise<boolean> {
  if (editedAtSource(page, source) === editedAtSource({ datedBySource }, source)) return false;
  if (source.relationsRemeasure !== undefined) return false;
  const [from, to] = await Promise.all([
    ctx.db
      .query('docRelations')
      .withIndex('by_from', (q) => q.eq('from.sourceId', page.sourceId).eq('from.ref', page.ref))
      .take(DATING_RELATIONS_READ),
    ctx.db
      .query('docRelations')
      .withIndex('by_to', (q) => q.eq('to.sourceId', page.sourceId).eq('to.ref', page.ref))
      .take(DATING_RELATIONS_READ),
  ]);
  const restsOnTime = [...from, ...to].some(
    (relation) =>
      relation.status === 'proposed' &&
      (relation.kind === 'possible_duplicate' ||
        (relation.kind === 'possible_successor' &&
          relation.evidence.some((entry) => entry.measure === 'edit-dates'))),
  );
  if (!restsOnTime) return false;
  await ctx.db.patch(source._id, { relationsRemeasure: { cursor: null } });
  return true;
}

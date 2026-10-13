import type { QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import {
  conflictBlocks,
  disagreementOf,
  named,
  pageAt,
  type NamedPage,
} from './docRelationProposals';
import { eventsOfType } from './eventLog';
import { log } from '../src/lib/logger';
import { agentReadsSource } from '../src/docs/agent-sources';
import { isEventOf } from '../src/events/contract';
import { pageStatusOf, sourceAuthorityOf, type SourceAuthority } from '../src/docs/authority';
import { planLeansOn } from '../src/work/conflict-hold';
import type { CiteConflict, ExecutionPlan, PlanCite } from '../src/work/types';

/*
 * The standing conflict (wave 15, 15-A; split out of `convex/docRelations.ts` by wave 16's 16-s,
 * decision D-8): a confirmed conflict between two active pages of equal trust whose blocks still
 * disagree, read by the selection (which tags the cites of its blocks), by the plan's decision
 * (which asks which page is right beside a plan that rests on one, 16-O) and by the cards; and the
 * answers a relation's card offers as the relation stands. The registered functions that answer and draw the cards (`decide`,
 * `listOpen`) stay in `convex/docRelations.ts` under their paths.
 *
 * This module sits below `convex/docRelations.ts` and `convex/work.ts`, above
 * `convex/docRelationProposals.ts`, and imports nothing of `docSources` or of anything that
 * reaches `work`.
 */

/** A source's trust as it bears on one of its pages: the page's own, when the manager set one. */
export function authorityOf(page: Doc<'docPages'>, source: Doc<'docSources'>): SourceAuthority {
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

/**
 * A relation as a conflict that stands, or undefined: the manager confirmed it, both its pages
 * are stored and active, their trust is equal (official over team over personal settles a
 * disagreement between unequal pages by itself), and the blocks its evidence names still
 * disagree. Read by the selection, which tags the cites of those blocks, and by the plan's
 * decision, which asks which page is right beside a plan that rests on one.
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
export async function standingWithPages(
  ctx: QueryCtx,
  relation: Doc<'docRelations'> | null,
): Promise<
  | {
      /** The relation's row, as the card draws its evidence and answers. */
      relation: Doc<'docRelations'>;
      conflict: StandingConflict;
      from: Doc<'docPages'>;
      to: Doc<'docPages'>;
      fromSource: Doc<'docSources'>;
      toSource: Doc<'docSources'>;
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
    relation,
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
    fromSource,
    toSource,
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
 * page is right stays among them, and stands again if that page is made current again; so the
 * newest {@link CONFIRMED_CONFLICTS_READ} are not all of them for an owner with more, and a
 * reader that must not miss an older one reads on by the pages it carries
 * ({@link standingConflictsOn}) or by page ({@link standingConflictsFrom}; W15-R19).
 *
 * @param before - Read only the conflicts confirmed-row-created before this time; the cursor a
 *   paged walk continues from.
 */
export async function confirmedConflicts(
  ctx: QueryCtx,
  userId: string,
  before?: number,
): Promise<Doc<'docRelations'>[]> {
  return await ctx.db
    .query('docRelations')
    .withIndex('by_user_kind_status', (q) => {
      const confirmed = q
        .eq('userId', userId)
        .eq('kind', 'possible_conflict')
        .eq('status', 'confirmed');
      return before === undefined ? confirmed : confirmed.lt('_creationTime', before);
    })
    .order('desc')
    .take(CONFIRMED_CONFLICTS_READ);
}

/** A page a reader carries: where its confirmed conflicts are read from, by either end. */
export interface CarriedPage {
  readonly sourceId: Id<'docSources'>;
  readonly ref: string;
}

/** The confirmed conflicts read from or to one page: a pair holds one, a page a handful. */
const CONFLICTS_OF_A_PAGE = 32;

/**
 * The most carried pages whose conflicts one read looks up, two small index reads a page: a plan
 * cites a few pages and a selection's candidates come from some dozens.
 */
export const CARRIED_PAGES_READ = 64;

/**
 * The owner's confirmed conflicts that one of the given pages is an end of, each once (W15-R19):
 * read by the page, so how many conflicts the owner has confirmed and settled since never hides
 * one. The index names the page; the kind and the status are read off the rows it gives.
 */
export async function confirmedConflictsOfPages(
  ctx: QueryCtx,
  userId: string,
  pages: readonly CarriedPage[],
): Promise<Doc<'docRelations'>[]> {
  const distinct = [
    ...new Map(pages.map((page) => [`${page.sourceId}\n${page.ref}`, page])).values(),
  ];
  if (distinct.length > CARRIED_PAGES_READ) {
    log.warn('conflicts read in part', {
      reason: 'more carried pages than one read looks up',
      pages: distinct.length,
      read: CARRIED_PAGES_READ,
    });
  }
  const confirmedOf = (
    index: 'by_from' | 'by_to',
    page: CarriedPage,
  ): Promise<Doc<'docRelations'>[]> =>
    ctx.db
      .query('docRelations')
      .withIndex(index, (q) =>
        index === 'by_from'
          ? q.eq('from.sourceId', page.sourceId).eq('from.ref', page.ref)
          : q.eq('to.sourceId', page.sourceId).eq('to.ref', page.ref),
      )
      .filter((q) =>
        q.and(q.eq(q.field('kind'), 'possible_conflict'), q.eq(q.field('status'), 'confirmed')),
      )
      .take(CONFLICTS_OF_A_PAGE);
  const found = await Promise.all(
    distinct
      .slice(0, CARRIED_PAGES_READ)
      .flatMap((page) => [confirmedOf('by_from', page), confirmedOf('by_to', page)]),
  );
  return [
    ...new Map(
      found
        .flat()
        .filter((relation) => relation.userId === userId)
        .map((relation) => [relation._id, relation]),
    ).values(),
  ];
}

/**
 * The owner's confirmed conflicts whose evidence names any of the given block hashes and that
 * stand (`standingConflictOf`), each relation once: what the selection tags and what a plan's
 * question asks about. The relation rows are read first, and a conflict's pages only when one of
 * its blocks is among those asked about, so a reader that meets no conflict reads no page for it.
 *
 * The owner's newest confirmed conflicts are read in one range, which is all of them for all but
 * an owner with more than {@link CONFIRMED_CONFLICTS_READ}; for that owner the conflicts of the
 * pages the reader carries are read as well, by the page (W15-R19: an older standing conflict
 * behind five hundred and twelve settled ones was not read). Two conflicts that share a block are
 * both given (17-C: keyed by hash, the second was neither tagged, asked nor held).
 *
 * @param ctx - The reader's query context.
 * @param userId - The owner's key.
 * @param hashes - The hashes of the blocks the reader may carry.
 * @param carried - The pages those blocks are of, asked for only when the owner's window is full.
 * @param bytesMost - The page bytes one read draws before it stops with what it has
 *   ({@link CONFLICT_WALK_BYTES}): a standing conflict's two page rows are read whole.
 */
export async function standingConflictsOn(
  ctx: QueryCtx,
  userId: string,
  hashes: ReadonlySet<string>,
  carried: () => Promise<readonly CarriedPage[]> | readonly CarriedPage[],
  bytesMost: number = CONFLICT_WALK_BYTES,
): Promise<StandingConflict[]> {
  if (hashes.size === 0) return [];
  const newest = await confirmedConflicts(ctx, userId);
  const relations = new Map(newest.map((relation) => [relation._id, relation]));
  if (newest.length >= CONFIRMED_CONFLICTS_READ) {
    for (const relation of await confirmedConflictsOfPages(ctx, userId, await carried())) {
      relations.set(relation._id, relation);
    }
  }
  const standing: StandingConflict[] = [];
  let bytes = 0;
  for (const relation of relations.values()) {
    if (!conflictBlocks(relation).some((hash) => hashes.has(hash))) continue;
    const found = await standingWithPages(ctx, relation);
    if (found === undefined) continue;
    standing.push(found.conflict);
    // Each standing conflict cost its two page rows whole: past the bound the rest are left
    // untagged and unasked by this read, and the record says the read was in part.
    bytes += rowBytes(found.from) + rowBytes(found.to);
    if (bytes > bytesMost) {
      log.warn('conflicts read in part', {
        reason: 'the conflicts on the blocks carried pass one read’s byte bound',
        read: standing.length,
      });
      break;
    }
  }
  return standing;
}

/** A standing conflict with the two page rows it read, as {@link standingWithPages} gives it. */
export type StandingWithPages = NonNullable<Awaited<ReturnType<typeof standingWithPages>>>;

/**
 * The most block lookups one walk of the owner's confirmed conflicts makes: a conflict that no
 * longer stands costs two index reads a block it names before it is passed over, and a
 * transaction reads 4,096 index ranges at most (W15-R19's R2-F: five hundred and twelve settled
 * conflicts of four blocks each failed the cards' query).
 */
export const CONFLICT_WALK_LOOKUPS = 2_400;

/**
 * The most page bytes one walk draws, counted at three bytes a character (the most UTF-8 takes):
 * a standing conflict's two page rows carry their whole Markdown.
 */
export const CONFLICT_WALK_BYTES = 8 * 1024 * 1024;

/** An upper bound on the bytes reading a page's row takes. */
function rowBytes(page: Doc<'docPages'>): number {
  return 3 * (page.markdown.length + page.title.length);
}

/**
 * The owner's standing conflicts, newest first, read by page from a cursor (W15-R19): what the
 * cards draw and what a plan that read the whole mirror is asked about. A walk stops when it has
 * `most`, when it has made {@link CONFLICT_WALK_LOOKUPS} block lookups or drawn `bytes` of page
 * rows, or at the end of the owner's confirmed conflicts; `next` is where a later read goes on
 * from, and null only at the end, so nothing behind a run of settled conflicts is lost for good.
 *
 * @param ctx - The reader's query context.
 * @param userId - The owner's key.
 * @param walk - Where to start (`before`, a `next` an earlier walk gave), how many are enough,
 *   the byte bound, and a test that passes over a relation for no read at all (`reads`).
 */
export async function standingConflictsFrom(
  ctx: QueryCtx,
  userId: string,
  walk: {
    readonly before?: number;
    readonly most: number;
    readonly bytes?: number;
    readonly reads?: (relation: Doc<'docRelations'>) => boolean;
  },
): Promise<{ standing: StandingWithPages[]; next: number | null }> {
  const standing: StandingWithPages[] = [];
  const bytesMost = walk.bytes ?? CONFLICT_WALK_BYTES;
  let lookups = 0;
  let bytes = 0;
  let before = walk.before;
  for (;;) {
    const page = await confirmedConflicts(ctx, userId, before);
    for (const relation of page) {
      if (standing.length >= walk.most) return { standing, next: before ?? null };
      if (walk.reads === undefined || walk.reads(relation)) {
        // Each block is looked up under both pages (`disagreementOf`).
        lookups += 2 * conflictBlocks(relation).length;
        if (lookups > CONFLICT_WALK_LOOKUPS) return { standing, next: before ?? null };
        const found = await standingWithPages(ctx, relation);
        if (found !== undefined) {
          bytes += rowBytes(found.from) + rowBytes(found.to);
          // The rows that pass the bound are read already; the next walk begins with them.
          if (bytes > bytesMost && standing.length > 0) return { standing, next: before ?? null };
          standing.push(found);
        }
      }
      before = relation._creationTime;
    }
    if (page.length < CONFIRMED_CONFLICTS_READ) return { standing, next: null };
  }
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

/** The selections of an employee one read looks through for a plan's own (as `docSelection`'s). */
const PLAN_SELECTIONS_READ = 64;

/** The blocks of one selection a conflict read takes: the selection's own bound. */
const SELECTED_BLOCKS_READ = 512;

/** The plan cites' conflicts that still stand, each relation once. */
async function standingCitedConflicts(ctx: QueryCtx, plan: unknown): Promise<CiteConflict[]> {
  const cites =
    typeof plan === 'object' && plan !== null && 'cites' in plan && Array.isArray(plan.cites)
      ? (plan.cites as ReadonlyArray<Pick<PlanCite, 'conflict'>>)
      : [];
  const found: CiteConflict[] = [];
  for (const id of new Set(
    cites.flatMap((cite) => (cite.conflict ? [cite.conflict.relationId] : [])),
  )) {
    const relationId = ctx.db.normalizeId('docRelations', id);
    const standing =
      relationId === null ? undefined : await standingConflictOf(ctx, await ctx.db.get(relationId));
    if (standing !== undefined) found.push(citeConflictOf(standing));
  }
  return found;
}

/**
 * What an item's newest plan-site selection was, by the employee's newest records of each kind:
 * the blocks it named, or that it failed and the planner read the whole mirror; undefined when
 * neither record is left among the newest. A failure newer than the newest selection wins, so a
 * redraft whose selection failed is read as the whole mirror and not as the earlier draft's
 * selection (W16-R11, probes P2 and P3).
 *
 * @param ctx - The query context.
 * @param row - The work item.
 * @param read - How many of the newest records of each kind are looked through; the decision's
 *   own window unless the upgrade's pass, which looks further back, says otherwise.
 */
export async function planSelectionOf(
  ctx: QueryCtx,
  row: Pick<Doc<'workItems'>, '_id' | 'agentId'>,
  read: number = PLAN_SELECTIONS_READ,
): Promise<{ readonly blockIds: string[] } | 'fell-back' | undefined> {
  const [selections, failures] = await Promise.all([
    eventsOfType(ctx, row.agentId, 'work.documentation-selected').order('desc').take(read),
    eventsOfType(ctx, row.agentId, 'work.documentation-selection-failed').order('desc').take(read),
  ]);
  const selected = selections.find(
    (event) =>
      isEventOf(event, 'work.documentation-selected') &&
      event.payload.workItemId === row._id &&
      event.payload.site === 'plan',
  );
  const failed = failures.find(
    (event) =>
      isEventOf(event, 'work.documentation-selection-failed') &&
      event.payload.workItemId === row._id &&
      event.payload.site === 'plan',
  );
  if (
    failed !== undefined &&
    (selected === undefined || failed._creationTime > selected._creationTime)
  ) {
    return 'fell-back';
  }
  return selected !== undefined && isEventOf(selected, 'work.documentation-selected')
    ? { blockIds: [...selected.payload.blockIds] }
    : undefined;
}

/** The blocks a plan relies on: their hashes, and their ids, by which their pages are found. */
interface PlanBlocks {
  readonly hashes: Set<string>;
  /** The pages the blocks are of, where the plan's cites name them. */
  readonly pages: CarriedPage[];
  /** The `docBlocks` ids of the blocks whose page no cite names. */
  readonly blockIds: string[];
}

/**
 * The pages a set of blocks is of, read off the blocks' own rows: asked for only by an owner with
 * more confirmed conflicts than one read takes ({@link standingConflictsOn}).
 */
async function pagesOfBlocks(ctx: QueryCtx, blocks: PlanBlocks): Promise<CarriedPage[]> {
  const pages = [...blocks.pages];
  for (const id of blocks.blockIds.slice(0, SELECTED_BLOCKS_READ)) {
    const blockId = ctx.db.normalizeId('docBlocks', id);
    const block = blockId === null ? null : await ctx.db.get(blockId);
    if (block !== null) pages.push({ sourceId: block.sourceId, ref: block.pageRef });
  }
  return pages;
}

/**
 * The blocks a plan relies on: its cited blocks, or, where it cites nothing, the blocks its
 * selection showed the planner: those kept on the item with their hashes
 * (`workItems.selectedBlocks`, W15-R17), or for an item selected before they were kept, the ones
 * its newest selection record names; `fell-back` when that selection failed and the planner read
 * the whole mirror; undefined when it cites nothing and no selection was kept or recorded.
 */
async function planBlocks(
  ctx: QueryCtx,
  row: Pick<Doc<'workItems'>, '_id' | 'agentId' | 'plan' | 'selectedBlocks'>,
): Promise<PlanBlocks | 'fell-back' | undefined> {
  const cites = (
    row.plan as
      | { cites?: ReadonlyArray<Pick<PlanCite, 'blocks' | 'sourceId' | 'pageRef'>> }
      | null
      | undefined
  )?.cites;
  const hashes = new Set<string>();
  const pages: CarriedPage[] = [];
  const blockIds: string[] = [];
  if (Array.isArray(cites) && cites.length > 0) {
    for (const cite of cites) {
      const sourceId =
        cite.sourceId === undefined ? null : ctx.db.normalizeId('docSources', cite.sourceId);
      if (sourceId !== null && cite.pageRef !== undefined) {
        pages.push({ sourceId, ref: cite.pageRef });
      }
      for (const block of cite.blocks ?? []) {
        if (block.hash !== undefined) hashes.add(block.hash);
        // A cite from before it named its page is found by its blocks' own rows.
        if (sourceId === null || cite.pageRef === undefined) blockIds.push(block.id);
      }
    }
    return { hashes, pages, blockIds };
  }
  if (row.selectedBlocks !== undefined && row.selectedBlocks.length > 0) {
    const kept = row.selectedBlocks.slice(0, SELECTED_BLOCKS_READ);
    return {
      hashes: new Set(kept.map((block) => block.hash)),
      pages,
      blockIds: kept.map((block) => block.id),
    };
  }
  const selection = await planSelectionOf(ctx, row);
  if (selection === undefined || selection === 'fell-back') return selection;
  for (const id of selection.blockIds.slice(0, SELECTED_BLOCKS_READ)) {
    const blockId = ctx.db.normalizeId('docBlocks', id);
    const block = blockId === null ? null : await ctx.db.get(blockId);
    if (block === null) continue;
    hashes.add(block.hash);
    pages.push({ sourceId: block.sourceId, ref: block.pageRef });
  }
  return { hashes, pages, blockIds };
}

/**
 * The most conflicts a plan that read the whole mirror is asked about at one decision: each is a
 * question beside it, and a request shows three.
 */
const WHOLE_MIRROR_CONFLICTS = 32;

/**
 * Every conflict that stands on the blocks a plan relies on, whatever its cites were tagged when it
 * was drafted, each relation once (W15-R18's inputs, by block): its cited blocks; where it cites
 * nothing, the blocks its selection recorded; and where the selection could not be made and the
 * planner read the whole mirror, every conflict between two pages the employee reads. What a run
 * reads before it writes (D-4 (b)), and what a drafted plan's question asks about beside its own
 * tagged cites.
 *
 * @param ctx - The query context.
 * @param row - The work item, its plan as stored.
 * @param agent - The employee, for its owner and the sources it reads.
 */
export async function conflictsOnPlanBlocks(
  ctx: QueryCtx,
  row: Pick<Doc<'workItems'>, '_id' | 'agentId' | 'plan' | 'selectedBlocks'>,
  agent: Pick<Doc<'agents'>, 'userId' | 'excludedDocSourceIds'>,
): Promise<CiteConflict[]> {
  if (agent.userId === undefined) return [];
  const blocks = await planBlocks(ctx, row);
  if (blocks === undefined) return [];
  if (blocks !== 'fell-back') {
    return (
      await standingConflictsOn(
        ctx,
        agent.userId,
        blocks.hashes,
        async () => await pagesOfBlocks(ctx, blocks),
      )
    ).map(citeConflictOf);
  }
  // The whole mirror: every standing conflict between two pages the employee reads, walked by
  // page within the walk's bounds; a relation of a source it does not read costs no read at all.
  const walked = await standingConflictsFrom(ctx, agent.userId, {
    most: WHOLE_MIRROR_CONFLICTS,
    reads: (relation) =>
      agentReadsSource(agent, relation.from.sourceId) &&
      agentReadsSource(agent, relation.to.sourceId),
  });
  if (walked.next !== null) {
    log.warn('conflicts read in part', {
      reason: 'the whole mirror’s conflicts pass one read’s bounds',
      workItemId: row._id,
      read: walked.standing.length,
    });
  }
  return walked.standing.map((found) => citeConflictOf(found.conflict));
}

/**
 * Whether a plan's own words lean on a conflict (`planLeansOn`, D-1 (c)): the heading the pages
 * disagree under, or one page's title, named in its summary, steps or risk notes.
 *
 * @param plan - The work item's plan, as stored.
 * @param conflict - The conflict as a cite names it.
 */
export function planLeansOnConflict(plan: unknown, conflict: CiteConflict): boolean {
  if (typeof plan !== 'object' || plan === null) return false;
  return planLeansOn(plan as Partial<ExecutionPlan>, {
    heading: conflict.heading,
    titles: conflict.pages.map((page) => page.title),
  });
}

/**
 * The conflicts a drafted plan names in its own words and cites nowhere (D-1 (c)): those standing
 * on the blocks its selection showed the planner (`workItems.selectedBlocks`, each printed
 * `[conflict]`) that its words lean on. Read only for a plan with cites, since a plan that cites
 * nothing is asked about its whole selection already; an item selected before the blocks were kept
 * has none to read, and is asked by its cites alone. Read at a drafted plan's decision and, for an
 * approved plan, by the run before it writes (`managerQuestions.conflictConfirmedSince`).
 */
export async function conflictsLeanedOn(
  ctx: QueryCtx,
  row: Pick<Doc<'workItems'>, 'plan' | 'selectedBlocks'>,
  agent: Pick<Doc<'agents'>, 'userId'>,
): Promise<CiteConflict[]> {
  const cites = (row.plan as { cites?: readonly unknown[] } | null | undefined)?.cites;
  const kept = row.selectedBlocks ?? [];
  if (agent.userId === undefined || !Array.isArray(cites) || cites.length === 0) return [];
  if (kept.length === 0) return [];
  const shown = kept.slice(0, SELECTED_BLOCKS_READ);
  const blocks: PlanBlocks = {
    hashes: new Set(shown.map((block) => block.hash)),
    pages: [],
    blockIds: shown.map((block) => block.id),
  };
  return (
    await standingConflictsOn(
      ctx,
      agent.userId,
      blocks.hashes,
      async () => await pagesOfBlocks(ctx, blocks),
    )
  )
    .map(citeConflictOf)
    .filter((conflict) => planLeansOnConflict(row.plan, conflict));
}

/**
 * Every conflict that stands under a drafted plan, each relation once (W15-R18's three inputs,
 * D-4 (c)): the plan's own cites that carried a `conflict` tag, every conflict on the blocks it
 * relies on ({@link conflictsOnPlanBlocks}), so a conflict confirmed after the plan was drafted is
 * asked too, and every conflict it was shown and names in its own words without citing
 * ({@link conflictsLeanedOn}, D-1 (c)). What a drafted plan's question asks about
 * (`work.decidePlan`). It replaces wave 15's `citedConflictOf`, which read the first tagged cite
 * only, for a hold of the whole plan.
 *
 * @param ctx - The deciding mutation's context.
 * @param row - The work item, its plan as stored.
 * @param agent - The employee, for its owner and the sources it reads.
 */
export async function conflictsUnderPlan(
  ctx: QueryCtx,
  row: Pick<Doc<'workItems'>, '_id' | 'agentId' | 'plan' | 'selectedBlocks'>,
  agent: Pick<Doc<'agents'>, 'userId' | 'excludedDocSourceIds'>,
): Promise<CiteConflict[]> {
  const byRelation = new Map<string, CiteConflict>();
  for (const conflict of [
    ...(await standingCitedConflicts(ctx, row.plan)),
    ...(await conflictsOnPlanBlocks(ctx, row, agent)),
    ...(await conflictsLeanedOn(ctx, row, agent)),
  ]) {
    if (!byRelation.has(conflict.relationId)) byRelation.set(conflict.relationId, conflict);
  }
  return [...byRelation.values()];
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

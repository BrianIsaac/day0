import { ConvexError, v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { firstBlockStatus } from './docBlocks';
import {
  alreadyHeld,
  candidatesOf,
  disagreementOf,
  editedAtSource,
  generationsOf,
  measured,
  named,
  pageAt,
  relationsBetween,
  type NamedPage,
  type PageName,
} from './docRelationProposals';
import {
  RELATION_DECISIONS,
  authorityOf,
  confirmedConflictsOfPages,
  conflictsUnderPlan,
  decisionsOffered,
  standingConflictOf,
  standingConflictsFrom,
  type RelationDecision,
} from './docConflicts';
import { askConflictQuestion, standingCards } from './reorientation';
import { closeTalkOfCard } from './reorientationTalk';
import { closeQuestionsOnPage } from './questionCloses';
import { appendEvent } from './eventLog';
import { getCallerOrThrow, verifiedAddressOf } from './ownership';
import {
  decideByHand,
  readersOf,
  restatePage,
  stampStatusChanges,
  statusSourceOf,
  SUCCESSOR_NOT_CURRENT,
} from './docStatus';
import {
  pageStatusOf,
  type PageStatus,
  type RelationKind,
  type SourceAuthority,
  type StatusSource,
} from '../src/docs/authority';
import { measureRelation } from '../src/docs/relations';
import { approvedResultWords, conflictChoiceWords } from '../src/agent/reorientation-words';
import { isOpenQuestion } from '../src/agent/manager-questions';
import { storedPageReadBytes } from '../src/docs/blocks';
import { log } from '../src/lib/logger';

/*
 * Relations between stored pages (wave 15, 15-A; the wave file's section 6.2): the proposals a
 * finishing sync writes for the pages it stored or changed (`pageCandidates` and `measurePair`, a
 * pair a transaction since D-12 (a), over `src/docs/relations.ts`), and the manager's decision on
 * each (`decide`). A relation is confirmed on a card and never by code: a proposal changes no
 * page's status, holds no plan and tags no cite. A confirmed successor supersedes the older page
 * (`docStatus.restatePage`); a confirmed conflict between two active pages of equal trust stands
 * (`standingConflictOf`) until the manager says which page is right or that both hold.
 *
 * Its helpers sit below it by concern (wave 16, 16-s, decision D-8): the measures, candidates and
 * proposals at a sync in `convex/docRelationProposals.ts`, the standing conflict and the answers a
 * card offers in `convex/docConflicts.ts`. The cards' own helpers stay here beside `decide` and
 * `listOpen`, and every registered function keeps its path.
 *
 * This module imports nothing of `docSources` or of anything that reaches `work`.
 */

/**
 * The most a pair's measure reads of its two pages' rows and blocks, by `storedPageReadBytes`
 * (D-12 (b)): under a transaction's 16 MiB, with room for the relations it reads beside them. Two
 * pages each under the store's bound fit it; it stays as the pair's cheap first test, so a
 * candidate whose row, read already, says its read would pass the budget is passed over before
 * its blocks are read, and the log names it. Since D-12 (a) each pair is measured in a
 * transaction of its own (`measurePair`), so four pages that together passed the limit on 17-FD's
 * bed (its F3 with F9) are four pairs that each fit.
 */
const MEASURE_READ_BYTES = 12 * 1024 * 1024;

/** The log line of a candidate passed over at `MEASURE_READ_BYTES`. */
const CANDIDATE_PASSED_OVER =
  'documentation: a candidate page too large to measure here was passed over';

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

/** What one page's measure wrote, over the pairs it measured (`docSyncActions.measurePage`). */
export interface PageMeasure {
  /**
   * Whether the run is still the source's running or last completed one: false once a newer sync
   * has overtaken it, which measures instead, and the measuring stops.
   */
  readonly current: boolean;
  /** How many relations it proposed. */
  readonly proposed: number;
  /**
   * Whether its room ended it with candidates still unmeasured (W16-R34): the page is then
   * measured again, where it was once counted measured and its last candidates never met.
   */
  readonly cut: boolean;
  /** The candidates whose pair's measure threw, to be tried again (D-12 (a)). */
  readonly failed: readonly PageName[];
  /** The candidates passed over at `MEASURE_READ_BYTES` before their blocks were read. */
  readonly passedOver: readonly PageName[];
}

/** Whether a run is the source's running or last completed one: a newer sync measures instead. */
function measuresFor(source: Doc<'docSources'>, runId: Id<'docSyncRuns'>): boolean {
  return source.activeSyncId === runId || source.lastCompletedSyncId === runId;
}

/** The most of an owner's sources one page's candidates are looked for in. */
const CANDIDATE_SOURCES = 32;

/** A page's candidates, or that its run is no longer the one that measures. */
export type PageCandidates =
  | { readonly current: false }
  | { readonly current: true; readonly candidates: PageName[] };

const pageNameValidator = v.object({ sourceId: v.id('docSources'), ref: v.string() });

/**
 * The owner's other active pages one page a sync stored or changed is measured against
 * (`candidatesOf`): the first step of its measure, a transaction of its own (D-12 (a)), so a
 * candidate whose read breaks costs its own pair and not this. Internal; reads the page, its
 * blocks, the owner's sources and the search's answers; writes nothing.
 *
 * @returns Its candidates (none for a page that is gone or not current), or that the run is no
 *   longer its source's running or last completed one.
 */
export const pageCandidates = internalQuery({
  args: { sourceId: v.id('docSources'), syncRunId: v.id('docSyncRuns'), ref: v.string() },
  handler: async (ctx, args): Promise<PageCandidates> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null || !measuresFor(source, args.syncRunId)) return { current: false };
    const page = await pageAt(ctx, args);
    if (page === null || pageStatusOf(page) !== 'active') return { current: true, candidates: [] };
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (q) => q.eq('userId', source.userId))
      .take(CANDIDATE_SOURCES);
    const self = await measured(ctx, page, source);
    return {
      current: true,
      candidates: await candidatesOf(ctx, { userId: source.userId, sources }, page, self.blocks),
    };
  },
});

/** What one pair's measure did. */
export interface PairMeasure {
  /** As `PageMeasure.current`. */
  readonly current: boolean;
  /** Whether it proposed a relation. */
  readonly proposed: boolean;
  /** Whether the candidate was passed over at `MEASURE_READ_BYTES`. */
  readonly passedOver: boolean;
}

/**
 * Measure one page a sync stored or changed against one candidate (D-12 (a)), and write a
 * `proposed` relation where the measures relate them and the pair holds none yet. Internal; the
 * measuring's action calls it a pair at a time (`docSyncActions.measurePage`), fenced on the run
 * still being the source's newest (its last completed one, or the one running). Reads the two
 * pages, their blocks and the relations between them, in one transaction of its own: a page whose
 * read breaks throws the pairs that read it and no other, and the action names the pair. Writes
 * the relation and `documentation.relation-proposed` on the record of each employee that reads
 * either page; no page's status, no plan and no cite changes.
 */
export const measurePair = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    syncRunId: v.id('docSyncRuns'),
    ref: v.string(),
    candidate: pageNameValidator,
  },
  handler: async (ctx, args): Promise<PairMeasure> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null || !measuresFor(source, args.syncRunId)) {
      return { current: false, proposed: false, passedOver: false };
    }
    const nothing: PairMeasure = { current: true, proposed: false, passedOver: false };
    const page = await pageAt(ctx, args);
    if (page === null || pageStatusOf(page) !== 'active') return nothing;
    const otherSource = await ctx.db.get(args.candidate.sourceId);
    // An owner's pages are measured against the owner's own only.
    if (otherSource === null || otherSource.userId !== source.userId) return nothing;
    const other = await pageAt(ctx, args.candidate);
    if (other === null || pageStatusOf(other) !== 'active') return nothing;
    const own = storedPageReadBytes(page.markdown);
    const cost = storedPageReadBytes(other.markdown);
    if (own.row + own.blocks + cost.row + cost.blocks > MEASURE_READ_BYTES) {
      log.warn(CANDIDATE_PASSED_OVER, {
        sourceId: other.sourceId,
        ref: other.ref,
        bytes: cost.row + cost.blocks,
        budget: MEASURE_READ_BYTES,
        measuring: page.ref,
      });
      return { ...nothing, passedOver: true };
    }
    const self = await measured(ctx, page, source);
    const relation = measureRelation(self, await measured(ctx, other, otherSource));
    if (relation === undefined) return nothing;
    if (await alreadyHeld(ctx, await relationsBetween(ctx, page, other), relation)) return nothing;
    const now = Date.now();
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
    return { ...nothing, proposed: true };
  },
});

/** One bounded read of the blocks a generation wrote: under a query's read limit. */
const GENERATION_BLOCKS_READ = { numItems: 400, maximumBytesRead: 4 * 1024 * 1024 } as const;

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
 * stopped, then the runs of its own look-back that are not among those and wrote a block. A run
 * that stored no changed page wrote none, so it has nothing to measure and is never owed (wave
 * 15's pre-tag bed: a capped library gained a run id at every sync). Internal; reads the source,
 * a few run rows and one block of each.
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
    const own: Id<'docSyncRuns'>[] = [];
    for (const generation of await generationsOf(ctx, args.sourceId, args.runId)) {
      const written = await ctx.db
        .query('docBlocks')
        .withIndex('by_source_generation', (q) =>
          q.eq('sourceId', args.sourceId).eq('generation', generation),
        )
        .first();
      if (written !== null) own.push(generation);
    }
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

/** Why a decision was refused: the card it answers is no longer the relation's. */
export const DECISION_NOT_OFFERED = 'That card has changed: this answer is no longer offered.';

/** Why a reversed answer was refused: only a successor has a direction to turn. */
export const REVERSE_IS_FOR_SUPERSEDES = 'Only “supersedes” can be answered the other way round.';

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
    /**
     * "{A} supersedes {B}", the proposed direction turned round (W15-R45's remainder): the
     * measures name the later version by a date or a version word, which a reader that gives no
     * edit time or a copied folder gets wrong, and the card offered no way to say so.
     */
    reversed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SupersedeOutcome | null> => {
    const caller = await getCallerOrThrow(ctx);
    const stored = await ctx.db.get(args.relationId);
    if (stored === null) throw new ConvexError('That relation is no longer stored.');
    if (stored.userId !== caller.ownerKey) throw new Error('forbidden');
    let relation = stored;
    if (args.reversed === true) {
      if (args.decision !== 'supersedes') throw new ConvexError(REVERSE_IS_FOR_SUPERSEDES);
      // Written with the answer or not at all: a refusal below rolls the swap back with it.
      await ctx.db.patch(stored._id, { from: stored.to, to: stored.from, reversed: true });
      relation = { ...stored, from: stored.to, to: stored.from, reversed: true };
    }
    return await decideRelationInTransaction(ctx, relation, args.decision, {
      decidedBy: verifiedAddressOf(caller),
      via: 'dashboard',
    });
  },
});

/**
 * Answer a relation in the caller's transaction ({@link decide}; a conflict's question answered
 * beside a plan, on the card or in the plan's Slack request, 16-O): what `decide` writes and sets
 * off, with the manager's verified address when there is one, and where the answer came from,
 * which the relation's other open questions are closed as answered by (the walk's W-4).
 *
 * @throws ConvexError as {@link decide} refuses.
 */
export async function decideRelationInTransaction(
  ctx: MutationCtx,
  relation: Doc<'docRelations'>,
  decision: RelationDecision,
  by: { readonly decidedBy: string | undefined; readonly via: 'dashboard' | 'slack' },
): Promise<SupersedeOutcome | null> {
  const { decidedBy } = by;
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
  if (!decisionsOffered(relation, equalTrust).includes(decision)) {
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
    decision === 'supersedes' || decision === 'from-is-right'
      ? from
      : decision === 'to-is-right'
        ? to
        : null;
  if (successor !== null && pageStatusOf(successor) !== 'active') {
    throw new ConvexError(SUCCESSOR_NOT_CURRENT);
  }
  const now = Date.now();
  const answer = decided(decision);
  // The kind the relation has after the answer: an answer that changes it keeps the proposed
  // kind on the row, and "Undo" restores it (W15-R22).
  const kind =
    decision === 'undo' ? (relation.proposedKind ?? relation.kind) : (answer.kind ?? relation.kind);
  await ctx.db.patch(
    relation._id,
    decision === 'undo'
      ? {
          ...answer,
          kind,
          proposedKind: undefined,
          decidedBy: undefined,
          decidedAt: undefined,
          // An answer given the other way round is taken back with its turn: the card asks again
          // as the measures proposed it.
          ...(relation.reversed === true
            ? { from: relation.to, to: relation.from, reversed: undefined }
            : {}),
        }
      : {
          ...answer,
          ...(kind !== relation.kind
            ? { proposedKind: relation.proposedKind ?? relation.kind }
            : {}),
          ...(decidedBy !== undefined ? { decidedBy } : {}),
          decidedAt: now,
        },
  );
  if (from === null || to === null || fromSource === null || toSource === null) return null;
  // A successor confirmed, or one whose confirmation is taken back: the older page is restated.
  if (
    decision === 'supersedes' ||
    (decision === 'undo' && relation.kind === 'possible_successor')
  ) {
    const change = await restatePage(ctx, { source: toSource, page: to, now });
    await stampStatusChanges(ctx, toSource, [change], now);
  } else if (decision === 'from-is-right' || decision === 'to-is-right') {
    const [right, wrong, wrongSource] =
      decision === 'from-is-right' ? [from, to, toSource] : [to, from, fromSource];
    await decideByHand(ctx, {
      source: wrongSource,
      page: wrong,
      status: 'superseded',
      supersededBy: { sourceId: right.sourceId, ref: right.ref },
      decidedBy,
      now,
      opensCard: false,
    });
  }
  for (const agent of await readersOfEither(ctx, [fromSource, toSource])) {
    await appendEvent(ctx, {
      agentId: agent._id,
      type: 'documentation.relation-decided',
      payload: {
        relationId: relation._id,
        kind,
        decision: decision,
        from: named(from, fromSource),
        to: named(to, toSource),
      },
      createdAt: now,
    });
  }
  // A conflict confirmed asks which page is right beside every drafted plan citing either page
  // (section 3's conflict row: a question, never a card; D-4 (c)); a conflict settled here answers
  // the questions asked about it, so nothing waits on them (the second pass's B1).
  if (decision === 'disagree') await scheduleConfirmationAsks(ctx, relation);
  if (relation.kind === 'possible_conflict') {
    // Each page by its letter, title and source, as the question named them (W16-R12).
    const pages = [named(from, fromSource), named(to, toSource)] as const;
    const settled =
      decision === 'from-is-right'
        ? conflictChoiceWords('from', pages)
        : decision === 'to-is-right'
          ? conflictChoiceWords('to', pages)
          : decision === 'both-hold'
            ? conflictChoiceWords('both', pages)
            : undefined;
    if (settled !== undefined) {
      await answerConflictQuestions(ctx, relation._id, { text: settled, via: by.via }, now);
    }
  }
  // Naming one page right takes the other out of use, so every other conflict that page is an end
  // of stops standing with nobody having answered it: its questions are closed, not left open on
  // the plans that asked them (17-C). After the answers above, which this relation's own keep.
  if (decision === 'from-is-right' || decision === 'to-is-right') {
    await closeQuestionsOnPage(ctx, decision === 'from-is-right' ? to : from, now);
  }
  if (decision !== 'supersedes') return null;
  const older = (await ctx.db.get(to._id)) ?? to;
  return { older: pageStatusOf(older), by: statusSourceOf(older) };
}

/** The questions about one relation one settling reads: one a work item, few items a relation. */
const QUESTIONS_SETTLED_READ = 500;

/**
 * Answer every open question about a conflict the manager settled, in the card's words and by the
 * way the answer came, so no plan's steps wait on a question nobody can answer any more (16-O). A
 * question closed without an answer stays closed: it was not asked of the plan that stands (17-C).
 */
async function answerConflictQuestions(
  ctx: MutationCtx,
  relationId: Id<'docRelations'>,
  answer: { readonly text: string; readonly via: 'dashboard' | 'slack' },
  now: number,
): Promise<void> {
  const questions = await ctx.db
    .query('managerQuestions')
    .withIndex('by_relation', (q) => q.eq('relationId', relationId))
    .take(QUESTIONS_SETTLED_READ);
  for (const question of questions) {
    if (!isOpenQuestion(question)) continue;
    await ctx.db.patch(question._id, {
      answer: { text: answer.text, answeredAt: now, via: answer.via },
    });
  }
}

/** The drafted plans one step of a confirmation's asking looks through. */
const ASK_PLANS_PAGE = 10;

/**
 * Start asking a confirmed conflict's question beside the drafted plans that rest on it, out of
 * the transaction that confirmed it (17-C; the pre-tag's second pass: the confirmation read a
 * hundred drafted plans a reader, each through `conflictsUnderPlan`, inside `decide`). Schedules
 * the first step for the employees that read either page; with none, nothing.
 */
async function scheduleConfirmationAsks(
  ctx: MutationCtx,
  relation: Doc<'docRelations'>,
): Promise<void> {
  const [fromSource, toSource] = await Promise.all([
    ctx.db.get(relation.from.sourceId),
    ctx.db.get(relation.to.sourceId),
  ]);
  if (fromSource === null || toSource === null) return;
  const readers = (await readersOfEither(ctx, [fromSource, toSource])).map((agent) => agent._id);
  if (readers.length === 0) return;
  await ctx.scheduler.runAfter(0, internal.docRelations.askConfirmed, {
    relationId: relation._id,
    readers,
    cursor: null,
  });
}

/**
 * One step of asking a confirmed conflict's question beside the drafted plans that rest on it:
 * a page of the first reader's drafted plans, each read as its own decision reads it
 * (`conflictsUnderPlan`): by its cites, or where it cites nothing by its kept selection (W16-R9).
 * Matching the plans that cite either page missed a plan that cites nothing, which was then asked
 * nothing and stopped after its approval; and it asked a plan citing another passage of either
 * page, which its decision does not. Internal; scheduled by `decide` and by itself until every
 * reader's drafted plans are read. Writes the questions, their events and, for a plan whose
 * request is already out, the notice for its thread; nothing once the conflict no longer stands.
 */
export const askConfirmed = internalMutation({
  args: {
    relationId: v.id('docRelations'),
    /** The employees whose drafted plans are still to be read, the first being read now. */
    readers: v.array(v.id('agents')),
    /** Where in the first reader's drafted plans this step goes on from. */
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args): Promise<{ asked: number }> => {
    const [reader, ...rest] = args.readers;
    const relation = await ctx.db.get(args.relationId);
    if (reader === undefined || (await standingConflictOf(ctx, relation)) === undefined) {
      return { asked: 0 };
    }
    const agent = await ctx.db.get(reader);
    const drafted =
      agent === null
        ? { page: [], isDone: true, continueCursor: '' }
        : await ctx.db
            .query('workItems')
            .withIndex('by_agent_state', (q) => q.eq('agentId', reader).eq('state', 'plan-pending'))
            .paginate({ numItems: ASK_PLANS_PAGE, cursor: args.cursor });
    const now = Date.now();
    let asked = 0;
    for (const row of drafted.page) {
      if (agent === null) break;
      const conflict = (await conflictsUnderPlan(ctx, row, agent)).find(
        (under) => under.relationId === args.relationId,
      );
      if (conflict === undefined) continue;
      const questionId = await askConflictQuestion(ctx, {
        row,
        conflict: { ...conflict, relationId: args.relationId },
        now,
      });
      if (questionId !== null) asked += 1;
    }
    const next = drafted.isDone
      ? { readers: rest, cursor: null }
      : { readers: args.readers, cursor: drafted.continueCursor };
    if (next.readers.length > 0) {
      await ctx.scheduler.runAfter(0, internal.docRelations.askConfirmed, {
        relationId: args.relationId,
        ...next,
      });
    }
    return { asked };
  },
});

/** The pages one step of `turnPageQuestions` turns; the rest ride the next step. */
const QUESTION_TURN_PAGES = 4;

/**
 * Close, as no longer needed, the standing cards a page's leaving opened on its readers once the
 * page is current again (W17-R2, D-1 (a)): the card went on saying the page was archived, and
 * Approve of its proposal pinned the page to the manager. A card that rests on another page still
 * not current stays. Each closed card says why in its outcome and on the record, its talk closes
 * with it, and the plans it held are asked for their decision again: nothing they were drafted
 * under has moved.
 */
async function closeCardsOfReturnedPage(
  ctx: MutationCtx,
  source: Doc<'docSources'>,
  ref: string,
  now: number,
): Promise<void> {
  const page = await pageAt(ctx, { sourceId: source._id, ref });
  if (page === null || pageStatusOf(page) !== 'active') return;
  const isPage = (named: { sourceId: Id<'docSources'>; ref: string }): boolean =>
    named.sourceId === source._id && named.ref === ref;
  for (const agent of await readersOf(ctx, source)) {
    for (const card of await standingCards(ctx, agent._id)) {
      if (card.trigger !== 'page-status-changed' || !card.evidence.pageRefs.some(isPage)) continue;
      let stillOut = false;
      for (const other of card.evidence.pageRefs.filter((named) => !isPage(named))) {
        const row = await pageAt(ctx, other);
        if (row !== null && pageStatusOf(row) !== 'active') stillOut = true;
      }
      if (stillOut) continue;
      const outcome = approvedResultWords.pageBack(page.title);
      await ctx.db.patch(card._id, {
        status: 'dismissed',
        decidedAt: now,
        revisitAt: undefined,
        outcome: { summary: outcome },
      });
      await appendEvent(ctx, {
        agentId: agent._id,
        type: 'reorientation.dismissed',
        payload: { reorientationId: card._id, summary: card.triggerSummary, outcome },
        createdAt: now,
      });
      await closeTalkOfCard(ctx, card._id);
      for (const workItemId of card.blockingWork) {
        const row = await ctx.db.get(workItemId);
        if (row?.state !== 'plan-pending') continue;
        await ctx.scheduler.runAfter(0, internal.work.decidePlan, { workItemId, recovery: true });
      }
    }
  }
}

/**
 * Turn the conflict questions of pages whose status left `active` or came back to it, a few pages
 * a step (17-C's two lines for `docStatus`, which schedules it). A page that left closes every
 * open question about its confirmed conflicts as settled: none of them stands while the page is
 * not current, so nothing holds on them, and they read closed at once rather than at the plan's
 * next run. A page that came back starts the confirmation's asking again for each of its
 * confirmed conflicts that stands once more (F13: the relation stayed confirmed throughout, so no
 * `decide` asked, and a drafted plan resting on it was asked nothing until its approval stopped
 * it), and closes the status cards its leaving opened (W17-R2, `closeCardsOfReturnedPage`).
 * Internal; schedules itself for the pages left.
 */
export const turnPageQuestions = internalMutation({
  args: {
    pages: v.array(
      v.object({
        sourceId: v.id('docSources'),
        ref: v.string(),
        /** True for a page that came back to `active`; false for one that left it. */
        back: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ closed: number; asked: number }> => {
    const now = Date.now();
    let closed = 0;
    let asked = 0;
    for (const page of args.pages.slice(0, QUESTION_TURN_PAGES)) {
      if (!page.back) {
        closed += await closeQuestionsOnPage(ctx, page, now);
        continue;
      }
      const source = await ctx.db.get(page.sourceId);
      if (source === null) continue;
      await closeCardsOfReturnedPage(ctx, source, page.ref, now);
      for (const relation of await confirmedConflictsOfPages(ctx, source.userId, [page])) {
        if ((await standingConflictOf(ctx, relation)) === undefined) continue;
        await scheduleConfirmationAsks(ctx, relation);
        asked += 1;
      }
    }
    const rest = args.pages.slice(QUESTION_TURN_PAGES);
    if (rest.length > 0) {
      await ctx.scheduler.runAfter(0, internal.docRelations.turnPageQuestions, { pages: rest });
    }
    return { closed, asked };
  },
});

/** A page as a relation's card draws it: when its source last had it, and how far it is trusted. */
type CardPage = NamedPage & {
  readonly updatedAt: number;
  /**
   * Whether `updatedAt` is when the source says the page was edited (`editedAtSource`). False
   * for a page its reader stamped with when it read it, so a card says "last read", not "edited"
   * (W15-R45).
   */
  readonly edited: boolean;
  /**
   * Whether the page's row says its source dated it (`docPages.datedBySource`; D-8 (a)): the card
   * of a successor proposed by the pages' dates says so beside each date. False for a page
   * stored before 0.21.0, of whose time the card claims nothing more than its kind does.
   */
  readonly dated: boolean;
  readonly authority: SourceAuthority;
};

/** A stored page as a relation's card draws it. */
function cardPage(page: Doc<'docPages'>, source: Doc<'docSources'>): CardPage {
  return {
    ...named(page, source),
    updatedAt: page.updatedAt,
    edited: editedAtSource(page, source),
    dated: page.datedBySource === true,
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

/** Why a read of the cards is refused: it goes on from two places at once. */
export const LIST_OPEN_ONE_CURSOR =
  'A read of the cards goes on from the confirmed conflicts or from the proposals, not both.';

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

/** One read of the cards: what it drew, and where a later read of the confirmed conflicts goes on. */
export interface RelationCardsRead {
  readonly cards: RelationCardRow[];
  /**
   * Where the next read of the owner's confirmed conflicts goes on from (`conflictsBefore`), or
   * null once they are read to the end: a read stops within a transaction's limits, so a conflict
   * that stands behind many settled ones is drawn by a later read (W15-R19, F12).
   */
  readonly next: number | null;
  /**
   * The proposals the read did not draw (W17-R9, D-10 (a)): those it read and left once it had
   * drawn `RELATION_CARDS_READ` or spent its bytes, and whether more may stand past what it read
   * (`atLeast`: it read `PROPOSALS_READ` rows). None on a read going on from a cursor, which draws
   * no proposal.
   */
  readonly notShown: { readonly proposals: number; readonly atLeast: boolean };
  /**
   * Where the next read of the proposals goes on from (`proposalsBefore`: the creation time of the
   * last proposal this read looked at), or null once no proposal stands past what it read (D-10's
   * read-more). None on a read of the confirmed conflicts going on from a cursor.
   */
  readonly proposalsNext: number | null;
}

/**
 * The relations the manager has still to answer: every proposed relation, and every confirmed
 * conflict that stands, newest first, at most `RELATION_CARDS_READ` of each and
 * `CARD_PAGES_BYTES` of their pages a read, the confirmed conflicts read first (W15-R22).
 * Public; the caller's own. A relation one of whose pages is gone or no longer current is not
 * drawn (its source's unlink deletes it; a page that came back draws it again). The confirmed
 * conflicts are read by page (`standingConflictsFrom`), so a conflict a plan's question asks
 * about has its card however many settled conflicts are newer: a read that stops short says where
 * the next goes on (`next`), and that read, given `conflictsBefore`, draws the confirmed
 * conflicts from there and no proposal. The proposals past a read's twenty are read on the same
 * way, by the manager's press (D-10's read-more): given `proposalsBefore` (an earlier read's
 * `proposalsNext`), a read draws the next proposals from there and no confirmed conflict. Writes
 * nothing.
 */
export const listOpen = query({
  args: {
    /** Read only the confirmed conflicts, from where an earlier read's `next` said to go on. */
    conflictsBefore: v.optional(v.number()),
    /** Read only the proposals, from where an earlier read's `proposalsNext` said to go on. */
    proposalsBefore: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<RelationCardsRead> => {
    const caller = await getCallerOrThrow(ctx);
    if (args.conflictsBefore !== undefined && args.proposalsBefore !== undefined) {
      throw new ConvexError(LIST_OPEN_ONE_CURSOR);
    }
    const readingOn = args.conflictsBefore !== undefined;
    const proposalsOnly = args.proposalsBefore !== undefined;
    const { proposalsBefore } = args;
    const [proposed, confirmed] = await Promise.all([
      readingOn
        ? []
        : ctx.db
            .query('docRelations')
            .withIndex('by_user_status', (q) => {
              const proposals = q.eq('userId', caller.ownerKey).eq('status', 'proposed');
              return proposalsBefore === undefined
                ? proposals
                : proposals.lt('_creationTime', proposalsBefore);
            })
            .order('desc')
            .take(PROPOSALS_READ),
      // The confirmed conflicts first: they hold plans, so the proposals' pages never spend the
      // read before them (W15-R22). The tab still draws the proposals above them.
      proposalsOnly
        ? { standing: [], next: null }
        : standingConflictsFrom(ctx, caller.ownerKey, {
            ...(args.conflictsBefore !== undefined ? { before: args.conflictsBefore } : {}),
            most: RELATION_CARDS_READ,
            bytes: CARD_PAGES_BYTES,
          }),
    ]);
    let bytes = 0;
    const conflictCards: RelationCardRow[] = confirmed.standing.map((standing) => {
      bytes += rowBytes(standing.from) + rowBytes(standing.to);
      const relation = standing.relation;
      return {
        _id: relation._id,
        kind: relation.kind,
        status: 'confirmed',
        from: cardPage(standing.from, standing.fromSource),
        to: cardPage(standing.to, standing.toSource),
        evidence: relation.evidence.map(({ measure, value }) => ({ measure, value })),
        disagreement: { heading: standing.conflict.heading, figures: standing.conflict.figures },
        offered: [...decisionsOffered(relation)],
      };
    });
    const cards: RelationCardRow[] = [];
    let looked = 0;
    for (const relation of proposed) {
      if (cards.length >= RELATION_CARDS_READ) break;
      looked += 1;
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
      if (bytes > CARD_PAGES_BYTES) {
        // This one is not drawn either.
        looked -= 1;
        break;
      }
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
    // The next read of the proposals goes on past the last one this read looked at; one that
    // looked at none (the confirmed conflicts spent its bytes) starts where this one did.
    const more = looked < proposed.length || proposed.length === PROPOSALS_READ;
    const proposalsNext = !more
      ? null
      : looked === 0
        ? (proposalsBefore ?? Number.MAX_SAFE_INTEGER)
        : proposed[looked - 1]._creationTime;
    return {
      cards: [...cards, ...conflictCards],
      next: confirmed.next,
      notShown: {
        proposals: proposed.length - looked,
        atLeast: proposed.length === PROPOSALS_READ,
      },
      proposalsNext,
    };
  },
});

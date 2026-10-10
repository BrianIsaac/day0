import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { copyPageStatusToBlocks } from './docBlocks';
import { appendEvent } from './eventLog';
import { reevaluatePendingInTransaction } from './workReevaluation';
import { agentReadsSource } from '../src/docs/agent-sources';
import {
  PAGE_STATUSES,
  defaultStatusOf,
  pageStatusOf,
  type PageStatus,
  type StatusSource,
} from '../src/docs/authority';
import {
  decidePageStatus,
  markerCandidate,
  markerStands,
  type MarkerCandidate,
} from '../src/docs/status';
import { finishingCursor, finishingStep } from '../src/docs/finishing';

/*
 * A stored page's status (wave 15, 15-A; the wave file's section 6.2; A5, A-2): the write of what
 * a page's source says of it, beside the page's hash and never through `docSources.upsertPage`
 * (a page whose text is unchanged is never upserted, so an archive at the source with no edit
 * would otherwise never be marked); the rules' outcome on the row (`decidePageStatus`); and what
 * a change of status sets off: the page's blocks take the status, each reading employee's parked
 * work is evaluated again, and the record says so. And the finish's status phase
 * (`restatePages`): every page the generation keeps is restated a bounded page at a time, and the
 * pages whose marker lines no judgement stands for are handed to the sync, which asks the model
 * between pages and writes each answer back (`recordMarker`; N20).
 *
 * This module imports nothing of `docSources`, which calls into it, nor anything that reaches
 * `work` (the standard's 10.2).
 */

/** The validator of a page status (`PAGE_STATUSES`). */
export const pageStatusValidator = v.union(...PAGE_STATUSES.map((status) => v.literal(status)));

/** What decided a page's status as the row reads: absent reads as the source's default. */
export function statusSourceOf(page: Pick<Doc<'docPages'>, 'statusSource'>): StatusSource {
  return page.statusSource ?? 'default';
}

/** The most relations read to or from one page: eight of the ceiling a document may reach. */
export const RELATIONS_OF_A_PAGE = 8;

/** A page's change of status, as `restatePage` reports it. */
export interface StatusChange {
  readonly sourceId: Id<'docSources'>;
  readonly ref: string;
  readonly title: string;
  readonly from: PageStatus;
  readonly to: PageStatus;
  readonly statusSource: StatusSource;
}

/** The page a relation the manager confirmed names as a page's successor, when there is one. */
async function confirmedSuccessor(
  ctx: QueryCtx,
  page: Pick<Doc<'docPages'>, 'sourceId' | 'ref'>,
): Promise<{ sourceId: Id<'docSources'>; ref: string } | undefined> {
  // A page has few relations: the proposals are capped a source a generation, and a pair holds one.
  const relations = await ctx.db
    .query('docRelations')
    .withIndex('by_to', (q) => q.eq('to.sourceId', page.sourceId).eq('to.ref', page.ref))
    .take(RELATIONS_OF_A_PAGE);
  return relations.find(
    (relation) => relation.kind === 'possible_successor' && relation.status === 'confirmed',
  )?.from;
}

/** Whether two page names are the same page, or both absent. */
function samePage(
  left: { sourceId: Id<'docSources'>; ref: string } | undefined,
  right: { sourceId: Id<'docSources'>; ref: string } | undefined,
): boolean {
  return left?.sourceId === right?.sourceId && left?.ref === right?.ref;
}

/**
 * The owner's employees that read a source: whose parked work a page's status may return, and on
 * whose record its change is written.
 */
async function readersOf(ctx: QueryCtx, source: Doc<'docSources'>): Promise<Doc<'agents'>[]> {
  const agents = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', source.userId))
    .collect();
  return agents.filter((agent) => agentReadsSource(agent, source._id));
}

/**
 * Make a stored page's status the outcome of the rules over what its row holds now
 * (`decidePageStatus`: the manager, the source, a judged marker that still stands for the page's
 * text, a confirmed relation, the source's default), in the caller's transaction. Writes the row
 * only when its status, what decided it or its successor differ; and when the status itself
 * changed, copies it onto the page's blocks, writes `documentation.page-status-changed` on every
 * reading employee's record and evaluates each one's parked work again, once a status
 * (`documentation-status:<source>:<ref>:<status>`).
 *
 * @param ctx - The writing mutation's context.
 * @param args - The page as read in this transaction, its source, and the time.
 * @returns The change, or null when the page's status stands.
 */
export async function restatePage(
  ctx: MutationCtx,
  args: {
    readonly source: Doc<'docSources'>;
    readonly page: Doc<'docPages'>;
    readonly now: number;
  },
): Promise<StatusChange | null> {
  const { source, page, now } = args;
  const manager = page.statusSource === 'manager' ? pageStatusOf(page) : undefined;
  const marker = markerStands(page.marker, markerCandidate(page.title, page.markdown))
    ? page.marker
    : undefined;
  const successor = await confirmedSuccessor(ctx, page);
  const decided = decidePageStatus({
    ...(manager !== undefined ? { manager } : {}),
    ...(page.nativeStatus !== undefined ? { nativeStatus: page.nativeStatus } : {}),
    ...(marker !== undefined ? { marker } : {}),
    superseded: successor !== undefined,
    defaultStatus: defaultStatusOf(source),
  });
  // The page a superseded page gave way to: the manager's own choice, or the confirmed relation's.
  const supersededBy =
    decided.status !== 'superseded'
      ? undefined
      : decided.statusSource === 'manager'
        ? page.supersededBy
        : decided.statusSource === 'relation'
          ? successor
          : undefined;
  const from = pageStatusOf(page);
  if (
    from === decided.status &&
    statusSourceOf(page) === decided.statusSource &&
    samePage(page.supersededBy, supersededBy)
  ) {
    return null;
  }
  await ctx.db.patch(page._id, {
    status: decided.status,
    statusSource: decided.statusSource,
    supersededBy,
    ...(decided.statusSource === 'manager' ? {} : { decidedBy: undefined, decidedAt: undefined }),
  });
  if (from === decided.status) return null;
  await copyPageStatusToBlocks(ctx, {
    sourceId: page.sourceId,
    pageRef: page.ref,
    status: decided.status,
  });
  for (const agent of await readersOf(ctx, source)) {
    await appendEvent(ctx, {
      agentId: agent._id,
      type: 'documentation.page-status-changed',
      payload: {
        sourceId: page.sourceId,
        ref: page.ref,
        title: page.title,
        from,
        to: decided.status,
        decidedBy: decided.statusSource,
        ...(supersededBy !== undefined ? { supersededBy } : {}),
      },
      createdAt: now,
    });
    // Out-of-scope skips read the documentation the employee has; a page that left it, or came
    // back, may change the verdict. Keyed by the status, so the same change re-admits once.
    await reevaluatePendingInTransaction(ctx, {
      agentId: agent._id,
      trigger: 'documentation',
      key: `documentation-status:${page.sourceId}:${page.ref}:${decided.status}`,
      now,
    });
  }
  return {
    sourceId: page.sourceId,
    ref: page.ref,
    title: page.title,
    from,
    to: decided.status,
    statusSource: decided.statusSource,
  };
}

/**
 * Record what a page's source says of it, as the sync read it: its native status (a provider's
 * archive, trash or draft flag, front matter, a path; normalised by its reader, K-10) and its
 * revision as the source numbers it. Internal; the sync calls it beside the page's hash, for a
 * page it stored again and for a page it kept as stored whose source now says otherwise, so an
 * archive at the source with no edit reaches the row (A-2). Fenced on the source's running
 * generation, as `upsertPage` is. Writes the row only when an input changed, then restates the
 * page (`restatePage`).
 *
 * @returns Whether the page's status changed.
 */
export const recordRead = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    syncRunId: v.id('docSyncRuns'),
    ref: v.string(),
    nativeStatus: v.optional(pageStatusValidator),
    sourceRevision: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null || source.activeSyncId !== args.syncRunId) return false;
    const page = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', args.sourceId).eq('ref', args.ref))
      .unique();
    if (page === null) return false;
    const inputs = { nativeStatus: args.nativeStatus, sourceRevision: args.sourceRevision };
    if (
      page.nativeStatus !== inputs.nativeStatus ||
      page.sourceRevision !== inputs.sourceRevision
    ) {
      await ctx.db.patch(page._id, inputs);
    }
    const change = await restatePage(ctx, {
      source,
      page: { ...page, ...inputs },
      now: Date.now(),
    });
    return change !== null;
  },
});

/**
 * One bounded page of the status phase's walk: under a mutation's read limit whatever the pages
 * hold, since a page row carries its whole Markdown.
 */
const STATUS_PAGE_READ = { numItems: 50, maximumBytesRead: 4 * 1024 * 1024 } as const;

/** A page whose marker lines await a judgement: its ref and what the pre-filter found. */
export interface MarkerToJudge extends MarkerCandidate {
  readonly ref: string;
}

/** What one page of the status phase did, and where the finish stands after it. */
export interface StatusPhasePage {
  /** How many pages' statuses this page of the walk changed. */
  readonly changed: number;
  /** The pages whose marker lines no stored judgement stands for, for the sync to put to the model. */
  readonly toJudge: readonly MarkerToJudge[];
  /** Whether the walk is over, and the run's cursor now starts the scopes phase. */
  readonly done: boolean;
  /** Where the walk goes on from. */
  readonly from: string;
  /** The run's cursor after the page: the fence for the next one. */
  readonly checkpoint: string;
}

/**
 * Restate one bounded page of the pages a finishing generation keeps: the status phase, between
 * the mirrors and the scopes (A-2). Internal; the finishing sync walks the source's stored pages
 * with it once the pages two walks missed are gone, fenced on the run's cursor as the prunes are,
 * so a newer sync stops it and a finish cut off resumes where it stood.
 *
 * Each page's status is made the rules' outcome (`restatePage`). A judgement that is of other
 * lines than the page's top holds now is removed, and a page whose marker lines have no
 * judgement is answered in `toJudge`: the mutation asks no model.
 *
 * @returns Where the finish stands, or null when the run is no longer at that checkpoint.
 * @throws Error when the checkpoint is not in the status phase.
 */
export const restatePages = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    /** The run's cursor as the caller last saw it. */
    checkpoint: v.string(),
    /** Where in the walk to read from. */
    from: v.union(v.string(), v.null()),
    /** Whether to record the page's position on the run. */
    record: v.boolean(),
  },
  handler: async (ctx, args): Promise<StatusPhasePage | null> => {
    if (finishingStep(args.checkpoint)?.phase !== 'status') {
      throw new Error('This step of a finish runs in its status phase only.');
    }
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== run._id ||
      run.state !== 'running' ||
      run.cursor !== args.checkpoint
    ) {
      return null;
    }
    const walked = await ctx.db
      .query('docPages')
      .withIndex('by_source', (q) => q.eq('sourceId', args.sourceId))
      .paginate({ ...STATUS_PAGE_READ, cursor: args.from });
    const now = Date.now();
    const toJudge: MarkerToJudge[] = [];
    let changed = 0;
    for (const stored of walked.page) {
      const candidate = markerCandidate(stored.title, stored.markdown);
      let page = stored;
      if (!markerStands(stored.marker, candidate)) {
        if (stored.marker !== undefined) {
          await ctx.db.patch(stored._id, { marker: undefined });
          page = { ...stored, marker: undefined };
        }
        if (candidate !== undefined) toJudge.push({ ref: stored.ref, ...candidate });
      }
      if ((await restatePage(ctx, { source, page, now })) !== null) changed += 1;
    }
    const position = finishingCursor(
      walked.isDone
        ? { phase: 'scopes', cursor: null }
        : { phase: 'status', cursor: walked.continueCursor },
    );
    const recorded = walked.isDone || args.record;
    if (recorded) await ctx.db.patch(run._id, { cursor: position });
    return {
      changed,
      toJudge,
      done: walked.isDone,
      from: walked.continueCursor,
      checkpoint: recorded ? position : args.checkpoint,
    };
  },
});

/**
 * Store the model's judgement of a page's marker lines, and restate the page. Internal; the
 * finishing sync calls it for each page `restatePages` handed it, once the model has answered.
 * Fenced on the source's running generation; a page whose marker lines are no longer the ones
 * judged (it was stored again meanwhile) takes nothing, and is judged at the next sync.
 *
 * @returns Whether the judgement was stored.
 */
export const recordMarker = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    syncRunId: v.id('docSyncRuns'),
    ref: v.string(),
    /** The marker lines the judgement is of (`MarkerCandidate.quote`). */
    quote: v.string(),
    /** What the judgement makes of them; `active` when they are no marker. */
    status: pageStatusValidator,
  },
  handler: async (ctx, args): Promise<boolean> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null || source.activeSyncId !== args.syncRunId) return false;
    const page = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', args.sourceId).eq('ref', args.ref))
      .unique();
    if (page === null) return false;
    if (markerCandidate(page.title, page.markdown)?.quote !== args.quote) return false;
    const now = Date.now();
    const marker = { status: args.status, quote: args.quote, judgedAt: now };
    await ctx.db.patch(page._id, { marker });
    await restatePage(ctx, { source, page: { ...page, marker }, now });
    return true;
  },
});

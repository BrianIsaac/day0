import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { copyPageStatusToBlocks } from './docBlocks';
import { appendEvent } from './eventLog';
import { getCallerOrThrow, verifiedAddressOf } from './ownership';
import { reevaluatePendingInTransaction } from './workReevaluation';
import { RUNBOOKS_A_SCAN, type ChangedRunbook } from './skillVersions';
import { agentReadsSource } from '../src/docs/agent-sources';
import {
  PAGE_STATUSES,
  SOURCE_AUTHORITIES,
  defaultStatusOf,
  pageStatusOf,
  type PageStatus,
  type StatusSource,
} from '../src/docs/authority';
import {
  decidePageStatus,
  markerCandidate,
  markerStands,
  type DecidedStatus,
  type MarkerCandidate,
} from '../src/docs/status';
import { finishingCursor, finishingStep } from '../src/docs/finishing';

/*
 * A stored page's status (wave 15, 15-A; the wave file's section 6.2; A5, A-2): the write of what
 * a page's source says of it, beside the page's hash and never through `docSources.upsertPage`
 * (a page whose text is unchanged is never upserted, so an archive at the source with no edit
 * would otherwise never be marked); the rules' outcome on the row (`decidePageStatus`); and what
 * a change of status sets off: the page's blocks take the status, each reading employee's parked
 * work is evaluated again, the record says so, and the skills whose verified version read the
 * page are due a re-check (`stampStatusChanges`; a page a finish removed stamps them too,
 * `stampRemovedPages`, W14-R22). And the finish's status phase
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

/**
 * The most relations read to or from one page. A relation row is small (its evidence is capped
 * where it is written), and a pair holds at most a few.
 */
export const RELATIONS_OF_A_PAGE = 32;

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
function samePage(left: PageName | undefined, right: PageName | undefined): boolean {
  return left?.sourceId === right?.sourceId && left?.ref === right?.ref;
}

/**
 * The owner's employees that read a source: whose parked work a page's status may return, and on
 * whose record its change is written.
 */
export async function readersOf(
  ctx: QueryCtx,
  source: Doc<'docSources'>,
): Promise<Doc<'agents'>[]> {
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
  return await writeStatus(ctx, { source, page, decided, supersededBy, now });
}

/** A page's name within its owner's documentation. */
interface PageName {
  readonly sourceId: Id<'docSources'>;
  readonly ref: string;
}

/**
 * Write a decided status on a page's row when it differs, and set off what a change of status
 * sets off: the blocks, each reading employee's record and parked work.
 *
 * @param args - The page, the status decided for it with its successor, and, when the manager
 *   decided it by hand, who and when (written even when the status itself stands).
 * @returns The change, or null when the page's status itself stands.
 */
async function writeStatus(
  ctx: MutationCtx,
  args: {
    readonly source: Doc<'docSources'>;
    readonly page: Doc<'docPages'>;
    readonly decided: DecidedStatus;
    readonly supersededBy: PageName | undefined;
    readonly manager?: { readonly decidedBy: string | undefined; readonly decidedAt: number };
    readonly now: number;
  },
): Promise<StatusChange | null> {
  const { source, page, decided, supersededBy, now } = args;
  const from = pageStatusOf(page);
  if (
    args.manager === undefined &&
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
    decidedBy: args.manager?.decidedBy,
    decidedAt: args.manager?.decidedAt,
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
 * Schedule the library scans that stamp "Re-check due" on the skills that read the given pages:
 * one scan for them all (14-I's m5), a part of `RUNBOOKS_A_SCAN` pages a scan.
 */
async function scheduleRunbookStamps(
  ctx: MutationCtx,
  userId: string,
  pages: readonly ChangedRunbook[],
  now: number,
): Promise<void> {
  for (let start = 0; start < pages.length; start += RUNBOOKS_A_SCAN) {
    await ctx.scheduler.runAfter(0, internal.skillVersions.stampChangedPages, {
      userId,
      pages: pages.slice(start, start + RUNBOOKS_A_SCAN),
      changedAt: now,
      cursor: null,
    });
  }
}

/**
 * Stamp "Re-check due" on the skills whose verified version read a page that is no longer
 * current: superseded, archived or marked a draft (the wave file's section 6.2). A page that
 * came back to active stamps nothing: a skill is checked against a runbook that stopped
 * standing, never for one that stands again. Every registered function that restates a page
 * calls it once with all its changes, so one transaction schedules one scan.
 *
 * @param ctx - The writing mutation's context.
 * @param source - The pages' source, for its owner's library.
 * @param changes - What `restatePage` answered, a null for each page whose status stands.
 * @param now - The time of the change.
 */
export async function stampStatusChanges(
  ctx: MutationCtx,
  source: Pick<Doc<'docSources'>, 'userId'>,
  changes: ReadonlyArray<StatusChange | null>,
  now: number,
): Promise<void> {
  const pages = changes.flatMap((change): ChangedRunbook[] =>
    change === null || change.to === 'active'
      ? []
      : [{ sourceId: change.sourceId, ref: change.ref, title: change.title, change: change.to }],
  );
  await scheduleRunbookStamps(ctx, source.userId, pages, now);
}

/**
 * Stamp "Re-check due" on the skills whose verified version read a page a finishing sync removed
 * (W14-R22): the page is gone from its source, or moved within it, after two complete walks
 * missed it. `docSources.prunePages` calls it once a page of its walk.
 *
 * @param ctx - The pruning mutation's context.
 * @param source - The source the pages left.
 * @param pages - The removed pages' refs and their last stored titles.
 * @param now - The time of the prune.
 */
export async function stampRemovedPages(
  ctx: MutationCtx,
  source: Pick<Doc<'docSources'>, '_id' | 'userId' | 'label'>,
  pages: ReadonlyArray<{ readonly ref: string; readonly title: string }>,
  now: number,
): Promise<void> {
  await scheduleRunbookStamps(
    ctx,
    source.userId,
    pages.map((page) => ({
      sourceId: source._id,
      ref: page.ref,
      title: page.title,
      change: 'removed' as const,
      source: source.label,
    })),
    now,
  );
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
    const now = Date.now();
    const change = await restatePage(ctx, { source, page: { ...page, ...inputs }, now });
    await stampStatusChanges(ctx, source, [change], now);
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
    const changes: Array<StatusChange | null> = [];
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
      changes.push(await restatePage(ctx, { source, page, now }));
    }
    await stampStatusChanges(ctx, source, changes, now);
    const position = finishingCursor(
      walked.isDone
        ? { phase: 'scopes', cursor: null }
        : { phase: 'status', cursor: walked.continueCursor },
    );
    const recorded = walked.isDone || args.record;
    if (recorded) await ctx.db.patch(run._id, { cursor: position });
    return {
      changed: changes.filter((change) => change !== null).length,
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
    const change = await restatePage(ctx, { source, page: { ...page, marker }, now });
    await stampStatusChanges(ctx, source, [change], now);
    return true;
  },
});

/** The statuses the manager may give a page by hand; `active` is what Clear falls back to. */
const MANAGER_STATUSES = ['superseded', 'archived', 'draft'] as const;

/**
 * Write a status the manager decided by hand on a page, with who decided and when, and set off
 * what a change sets off (the blocks, the readers' records and parked work, the skills' stamp).
 * The caller has established that the manager owns the page: `setPageStatus`, and a conflict's
 * card when the manager says which page is right (`docRelations.decide`).
 *
 * @param ctx - The deciding mutation's context.
 * @param args - The page with its source, the status, its successor when superseded, and the
 *   manager's verified address when the token gives one.
 */
export async function decideByHand(
  ctx: MutationCtx,
  args: {
    readonly source: Doc<'docSources'>;
    readonly page: Doc<'docPages'>;
    readonly status: (typeof MANAGER_STATUSES)[number];
    readonly supersededBy: PageName | undefined;
    readonly decidedBy: string | undefined;
    readonly now: number;
  },
): Promise<void> {
  const change = await writeStatus(ctx, {
    source: args.source,
    page: args.page,
    decided: { status: args.status, statusSource: 'manager' },
    supersededBy: args.supersededBy,
    manager: { decidedBy: args.decidedBy, decidedAt: args.now },
    now: args.now,
  });
  await stampStatusChanges(ctx, args.source, [change], args.now);
}

/** Why a page marked superseded was refused: it names no successor, or names itself. */
export const NAME_THE_SUCCESSOR = 'Name the page that supersedes it.';
export const NOT_ITS_OWN_SUCCESSOR = 'A page cannot supersede itself.';

/**
 * A page of the caller's with its source, read after the caller is known.
 *
 * @throws ConvexError when the page or its source is gone; Error `forbidden` for another owner's.
 */
async function ownedPage(
  ctx: QueryCtx,
  ownerKey: string,
  pageId: Id<'docPages'>,
): Promise<{ page: Doc<'docPages'>; source: Doc<'docSources'> }> {
  const page = await ctx.db.get(pageId);
  const source = page === null ? null : await ctx.db.get(page.sourceId);
  if (page === null || source === null) throw new ConvexError('That page is no longer stored.');
  if (source.userId !== ownerKey) throw new Error('forbidden');
  return { page, source };
}

/**
 * Give a page the manager's own status: superseded by another page, archived, or a draft (the
 * Documentation tab's "Mark superseded by ...", "Mark archived" and "This is a draft"). Public;
 * the caller must own the page's source, and the successor's. The manager's word stands over
 * everything the page and its source say until `clearPageStatus`. Writes the page's status with
 * the caller's verified address and the time, its blocks' status, and, on a change, the record
 * and parked work of every employee that reads the source.
 *
 * @throws ConvexError when a superseded page names no successor, or itself.
 */
export const setPageStatus = mutation({
  args: {
    pageId: v.id('docPages'),
    status: v.union(...MANAGER_STATUSES.map((status) => v.literal(status))),
    /** The page that supersedes it; required for `superseded`, ignored otherwise. */
    supersededBy: v.optional(v.id('docPages')),
  },
  handler: async (ctx, args): Promise<null> => {
    const caller = await getCallerOrThrow(ctx);
    const { page, source } = await ownedPage(ctx, caller.ownerKey, args.pageId);
    let supersededBy: PageName | undefined;
    if (args.status === 'superseded') {
      if (args.supersededBy === undefined) throw new ConvexError(NAME_THE_SUCCESSOR);
      if (args.supersededBy === args.pageId) throw new ConvexError(NOT_ITS_OWN_SUCCESSOR);
      const successor = await ownedPage(ctx, caller.ownerKey, args.supersededBy);
      supersededBy = { sourceId: successor.page.sourceId, ref: successor.page.ref };
    }
    await decideByHand(ctx, {
      source,
      page,
      status: args.status,
      supersededBy,
      decidedBy: verifiedAddressOf(caller),
      now: Date.now(),
    });
    return null;
  },
});

/**
 * Take the manager's own status off a page, back to what the page and its source say (the
 * tab's "Clear"): the source's own word, a judged marker, a confirmed relation, or the source's
 * default, in that order, from what the row kept beside the manager's decision (K-2), with no
 * re-read. Public; the caller must own the page's source. A page the manager never decided is
 * left as it is.
 */
export const clearPageStatus = mutation({
  args: { pageId: v.id('docPages') },
  handler: async (ctx, args): Promise<null> => {
    const caller = await getCallerOrThrow(ctx);
    const { page, source } = await ownedPage(ctx, caller.ownerKey, args.pageId);
    if (page.statusSource !== 'manager') return null;
    const undecided = {
      statusSource: undefined,
      decidedBy: undefined,
      decidedAt: undefined,
      supersededBy: undefined,
    };
    await ctx.db.patch(page._id, undecided);
    const now = Date.now();
    const change = await restatePage(ctx, { source, page: { ...page, ...undecided }, now });
    await stampStatusChanges(ctx, source, [change], now);
    return null;
  },
});

/**
 * Say how far a documentation source is trusted: official, team or personal (the tab's Trust
 * select; A5, A19). Public; the caller must own the source. Writes the source's `authority`,
 * which the selection weighs at its next read; no page's status changes with it.
 */
export const setSourceAuthority = mutation({
  args: {
    sourceId: v.id('docSources'),
    authority: v.union(...SOURCE_AUTHORITIES.map((authority) => v.literal(authority))),
  },
  handler: async (ctx, args): Promise<null> => {
    const caller = await getCallerOrThrow(ctx);
    const source = await ctx.db.get(args.sourceId);
    if (source === null) throw new ConvexError('That source is no longer linked.');
    if (source.userId !== caller.ownerKey) throw new Error('forbidden');
    if (source.authority !== args.authority) {
      await ctx.db.patch(source._id, { authority: args.authority, updatedAt: Date.now() });
    }
    return null;
  },
});

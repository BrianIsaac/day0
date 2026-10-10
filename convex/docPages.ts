import { paginationOptsValidator, type PaginationResult } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalQuery, query, type QueryCtx } from './_generated/server';
import { getCallerOrThrow, verifiedAddressOf } from './ownership';
import { RELATIONS_OF_A_PAGE, statusSourceOf } from './docStatus';
import { pageStatusOf, type PageStatus, type StatusSource } from '../src/docs/authority';

/*
 * Readers for the stored pages of a linked documentation source, for the Documentation tab's
 * page table (round two section 3.9, `agent-documentation.html`). A page carries its title, its
 * address and when the source last had it; whether the newest completed sync read it is the
 * run's record of unread pages (P5-11); and, since wave 15 (A5), its status with what decided
 * it, and whether a relation still to answer proposes another page in its place.
 */

/**
 * The most page bytes one read of the table touches. A page row carries its whole Markdown, so a
 * page of rows is bounded by bytes as well as by count.
 */
export const PAGE_TABLE_BYTES = 2 * 1024 * 1024;

/** The most rows one read of the table returns, whatever the caller asks for. */
export const PAGE_TABLE_ROWS = 50;

/** One stored page as the page table lists it: never its body. */
export interface DocPageRow {
  readonly _id: Id<'docPages'>;
  readonly ref: string;
  readonly title: string;
  readonly url?: string;
  /** When the source last had the page: its own edit time where the source gives one, else when it was read. */
  readonly updatedAt: number;
  /** Why the newest completed sync could not read the page, which kept its earlier version. */
  readonly unreadReason?: string;
  /** The page's status; only an active page is current (`pageStatusOf`). */
  readonly status: PageStatus;
  /** What decided it: the manager, the source, a marker, a relation or the default. */
  readonly statusSource: StatusSource;
  /** When the manager decided it, for a status the manager gave by hand. */
  readonly decidedAt?: number;
  /** Whether the caller is the manager who decided it; absent when no manager did. */
  readonly decidedByYou?: boolean;
  /** The address of the manager who decided it, when that is not the caller. */
  readonly decidedBy?: string;
  /** The title of the page that superseded it, when one is named and stored. */
  readonly supersededBy?: string;
  /** Set when a relation still to answer proposes another page as its later version or its twin. */
  readonly possiblySuperseded?: true;
}

/** What the manager's decision on a page's status reads as for the caller. */
function decision(
  page: Doc<'docPages'>,
  callerAddress: string | undefined,
): Pick<DocPageRow, 'decidedAt' | 'decidedByYou' | 'decidedBy'> {
  if (page.statusSource !== 'manager') return {};
  const yours = page.decidedBy === undefined || page.decidedBy === callerAddress;
  return {
    ...(page.decidedAt !== undefined ? { decidedAt: page.decidedAt } : {}),
    decidedByYou: yours,
    ...(!yours && page.decidedBy !== undefined ? { decidedBy: page.decidedBy } : {}),
  };
}

/** Whether a relation still to answer names the page as the older or the twin of another. */
async function proposedAgainst(ctx: QueryCtx, page: Doc<'docPages'>): Promise<boolean> {
  const relations = await ctx.db
    .query('docRelations')
    .withIndex('by_to', (q) => q.eq('to.sourceId', page.sourceId).eq('to.ref', page.ref))
    .take(RELATIONS_OF_A_PAGE);
  return relations.some(
    (relation) => relation.status === 'proposed' && relation.kind !== 'possible_conflict',
  );
}

/** The title of the page that superseded a page, when it names one that is stored. */
async function successorTitle(ctx: QueryCtx, page: Doc<'docPages'>): Promise<string | undefined> {
  const named = page.supersededBy;
  if (named === undefined) return undefined;
  const successor = await ctx.db
    .query('docPages')
    .withIndex('by_source_ref', (q) => q.eq('sourceId', named.sourceId).eq('ref', named.ref))
    .unique();
  return successor?.title;
}

/**
 * The caller's documentation source; `null` once it is gone, as a source unlinked from the same
 * tab is by the time its table reads again.
 *
 * @param ctx - The query context.
 * @param sourceId - The source.
 * @throws Error when the source is another owner's.
 */
async function ownedSource(
  ctx: QueryCtx,
  sourceId: Id<'docSources'>,
): Promise<Doc<'docSources'> | null> {
  const identity = await getCallerOrThrow(ctx);
  const source = await ctx.db.get(sourceId);
  if (source === null) return null;
  if (source.userId !== identity.ownerKey) throw new Error('forbidden');
  return source;
}

/**
 * The pages the source's newest completed sync listed and could not read, by reference, with
 * why. The run names the first ten; the rest are counted in `readState` only.
 *
 * @param ctx - The query context.
 * @param source - The source.
 */
async function unreadPages(
  ctx: QueryCtx,
  source: Doc<'docSources'>,
): Promise<ReadonlyMap<string, string>> {
  const run = source.lastCompletedSyncId ? await ctx.db.get(source.lastCompletedSyncId) : null;
  return new Map((run?.unread?.pages ?? []).map((page) => [page.ref, page.reason]));
}

/**
 * One page of a linked source's stored pages, in the order the source's pages were stored, with
 * whether its newest completed sync read each, its status with what decided it, and whether a
 * relation still to answer proposes another page in its place. Public; the caller must own the
 * source, and a source that is gone lists nothing. Reads by the source's index, at most
 * `PAGE_TABLE_ROWS` rows and `PAGE_TABLE_BYTES` a call, with the relations to each row and the
 * page that superseded it; writes nothing.
 */
export const listForSource = query({
  args: { sourceId: v.id('docSources'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<DocPageRow>> => {
    const caller = await getCallerOrThrow(ctx);
    const source = await ownedSource(ctx, args.sourceId);
    if (source === null) return { page: [], isDone: true, continueCursor: '' };
    const callerAddress = verifiedAddressOf(caller);
    const [unread, result] = await Promise.all([
      unreadPages(ctx, source),
      ctx.db
        .query('docPages')
        .withIndex('by_source', (index) => index.eq('sourceId', source._id))
        .paginate({
          ...args.paginationOpts,
          numItems: Math.min(args.paginationOpts.numItems, PAGE_TABLE_ROWS),
          maximumBytesRead: PAGE_TABLE_BYTES,
        }),
    ]);
    const rows = await Promise.all(
      result.page.map(async (page): Promise<DocPageRow> => {
        const reason = unread.get(page.ref);
        const status = pageStatusOf(page);
        const [proposed, supersededBy] = await Promise.all([
          status === 'active' ? proposedAgainst(ctx, page) : false,
          successorTitle(ctx, page),
        ]);
        return {
          _id: page._id,
          ref: page.ref,
          title: page.title,
          ...(page.url !== undefined ? { url: page.url } : {}),
          updatedAt: page.updatedAt,
          ...(reason !== undefined ? { unreadReason: reason } : {}),
          status,
          statusSource: statusSourceOf(page),
          ...decision(page, callerAddress),
          ...(supersededBy !== undefined ? { supersededBy } : {}),
          ...(proposed ? { possiblySuperseded: true as const } : {}),
        };
      }),
    );
    return { ...result, page: rows };
  },
});

/** What a source's newest completed sync came to. */
interface ReadState {
  readonly completedAt: number;
  /** How many pages it listed and could not read. */
  readonly unreadCount: number;
  /** How many of those it named, which `listForSource` marks; the run names the first ten. */
  readonly unreadNamed: number;
}

/**
 * What a source's newest completed sync came to, for the line over its page table: when it
 * finished, how many listed pages it could not read, and how many of those the table can mark. Public; the caller must own the source.
 * Reads the source and one run; writes nothing.
 *
 * @returns `null` when no sync of the source has completed yet, or the source is gone.
 */
export const readState = query({
  args: { sourceId: v.id('docSources') },
  returns: v.union(
    v.null(),
    v.object({ completedAt: v.number(), unreadCount: v.number(), unreadNamed: v.number() }),
  ),
  handler: async (ctx, args): Promise<ReadState | null> => {
    const source = await ownedSource(ctx, args.sourceId);
    if (source === null) return null;
    const run = source.lastCompletedSyncId ? await ctx.db.get(source.lastCompletedSyncId) : null;
    if (!run || run.completedAt === undefined) return null;
    return {
      completedAt: run.completedAt,
      unreadCount: run.unread?.count ?? 0,
      unreadNamed: run.unread?.pages.length ?? 0,
    };
  },
});

/**
 * The refs, of those given, that a source has a stored page under. Internal; the sync reads it so a
 * page it could not read counts as kept only when an earlier version of it is stored (W14-R11).
 */
export const storedPageRefs = internalQuery({
  args: { sourceId: v.id('docSources'), refs: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const stored = await Promise.all(
      args.refs.map(
        async (ref) =>
          (await ctx.db
            .query('docPages')
            .withIndex('by_source_ref', (q) => q.eq('sourceId', args.sourceId).eq('ref', ref))
            .first()) !== null,
      ),
    );
    return args.refs.filter((_ref, index) => stored[index]);
  },
});

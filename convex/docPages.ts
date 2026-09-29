import { paginationOptsValidator, type PaginationResult } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { query, type QueryCtx } from './_generated/server';
import { getCallerOrThrow } from './ownership';

/*
 * Readers for the stored pages of a linked documentation source, for the Documentation tab's
 * page table (round two section 3.9, `agent-documentation.html`). A page carries its title, its
 * address and when the source last had it; whether the newest completed sync read it is the
 * run's record of unread pages (P5-11). Page status by authority, who decided it, and the
 * relation between two pages that read as versions of one runbook wait on the documentation
 * authority records (A5), which no table holds yet.
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
 * whether its newest completed sync read each. Public; the caller must own the source, and a
 * source that is gone lists nothing. Reads by the source's index, at most `PAGE_TABLE_ROWS` rows
 * and `PAGE_TABLE_BYTES` a call; writes nothing.
 */
export const listForSource = query({
  args: { sourceId: v.id('docSources'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<DocPageRow>> => {
    const source = await ownedSource(ctx, args.sourceId);
    if (source === null) return { page: [], isDone: true, continueCursor: '' };
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
    return {
      ...result,
      page: result.page.map((page): DocPageRow => {
        const reason = unread.get(page.ref);
        return {
          _id: page._id,
          ref: page.ref,
          title: page.title,
          ...(page.url !== undefined ? { url: page.url } : {}),
          updatedAt: page.updatedAt,
          ...(reason !== undefined ? { unreadReason: reason } : {}),
        };
      }),
    };
  },
});

/**
 * What a source's newest completed sync came to, for the line over its page table: when it
 * finished and how many listed pages it could not read. Public; the caller must own the source.
 * Reads the source and one run; writes nothing.
 *
 * @returns `null` when no sync of the source has completed yet, or the source is gone.
 */
export const readState = query({
  args: { sourceId: v.id('docSources') },
  returns: v.union(v.null(), v.object({ completedAt: v.number(), unreadCount: v.number() })),
  handler: async (ctx, args): Promise<{ completedAt: number; unreadCount: number } | null> => {
    const source = await ownedSource(ctx, args.sourceId);
    if (source === null) return null;
    const run = source.lastCompletedSyncId ? await ctx.db.get(source.lastCompletedSyncId) : null;
    if (!run || run.completedAt === undefined) return null;
    return { completedAt: run.completedAt, unreadCount: run.unread?.count ?? 0 };
  },
});

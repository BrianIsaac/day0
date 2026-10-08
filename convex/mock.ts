import { v } from 'convex/values';
import { paginationOptsValidator, type PaginationResult } from 'convex/server';
import {
  internalMutation,
  internalQuery,
  query,
  type DatabaseReader,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';
import type { MockSurfaceSnapshot, MockWriteResult } from '../src/work/types';
import { assertCurrentGeneration } from '../src/docs/sync-generation';
import { agentReadsSource } from '../src/docs/agent-sources';
import { groundTicketWork, type TicketGroundingItem } from '../src/work/office-tickets';
import { selectedDocumentation, selectionRequestValidator } from './docSelection';
import { SURFACE_MODE } from '../src/lib/surface-mode';

/**
 * Read + write API for the mock work environment.
 *
 * Public read queries enforce per-account ownership. Internal write
 * mutations are only callable from actions, which do their own check.
 *
 * The agent's executor emits a typed actions[] array; `applyActions`
 * (in workActions.ts) interprets each action and calls one of the
 * mutations defined here. The dashboard subscribes to the same data
 * via these queries so edits surface live.
 */

/**
 * Whether an employee reads a page mirrored from a documentation source: only while the source
 * still exists, belongs to the employee's owner and is one the employee reads (the transfer
 * plan, section 6.2). An employee handed to another manager keeps the mirrors of its old owner's
 * sources until a paged job deletes them (`docSources.pruneDepartedMirrors`); from the moment it
 * moves, this is what keeps the new owner from reading them.
 *
 * @param agent - The employee, or null when its row is gone.
 * @param source - The mirror's source, or null when it is gone.
 */
export function mirrorReadable(
  agent: Pick<Doc<'agents'>, 'userId' | 'excludedDocSourceIds'> | null,
  source: Pick<Doc<'docSources'>, '_id' | 'userId'> | null,
): boolean {
  if (agent === null || source === null || agent.userId === undefined) return false;
  return source.userId === agent.userId && agentReadsSource(agent, source._id);
}

/**
 * An employee's office pages it may read, in the order given: every seeded page (no source), and
 * each mirrored page whose source {@link mirrorReadable} admits. Each distinct source is read
 * once.
 *
 * @param db - Any database reader.
 * @param agent - The employee, or null when its row is gone.
 * @param docs - Pages stored under the employee.
 */
export async function readableDocs(
  db: DatabaseReader,
  agent: Doc<'agents'> | null,
  docs: readonly Doc<'mockDocs'>[],
): Promise<Doc<'mockDocs'>[]> {
  const sourceIds = [...new Set(docs.flatMap((doc) => (doc.sourceId ? [doc.sourceId] : [])))];
  const sources = new Map(
    await Promise.all(
      sourceIds.map(
        async (id): Promise<[Id<'docSources'>, Doc<'docSources'> | null]> => [id, await db.get(id)],
      ),
    ),
  );
  return docs.filter(
    (doc) => doc.sourceId === undefined || mirrorReadable(agent, sources.get(doc.sourceId) ?? null),
  );
}

/**
 * The most documents a mock office's snapshot reads (M17). A mock office never syncs
 * documentation (linking is real mode only), so its documents are the seed's fixed set
 * (`convex/mockSeed.ts`, eleven pages), with room for the seed to grow; an office holding more is
 * refused rather than read whole or cut short.
 */
export const MOCK_OFFICE_DOCS_READ = 32;

/**
 * The documents a run's snapshot reads: in mock mode the office's fixed set, at most
 * {@link MOCK_OFFICE_DOCS_READ}; in real mode the employee's whole mirror, which the selection
 * replaces (14-R).
 *
 * @throws Error when a mock office holds more than {@link MOCK_OFFICE_DOCS_READ} documents.
 */
async function snapshotDocs(db: DatabaseReader, agentId: Id<'agents'>): Promise<Doc<'mockDocs'>[]> {
  const stored = db.query('mockDocs').withIndex('by_agent_slug', (q) => q.eq('agentId', agentId));
  if (SURFACE_MODE === 'real') return await stored.collect();
  const docs = await stored.take(MOCK_OFFICE_DOCS_READ + 1);
  if (docs.length > MOCK_OFFICE_DOCS_READ) {
    throw new Error(
      `The mock office holds more than ${MOCK_OFFICE_DOCS_READ} documents, more than its fixed set; a snapshot reads at most that many.`,
    );
  }
  return docs;
}

/**
 * Internal snapshot used only by an already-authorised scheduler continuation. Its documents are
 * the ones the employee reads ({@link readableDocs}): with no `selection`, every one whole, read
 * by {@link snapshotDocs} (a mock office at most {@link MOCK_OFFICE_DOCS_READ}); with `selection`
 * (real mode only, wave 14's 14-R) the pages and blocks one item needs from the whole mirror,
 * cited, within 24,000 characters (`docSelection.selectedDocumentation`). Mock mode and the frozen
 * evaluation pass no selection (R3).
 */
export const snapshotInternal = internalQuery({
  args: { agentId: v.id('agents'), selection: v.optional(selectionRequestValidator) },
  handler: async (ctx, args): Promise<MockSurfaceSnapshot> => {
    const [stored, sheets, rows, channels, messages, tweets, tickets] = await Promise.all([
      args.selection === undefined
        ? snapshotDocs(ctx.db, args.agentId)
        : ctx.db
            .query('mockDocs')
            .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
            .collect(),
      ctx.db
        .query('mockSpreadsheets')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('mockSpreadsheetRows')
        .withIndex('by_agent_sheet_tab', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('mockSlackChannels')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('mockSlackMessages')
        .withIndex('by_agent_channel', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('mockTweets')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('mockTickets')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
        .collect(),
    ]);
    const agent = await ctx.db.get(args.agentId);
    const docs = await readableDocs(ctx.db, agent, stored);
    const { selection } = args;
    const selected =
      selection === undefined
        ? undefined
        : {
            site: selection.site,
            ...(await selectedDocumentation(ctx, { agent, docs, request: selection })),
          };
    return {
      ...(selected === undefined
        ? {
            howToGuides: docs
              .filter((doc) => doc.category === 'how-to-guide')
              .map((doc) => ({ slug: doc.slug, title: doc.title, body: doc.body })),
            teamDocs: docs
              .filter((doc) => doc.category === 'team-doc')
              .map((doc) => ({ slug: doc.slug, title: doc.title, body: doc.body })),
          }
        : {
            howToGuides: selected.howToGuides,
            teamDocs: selected.teamDocs,
            documentation: {
              site: selected.site,
              blockIds: selected.blockIds,
              chars: selected.chars,
              citations: selected.citations,
            },
          }),
      spreadsheets: sheets.map((sheet) => ({
        slug: sheet.slug,
        title: sheet.title,
        tabs: sheet.tabs,
        rows: rows
          .filter((row) => row.sheetSlug === sheet.slug)
          .map((row) => ({ tabName: row.tabName, cells: row.cells as Record<string, string> })),
      })),
      slackChannels: channels.map((channel) => ({
        slug: channel.slug,
        displayName: channel.displayName,
        kind: channel.kind,
        recentMessages: messages
          .filter((message) => message.channelSlug === channel.slug)
          .slice(-12)
          .map((message) => ({
            sender: message.sender,
            body: message.body,
            threadKey: message.threadKey,
          })),
      })),
      tweets: tweets.map((tweet) => ({
        slug: tweet.slug,
        author: tweet.author,
        handle: tweet.handle,
        body: tweet.body,
      })),
      tickets: tickets.map((ticket) => ({
        slug: ticket.slug,
        title: ticket.title,
        status: ticket.status,
        body: ticket.body,
      })),
    };
  },
});

// ---------- Docs ----------

/** The most documents one page of {@link listDocs} reads. */
const DOCS_LIST_ROWS = 100;

/**
 * The most one page of {@link listDocs} reads, in bytes: a mirrored page carries its whole body
 * (up to 768 KiB), so a page of the list stops well under a query's 16 MiB read (M17).
 */
const DOCS_LIST_BYTES = 4 * 1024 * 1024;

/** One document as the Docs list shows it: what the rail names, without the body. */
export interface MockDocListing {
  readonly _id: Id<'mockDocs'>;
  readonly slug: string;
  readonly title: string;
  readonly category: Doc<'mockDocs'>['category'];
  readonly sourceId?: Id<'docSources'>;
}

/**
 * Public, owner-guarded: one page of the documents an employee reads ({@link readableDocs}), in
 * slug order, each without its body ({@link getDoc} reads one page whole). Reads at most
 * {@link DOCS_LIST_ROWS} documents and {@link DOCS_LIST_BYTES} bytes a page (M17, R6); writes
 * nothing.
 */
export const listDocs = query({
  args: { agentId: v.id('agents'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<MockDocListing>> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const result = await ctx.db
      .query('mockDocs')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, DOCS_LIST_ROWS),
        maximumBytesRead: DOCS_LIST_BYTES,
      });
    const readable = await readableDocs(ctx.db, agent, result.page);
    return {
      ...result,
      page: readable.map(
        (doc): MockDocListing => ({
          _id: doc._id,
          slug: doc.slug,
          title: doc.title,
          category: doc.category,
          ...(doc.sourceId !== undefined ? { sourceId: doc.sourceId } : {}),
        }),
      ),
    };
  },
});

/** Public, owner-guarded: one mock document by slug, or null when the employee does not read it. */
export const getDoc = query({
  args: { agentId: v.id('agents'), slug: v.string() },
  handler: async (ctx, args) => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const stored = await ctx.db
      .query('mockDocs')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
    if (stored === null) return null;
    const [readable] = await readableDocs(ctx.db, agent, [stored]);
    return readable ?? null;
  },
});

/**
 * Upsert one page of an agent's Docs surface by slug. Internal; written by the
 * seed and by the documentation sync's mirror. A sync names its generation
 * and writes nothing once a newer sync has superseded it (step 14). A page of a source the
 * employee does not read ({@link mirrorReadable}) is not written, nor one of a source that no
 * longer exists, which a deploy's mirroring that crossed an unlink would otherwise leave (M18).
 *
 * @returns The page's id, or null when nothing was written.
 * @throws Error when `syncRunId` is given without its source, or is not the
 *   source's running generation.
 */
export const upsertDoc = internalMutation({
  args: {
    agentId: v.id('agents'),
    slug: v.string(),
    title: v.string(),
    body: v.string(),
    category: v.union(v.literal('team-doc'), v.literal('how-to-guide')),
    sourceId: v.optional(v.id('docSources')),
    sourceRef: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    /** The sync generation mirroring the page; a superseded one writes nothing. */
    syncRunId: v.optional(v.id('docSyncRuns')),
  },
  handler: async (ctx, args): Promise<Id<'mockDocs'> | null> => {
    if (args.syncRunId !== undefined) {
      if (args.sourceId === undefined) throw new Error('A synced mirror names its source.');
      await assertCurrentGeneration(ctx, args.sourceId, args.syncRunId);
    }
    // A sync of the old owner's source begun before a handover finishes after it: the moved
    // employee no longer reads that source, so its page is not written for it.
    if (
      args.sourceId !== undefined &&
      !mirrorReadable(await ctx.db.get(args.agentId), await ctx.db.get(args.sourceId))
    ) {
      return null;
    }
    const existing = await ctx.db
      .query('mockDocs')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
    const payload = {
      title: args.title,
      body: args.body,
      category: args.category,
      sourceId: args.sourceId,
      sourceRef: args.sourceRef,
      sourceUrl: args.sourceUrl,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert('mockDocs', { agentId: args.agentId, slug: args.slug, ...payload });
  },
});

// ---------- Spreadsheets ----------

/** Public, owner-guarded: the mock office's spreadsheets for one employee. */
export const listSpreadsheets = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('mockSpreadsheets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
      .collect();
  },
});

/** Public, owner-guarded: one mock spreadsheet with its rows. */
export const getSpreadsheet = query({
  args: { agentId: v.id('agents'), slug: v.string() },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const sheet = await ctx.db
      .query('mockSpreadsheets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
    if (!sheet) return null;
    const rows = await ctx.db
      .query('mockSpreadsheetRows')
      .withIndex('by_agent_sheet_tab', (q) =>
        q.eq('agentId', args.agentId).eq('sheetSlug', args.slug),
      )
      .collect();
    return { sheet, rows };
  },
});

/** Internal: creates a mock spreadsheet for an employee unless one with that slug exists. */
export const ensureSpreadsheet = internalMutation({
  args: {
    agentId: v.id('agents'),
    slug: v.string(),
    title: v.string(),
    tabs: v.array(
      v.object({
        name: v.string(),
        headers: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('mockSpreadsheets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
    const payload = { title: args.title, tabs: args.tabs, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert('mockSpreadsheets', {
      agentId: args.agentId,
      slug: args.slug,
      ...payload,
    });
  },
});

/** Internal: appends one row to a mock spreadsheet tab; the write result says whether anything changed. */
export const appendSpreadsheetRow = internalMutation({
  args: {
    agentId: v.id('agents'),
    sheetSlug: v.string(),
    tabName: v.string(),
    cells: v.any(),
    addedBy: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MockWriteResult> => {
    const sheet = await ctx.db
      .query('mockSpreadsheets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.sheetSlug))
      .unique();
    if (!sheet) {
      return { changed: false, reason: `no spreadsheet with slug "${args.sheetSlug}"` };
    }
    if (!sheet.tabs.some((t) => t.name === args.tabName)) {
      return {
        changed: false,
        reason: `spreadsheet "${args.sheetSlug}" has no tab "${args.tabName}"`,
      };
    }
    const cells = (args.cells ?? {}) as Record<string, string>;
    if (Object.keys(cells).length === 0) {
      return { changed: false, reason: 'row had no cells, so the tab is unchanged' };
    }
    await ctx.db.insert('mockSpreadsheetRows', {
      agentId: args.agentId,
      sheetSlug: args.sheetSlug,
      tabName: args.tabName,
      cells: args.cells,
      addedBy: args.addedBy ?? 'agent',
      addedAt: Date.now(),
    });
    return { changed: true };
  },
});

// ---------- Slack ----------

/** Public, owner-guarded: the mock Slack channels for one employee. */
export const listChannels = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('mockSlackChannels')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
      .collect();
  },
});

/** Public, owner-guarded: one mock channel's messages in order. */
export const listMessages = query({
  args: { agentId: v.id('agents'), channelSlug: v.string() },
  handler: async (ctx, args): Promise<Doc<'mockSlackMessages'>[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('mockSlackMessages')
      .withIndex('by_agent_channel', (q) =>
        q.eq('agentId', args.agentId).eq('channelSlug', args.channelSlug),
      )
      .collect();
  },
});

/** Internal: creates a mock Slack channel for an employee unless one with that slug exists. */
export const ensureChannel = internalMutation({
  args: {
    agentId: v.id('agents'),
    slug: v.string(),
    displayName: v.string(),
    kind: v.union(v.literal('channel'), v.literal('dm')),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('mockSlackChannels')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert('mockSlackChannels', {
      agentId: args.agentId,
      slug: args.slug,
      displayName: args.displayName,
      kind: args.kind,
      createdAt: Date.now(),
    });
  },
});

/**
 * Internal: posts a message into a mock channel or thread, or reports that the
 * channel does not exist. The colleague's reply is scheduled by the mock
 * adapter that calls this (`src/surfaces/mock.ts`), not here.
 */
export const postSlackMessage = internalMutation({
  args: {
    agentId: v.id('agents'),
    channelSlug: v.string(),
    threadKey: v.optional(v.string()),
    sender: v.string(),
    senderKind: v.union(
      v.literal('agent-draft'),
      v.literal('agent-posted'),
      v.literal('manager'),
      v.literal('teammate'),
      v.literal('requester'),
      v.literal('system'),
    ),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<MockWriteResult> => {
    const channel = await ctx.db
      .query('mockSlackChannels')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.channelSlug))
      .unique();
    if (!channel) {
      return { changed: false, reason: `no Slack channel with slug "${args.channelSlug}"` };
    }
    await ctx.db.insert('mockSlackMessages', {
      agentId: args.agentId,
      channelSlug: args.channelSlug,
      threadKey: args.threadKey,
      sender: args.sender,
      senderKind: args.senderKind,
      body: args.body,
      timestamp: Date.now(),
    });
    return { changed: true };
  },
});

// ---------- Twitter ----------

/** Public, owner-guarded: the mock tweets for one employee. */
export const listTweets = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('mockTweets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
      .collect();
  },
});

/** Public, owner-guarded: the replies under one mock tweet. */
export const listTweetReplies = query({
  args: { agentId: v.id('agents'), tweetSlug: v.string() },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('mockTweetReplies')
      .withIndex('by_agent_tweet', (q) =>
        q.eq('agentId', args.agentId).eq('tweetSlug', args.tweetSlug),
      )
      .collect();
  },
});

/** Internal: creates a mock tweet for an employee unless one with that slug exists. */
export const ensureTweet = internalMutation({
  args: {
    agentId: v.id('agents'),
    slug: v.string(),
    author: v.string(),
    handle: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('mockTweets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert('mockTweets', {
      agentId: args.agentId,
      slug: args.slug,
      author: args.author,
      handle: args.handle,
      body: args.body,
      createdAt: Date.now(),
    });
  },
});

/** Internal: replies to a mock tweet; the write result says whether anything changed. */
export const postTweetReply = internalMutation({
  args: {
    agentId: v.id('agents'),
    tweetSlug: v.string(),
    author: v.string(),
    handle: v.string(),
    body: v.string(),
    isAgentDraft: v.boolean(),
  },
  handler: async (ctx, args): Promise<MockWriteResult> => {
    const tweet = await ctx.db
      .query('mockTweets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.tweetSlug))
      .unique();
    if (!tweet) {
      return { changed: false, reason: `no tweet with slug "${args.tweetSlug}"` };
    }
    await ctx.db.insert('mockTweetReplies', {
      agentId: args.agentId,
      tweetSlug: args.tweetSlug,
      author: args.author,
      handle: args.handle,
      body: args.body,
      isAgentDraft: args.isAgentDraft,
      createdAt: Date.now(),
    });
    return { changed: true };
  },
});

// ---------- Tickets ----------

/** Public, owner-guarded: the mock tickets for one employee. */
export const listTickets = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('mockTickets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
      .collect();
  },
});

/**
 * The most tickets one employee's office is read for when it opens tickets for drafted work: it
 * holds three seeded tickets and at most three more for each charter approval.
 */
const OFFICE_TICKETS_READ = 1000;

/**
 * Open the tickets a batch of charter-derived work names and the office does not hold, and return
 * the batch as it is seeded (`groundTicketWork`): every item from the ticket queue then names a
 * ticket the office holds, so its run can close the loop on it (the wave 11 review's M10).
 * Called inside the seeding mutation, so the tickets and the items land together or not at all.
 *
 * @param ctx - The seeding mutation's context.
 * @param agentId - The employee whose office it is.
 * @param items - The batch as the generator drafted it.
 * @returns The batch to seed, in the same order.
 */
export async function openTicketsForDraftedWork<T extends TicketGroundingItem>(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  items: readonly T[],
): Promise<T[]> {
  const held = await ctx.db
    .query('mockTickets')
    .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId))
    .take(OFFICE_TICKETS_READ);
  const grounded = groundTicketWork(
    items,
    held.map((ticket) => ticket.slug),
  );
  for (const ticket of grounded.opened) {
    await ctx.db.insert('mockTickets', {
      agentId,
      slug: ticket.slug,
      title: ticket.title,
      body: ticket.body,
      status: 'open',
      ...(ticket.priority !== undefined ? { priority: ticket.priority } : {}),
      comments: [],
      updatedAt: Date.now(),
    });
  }
  return grounded.items;
}

/** Internal: creates a mock ticket for an employee unless one with that slug exists. */
export const ensureTicket = internalMutation({
  args: {
    agentId: v.id('agents'),
    slug: v.string(),
    title: v.string(),
    body: v.string(),
    status: v.union(
      v.literal('open'),
      v.literal('in-progress'),
      v.literal('blocked'),
      v.literal('done'),
    ),
    priority: v.optional(v.string()),
    assignee: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('mockTickets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
    const payload = {
      title: args.title,
      body: args.body,
      status: args.status,
      priority: args.priority,
      assignee: args.assignee,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }
    return await ctx.db.insert('mockTickets', {
      agentId: args.agentId,
      slug: args.slug,
      ...payload,
      comments: [],
    });
  },
});

/** Internal: sets a mock ticket's status and appends its comment; the write result says whether anything changed. */
export const updateTicket = internalMutation({
  args: {
    agentId: v.id('agents'),
    slug: v.string(),
    status: v.optional(
      v.union(v.literal('open'), v.literal('in-progress'), v.literal('blocked'), v.literal('done')),
    ),
    comment: v.optional(v.string()),
    commentAuthor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<MockWriteResult> => {
    const ticket = await ctx.db
      .query('mockTickets')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
    if (!ticket) {
      return { changed: false, reason: `no ticket with slug "${args.slug}"` };
    }
    if (!args.status && !args.comment) {
      return { changed: false, reason: `ticket "${args.slug}" got neither a status nor a comment` };
    }
    // `changed` means a semantic field moved, not "a patch was issued". Setting
    // a done ticket to done rewrites the same status and a fresh `updatedAt`,
    // neither of which the executor's environment snapshot carries - so the
    // work would complete on a write nobody can see.
    const statusMoves = !!args.status && args.status !== ticket.status;
    const newComment = args.comment?.trim();
    const patch: Record<string, unknown> = {};
    if (statusMoves) patch.status = args.status;
    if (newComment) {
      patch.comments = [
        ...ticket.comments,
        {
          author: args.commentAuthor ?? 'Day0',
          body: newComment,
          timestamp: Date.now(),
        },
      ];
    }
    if (!statusMoves && !newComment) {
      return {
        changed: false,
        reason: args.status
          ? `ticket "${args.slug}" is already ${ticket.status}, and no comment was added`
          : `ticket "${args.slug}" got an empty comment`,
      };
    }
    patch.updatedAt = Date.now();
    await ctx.db.patch(ticket._id, patch);
    return { changed: true };
  },
});

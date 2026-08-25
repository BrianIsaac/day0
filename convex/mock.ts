import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { assertOwnsAgent } from './ownership';

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
 * What a write did to the mock environment. `changed: false` is the honest
 * answer when the action named a surface that does not exist, or asked for a
 * patch with nothing in it: the mutation resolved, and the work environment is
 * exactly as it was. The executor completes a work item on `changed`, never on
 * "the promise did not reject".
 */
export interface MockWriteResult {
  changed: boolean;
  reason?: string;
}

// ---------- Docs ----------

export const listDocs = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('mockDocs')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId))
      .collect();
  },
});

export const getDoc = query({
  args: { agentId: v.id('agents'), slug: v.string() },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('mockDocs')
      .withIndex('by_agent_slug', (q) => q.eq('agentId', args.agentId).eq('slug', args.slug))
      .unique();
  },
});

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
  },
  handler: async (ctx, args) => {
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
    // neither of which the executor's environment snapshot carries — so the
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

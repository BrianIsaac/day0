import { v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';

const sourceKind = v.union(
  v.literal('mcp'),
  v.literal('folder'),
  v.literal('git'),
  v.literal('urls'),
);

const serverKind = v.union(
  v.literal('notion'),
  v.literal('confluence'),
  v.literal('drive'),
  v.literal('generic'),
);

const sourceStatus = v.union(
  v.literal('linking'),
  v.literal('synced'),
  v.literal('error'),
  v.literal('credential-not-landed'),
);

export interface LinkInput {
  label: string;
  kind: 'mcp' | 'folder' | 'git' | 'urls';
  locator: string;
  serverKind?: 'notion' | 'confluence' | 'drive' | 'generic';
  credentialRef?: string;
}

/**
 * Validate and normalise an owner-supplied documentation location.
 *
 * Args:
 *   input: Link form values.
 *
 * Returns:
 *   Trimmed values safe to persist.
 *
 * Raises:
 *   Error: If the source kind and locator fields are inconsistent.
 */
export function validateLinkInput(input: LinkInput): LinkInput {
  const label = input.label.trim();
  const locator = input.locator.trim();
  const credentialRef = input.credentialRef?.trim() || undefined;
  if (!label) throw new Error('Documentation label is required.');
  if (!locator) throw new Error('Documentation locator is required.');
  if (input.kind === 'folder') {
    if (locator.startsWith('/') || locator.split(/[\\/]/).includes('..')) {
      throw new Error('Folder locator must be relative and stay inside DAY0_DOCS_ROOT.');
    }
  } else if (input.kind === 'urls') {
    const values = locator
      .split(/\r?\n/)
      .map((value: string): string => value.trim())
      .filter(Boolean);
    if (values.length === 0) throw new Error('At least one documentation URL is required.');
    for (const value of values) {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Documentation URLs must use HTTP or HTTPS.');
      }
    }
  } else {
    const rawUrl = input.kind === 'git' ? locator.split('#')[0] : locator;
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && !(input.kind === 'mcp' && url.protocol === 'http:')) {
      throw new Error('Remote documentation locators must use HTTPS.');
    }
  }
  if (input.kind === 'mcp') {
    if (!input.serverKind) throw new Error('MCP server kind is required.');
    if (!credentialRef || !/^[A-Z][A-Z0-9_]*$/.test(credentialRef)) {
      throw new Error('MCP credential must be an uppercase environment variable name.');
    }
  } else if (input.serverKind || credentialRef) {
    throw new Error('Only MCP sources may name a server kind or credential.');
  }
  return { ...input, label, locator, credentialRef };
}

/**
 * Check whether an agent inherits a source under the empty-means-all rule.
 *
 * Args:
 *   agent: Persisted agent row.
 *   sourceId: Owner-level source id.
 *
 * Returns:
 *   True when the source should be mirrored for the agent.
 */
export function agentReadsSource(agent: Doc<'agents'>, sourceId: Id<'docSources'>): boolean {
  return !agent.docSourceIds?.length || agent.docSourceIds.includes(sourceId);
}

/** List documentation sources owned by the signed-in caller. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCallerOrThrow(ctx);
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (index) => index.eq('userId', identity.subject))
      .collect();
    return await Promise.all(
      sources.map(async (source) => {
        const pages = await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', source._id))
          .collect();
        return { ...source, pageCount: pages.length };
      }),
    );
  },
});

/** Return owned source labels for dashboard joins. */
export const byIds = query({
  args: { sourceIds: v.array(v.id('docSources')) },
  handler: async (ctx, args) => {
    const identity = await getCallerOrThrow(ctx);
    const sources = await Promise.all(
      args.sourceIds.map(async (sourceId) => await ctx.db.get(sourceId)),
    );
    return sources.filter(
      (source): source is Doc<'docSources'> =>
        source !== null && source.userId === identity.subject,
    );
  },
});

/**
 * Link one owner-level documentation location and start its first sync.
 *
 * Refused outside real mode: a linked source makes the deployment fetch its
 * locator on every periodic sync, which the hosted mock must never do on a
 * caller's behalf.
 */
export const link = mutation({
  args: {
    label: v.string(),
    kind: sourceKind,
    locator: v.string(),
    serverKind: v.optional(serverKind),
    credentialRef: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'docSources'>> => {
    assertRealMode('Documentation linking');
    const identity = await getCallerOrThrow(ctx);
    const input = validateLinkInput(args);
    const now = Date.now();
    const sourceId = await ctx.db.insert('docSources', {
      userId: identity.subject,
      label: input.label,
      kind: input.kind,
      locator: input.locator,
      serverKind: input.serverKind,
      credentialRef: input.credentialRef,
      status: 'linking',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.docSyncActions.syncSource, { sourceId });
    return sourceId;
  },
});

/** Schedule a fresh sync of one owned location; refused outside real mode. */
export const resync = mutation({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<void> => {
    assertRealMode('Documentation resync');
    const identity = await getCallerOrThrow(ctx);
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.userId !== identity.subject)
      throw new Error('Documentation source not found.');
    await ctx.db.patch(source._id, {
      status: 'linking',
      lastError: undefined,
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.docSyncActions.syncSource, { sourceId: source._id });
  },
});

/** Unlink an owned source and remove its pages and per-agent mirrors; real mode only. */
export const unlink = mutation({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<{ pages: number; mirrors: number }> => {
    assertRealMode('Documentation unlinking');
    const identity = await getCallerOrThrow(ctx);
    const source = await ctx.db.get(args.sourceId);
    if (!source || source.userId !== identity.subject)
      throw new Error('Documentation source not found.');
    const pages = await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .collect();
    const mirrors = await ctx.db
      .query('mockDocs')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .collect();
    await Promise.all([...pages, ...mirrors].map(async (row) => await ctx.db.delete(row._id)));
    await ctx.db.delete(source._id);
    return { pages: pages.length, mirrors: mirrors.length };
  },
});

/** Return documentation pages inherited by one owned agent. */
export const pagesForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (index) => index.eq('userId', agent.userId!))
      .collect();
    const selected = sources.filter((source) => agentReadsSource(agent, source._id));
    const groups = await Promise.all(
      selected.map(async (source) => {
        const pages = await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', source._id))
          .collect();
        return pages.map((page) => ({
          ...page,
          sourceLabel: source.label,
          sourceKind: source.kind,
        }));
      }),
    );
    return groups.flat();
  },
});

/** Read one source for a server-side sync action. */
export const getInternal = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args) => await ctx.db.get(args.sourceId),
});

/** List sources eligible for periodic resync; empty outside real mode so the cron is inert. */
export const listSyncable = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (SURFACE_MODE !== 'real') return [];
    const sources = await ctx.db.query('docSources').collect();
    return sources.filter((source) => source.status !== 'linking');
  },
});

/** List all pages stored for one source. */
export const pagesForSourceInternal = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args) =>
    await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId))
      .collect(),
});

/** List owner agents that inherit a source. */
export const agentsForSource = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return [];
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (index) => index.eq('userId', source.userId))
      .collect();
    return agents.filter((agent) => agentReadsSource(agent, source._id));
  },
});

/** List inherited sources for one internal agent sync. */
export const sourcesForAgentInternal = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent?.userId) return [];
    const sources = await ctx.db
      .query('docSources')
      .withIndex('by_user', (index) => index.eq('userId', agent.userId!))
      .collect();
    return sources.filter((source) => agentReadsSource(agent, source._id));
  },
});

/** Upsert one normalised page by its stable source reference. */
export const upsertPage = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    ref: v.string(),
    title: v.string(),
    url: v.optional(v.string()),
    markdown: v.string(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<'docPages'>> => {
    const existing = await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (index) =>
        index.eq('sourceId', args.sourceId).eq('ref', args.ref),
      )
      .unique();
    const page = {
      title: args.title,
      url: args.url,
      markdown: args.markdown,
      updatedAt: args.updatedAt,
    };
    if (existing) {
      await ctx.db.patch(existing._id, page);
      return existing._id;
    }
    return await ctx.db.insert('docPages', { sourceId: args.sourceId, ref: args.ref, ...page });
  },
});

/** Delete stale source pages and their per-agent mirrors after a complete sync. */
export const deleteMissingPages = internalMutation({
  args: { sourceId: v.id('docSources'), currentRefs: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ pages: number; mirrors: number }> => {
    const current = new Set(args.currentRefs);
    const pages = (
      await ctx.db
        .query('docPages')
        .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId))
        .collect()
    ).filter((page) => !current.has(page.ref));
    const mirrors = (
      await ctx.db
        .query('mockDocs')
        .withIndex('by_source', (index) => index.eq('sourceId', args.sourceId))
        .collect()
    ).filter((page) => !page.sourceRef || !current.has(page.sourceRef));
    await Promise.all([...pages, ...mirrors].map(async (row) => await ctx.db.delete(row._id)));
    return { pages: pages.length, mirrors: mirrors.length };
  },
});

/** Persist a source sync state without exposing credential material. */
export const setStatus = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    status: sourceStatus,
    lastError: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.sourceId, {
      status: args.status,
      lastError: args.lastError,
      lastSyncAt: args.lastSyncAt,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Delete all documentation owned by one caller during an explicit full reset.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   userId: Owner subject being deleted.
 *
 * Returns:
 *   Number of source rows removed.
 */
export async function deleteOwnedDocumentation(ctx: MutationCtx, userId: string): Promise<number> {
  const sources = await ctx.db
    .query('docSources')
    .withIndex('by_user', (index) => index.eq('userId', userId))
    .collect();
  for (const source of sources) {
    const pages = await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .collect();
    const mirrors = await ctx.db
      .query('mockDocs')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .collect();
    for (const row of [...pages, ...mirrors]) await ctx.db.delete(row._id);
    await ctx.db.delete(source._id);
  }
  return sources.length;
}

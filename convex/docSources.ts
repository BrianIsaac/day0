import { v } from 'convex/values';
import {
  action,
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
  } else if (input.serverKind) {
    throw new Error('Only MCP sources may name a server kind.');
  }
  return { ...input, label, locator };
}

/**
 * Check whether an agent inherits a source.
 *
 * An agent reads every source its owner links, before or after the deploy,
 * except the ones it excluded at deploy. Rows from before the exclusion list
 * existed carry an explicit inclusion list instead, which is honoured as
 * written; an empty inclusion list still means all.
 *
 * Args:
 *   agent: Persisted agent row.
 *   sourceId: Owner-level source id.
 *
 * Returns:
 *   True when the source should be mirrored for the agent.
 */
export function agentReadsSource(agent: Doc<'agents'>, sourceId: Id<'docSources'>): boolean {
  if (agent.excludedDocSourceIds?.includes(sourceId)) return false;
  return !agent.docSourceIds?.length || agent.docSourceIds.includes(sourceId);
}

/**
 * Revoke credentials and remove sync generations associated with one source.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   source: Documentation source being removed.
 */
async function retireSourceState(ctx: MutationCtx, source: Doc<'docSources'>): Promise<void> {
  const discovered = await ctx.db
    .query('credentials')
    .withIndex('by_user_source_ref', (index) =>
      index.eq('userId', source.userId).eq('source.sourceId', source._id),
    )
    .collect();
  const credentialIds = new Set<Id<'credentials'>>(discovered.map((row) => row._id));
  if (source.credentialId) credentialIds.add(source.credentialId);
  for (const credentialId of credentialIds) {
    const credential = await ctx.db.get(credentialId);
    if (credential && !credential.revokedAt) {
      await ctx.db.patch(credential._id, { revokedAt: Date.now() });
    }
  }
  const runs = await ctx.db
    .query('docSyncRuns')
    .withIndex('by_source', (index) => index.eq('sourceId', source._id))
    .collect();
  for (const run of runs) await ctx.db.delete(run._id);
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
export const link = action({
  args: {
    label: v.string(),
    kind: sourceKind,
    locator: v.string(),
    serverKind: v.optional(serverKind),
    credential: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<'docSources'>> => {
    assertRealMode('Documentation linking');
    const identity = await getCallerOrThrow(ctx);
    const input = validateLinkInput({
      label: args.label,
      kind: args.kind,
      locator: args.locator,
      serverKind: args.serverKind,
    });
    const credential = args.credential;
    if (input.kind === 'mcp' && !credential) {
      throw new Error('Connection secret is required for an MCP source.');
    }
    if (input.kind !== 'mcp' && credential !== undefined) {
      throw new Error('Only MCP sources may include a connection secret.');
    }
    const sourceId = await ctx.runMutation(internal.docSources.createSource, {
      userId: identity.subject,
      ...input,
    });
    let storedCredentialId: Id<'credentials'> | undefined;
    try {
      if (credential) {
        storedCredentialId = await ctx.runAction(internal.credentials.store, {
          userId: identity.subject,
          kind: 'value',
          label: `${input.label} connection secret`,
          plaintext: credential,
          source: 'entered',
        });
        await ctx.runMutation(internal.docSources.attachCredential, {
          sourceId,
          userId: identity.subject,
          credentialId: storedCredentialId,
        });
      }
      await ctx.scheduler.runAfter(0, internal.docSyncActions.syncSource, { sourceId });
      return sourceId;
    } catch (error) {
      await ctx.runMutation(internal.docSources.deleteFailedLink, {
        sourceId,
        userId: identity.subject,
        credentialId: storedCredentialId,
      });
      throw error;
    }
  },
});

/** Rotate an owned MCP source secret without placing it in scheduler arguments. */
export const rotateCredential = action({
  args: { sourceId: v.id('docSources'), credential: v.string() },
  handler: async (ctx, args): Promise<Id<'credentials'>> => {
    assertRealMode('Documentation credential rotation');
    const identity = await getCallerOrThrow(ctx);
    if (!args.credential) throw new Error('Connection secret is required.');
    const source = await ctx.runQuery(internal.docSources.getOwnedInternal, {
      sourceId: args.sourceId,
      userId: identity.subject,
    });
    if (!source || source.kind !== 'mcp') throw new Error('Documentation source not found.');
    const credentialId = await ctx.runAction(internal.credentials.store, {
      userId: identity.subject,
      kind: 'value',
      label: `${source.label} connection secret`,
      plaintext: args.credential,
      source: 'entered',
    });
    await ctx.runMutation(internal.docSources.attachCredential, {
      sourceId: source._id,
      userId: identity.subject,
      credentialId,
    });
    if (source.credentialId) {
      await ctx.runMutation(internal.credentials.revokeInternal, {
        credentialId: source.credentialId,
      });
    }
    await ctx.scheduler.runAfter(0, internal.docSyncActions.syncSource, {
      sourceId: source._id,
    });
    return credentialId;
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
    await retireSourceState(ctx, source);
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

/** Insert source metadata after a public action has validated it. */
export const createSource = internalMutation({
  args: {
    userId: v.string(),
    label: v.string(),
    kind: sourceKind,
    locator: v.string(),
    serverKind: v.optional(serverKind),
  },
  handler: async (ctx, args): Promise<Id<'docSources'>> => {
    const now = Date.now();
    return await ctx.db.insert('docSources', {
      ...args,
      status: 'linking',
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Attach only an encrypted credential id to an owned source. */
export const attachCredential = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    userId: v.string(),
    credentialId: v.id('credentials'),
  },
  handler: async (ctx, args): Promise<void> => {
    const source = await ctx.db.get(args.sourceId);
    const credential = await ctx.db.get(args.credentialId);
    if (
      !source ||
      !credential ||
      source.userId !== args.userId ||
      credential.userId !== args.userId
    ) {
      throw new Error('Documentation source not found.');
    }
    await ctx.db.patch(source._id, { credentialId: credential._id, updatedAt: Date.now() });
  },
});

/** Remove a partially linked row and revoke any credential already created for it. */
export const deleteFailedLink = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    userId: v.string(),
    credentialId: v.optional(v.id('credentials')),
  },
  handler: async (ctx, args): Promise<void> => {
    const source = await ctx.db.get(args.sourceId);
    if (source?.userId === args.userId) await ctx.db.delete(source._id);
    if (args.credentialId) {
      const credential = await ctx.db.get(args.credentialId);
      if (credential?.userId === args.userId && !credential.revokedAt) {
        await ctx.db.patch(credential._id, { revokedAt: Date.now() });
      }
    }
  },
});

/** Read one source only when it belongs to the supplied authenticated owner. */
export const getOwnedInternal = internalQuery({
  args: { sourceId: v.id('docSources'), userId: v.string() },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    return source?.userId === args.userId ? source : null;
  },
});

/** Read one source for a server-side sync action. */
export const getInternal = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args) => await ctx.db.get(args.sourceId),
});

/**
 * How long a sync may sit in `linking` without progress before the periodic
 * pass restarts it. A batch is bounded by the Node action limit (ten
 * minutes), and every batch stamps the source, so a source older than this
 * belongs to an action the runtime killed without reaching its catch block.
 */
export const STALE_SYNC_MS = 30 * 60 * 1000;

/**
 * List sources eligible for periodic resync; empty outside real mode so the
 * cron is inert. A source mid-sync is skipped so the cron never races a
 * continuation, unless it stopped progressing long enough ago to be
 * abandoned, in which case `beginSync` supersedes the dead generation.
 */
export const listSyncable = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (SURFACE_MODE !== 'real') return [];
    const sources = await ctx.db.query('docSources').collect();
    const now = Date.now();
    return sources.filter(
      (source) => source.status !== 'linking' || now - source.updatedAt > STALE_SYNC_MS,
    );
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

/** Start a fenced sync generation and supersede any older continuation. */
export const beginSync = internalMutation({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<Id<'docSyncRuns'>> => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) throw new Error('Documentation source not found.');
    if (source.activeSyncId) {
      const active = await ctx.db.get(source.activeSyncId);
      if (active?.state === 'running') {
        await ctx.db.patch(active._id, { state: 'superseded', completedAt: Date.now() });
      }
    }
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId: source._id,
      refs: [],
      credentialRefs: [],
      pageCount: 0,
      redactionCount: 0,
      state: 'running',
      createdAt: Date.now(),
    });
    await ctx.db.patch(source._id, {
      activeSyncId: runId,
      status: 'linking',
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return runId;
  },
});

/** Read a generation and source for one Node-action batch. */
export const syncContext = internalQuery({
  args: { sourceId: v.id('docSources'), runId: v.id('docSyncRuns') },
  handler: async (ctx, args) => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== run._id ||
      run.sourceId !== source._id ||
      run.state !== 'running'
    ) {
      return null;
    }
    return { source, run };
  },
});

/** Record one non-final batch and advance its provider-safe cursor. */
export const recordSyncBatch = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    currentCursor: v.optional(v.string()),
    nextCursor: v.string(),
    refs: v.array(v.string()),
    credentialRefs: v.array(v.string()),
    pageCount: v.number(),
    redactionCount: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== run._id ||
      run.state !== 'running' ||
      run.cursor !== args.currentCursor
    ) {
      return false;
    }
    await ctx.db.patch(run._id, {
      cursor: args.nextCursor,
      refs: [...run.refs, ...args.refs],
      credentialRefs: [...run.credentialRefs, ...args.credentialRefs],
      pageCount: run.pageCount + args.pageCount,
      redactionCount: run.redactionCount + args.redactionCount,
    });
    await ctx.db.patch(source._id, { updatedAt: Date.now() });
    return true;
  },
});

/** Complete the final batch, delete stale mirrors and publish one synced state. */
export const finishSync = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    currentCursor: v.optional(v.string()),
    refs: v.array(v.string()),
    credentialRefs: v.array(v.string()),
    pageCount: v.number(),
    redactionCount: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ completed: boolean; pages: number; redactions: number }> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (
      !source ||
      !run ||
      source.activeSyncId !== run._id ||
      run.state !== 'running' ||
      run.cursor !== args.currentCursor
    ) {
      return { completed: false, pages: 0, redactions: 0 };
    }
    const refs = [...run.refs, ...args.refs];
    const current = new Set(refs);
    const currentCredentialRefs = new Set([...run.credentialRefs, ...args.credentialRefs]);
    const pages = await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .collect();
    const mirrors = await ctx.db
      .query('mockDocs')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .collect();
    for (const page of pages) {
      if (!current.has(page.ref)) await ctx.db.delete(page._id);
    }
    for (const mirror of mirrors) {
      if (!mirror.sourceRef || !current.has(mirror.sourceRef)) await ctx.db.delete(mirror._id);
    }
    const credentials = await ctx.db
      .query('credentials')
      .withIndex('by_user_source_ref', (index) =>
        index.eq('userId', source.userId).eq('source.sourceId', source._id),
      )
      .collect();
    for (const credential of credentials) {
      // Only a page-derived credential is retired when its page stops carrying
      // it. A typed value and an OAuth grant were never on a page, so a sync
      // has nothing to say about them.
      if (
        typeof credential.source !== 'string' &&
        !currentCredentialRefs.has(credential.source.ref) &&
        !credential.revokedAt
      ) {
        await ctx.db.patch(credential._id, { revokedAt: Date.now() });
      }
    }
    const pageCount = run.pageCount + args.pageCount;
    const redactionCount = run.redactionCount + args.redactionCount;
    const now = Date.now();
    await ctx.db.patch(run._id, {
      cursor: undefined,
      refs,
      credentialRefs: [...currentCredentialRefs],
      pageCount,
      redactionCount,
      state: 'completed',
      completedAt: now,
    });
    await ctx.db.patch(source._id, {
      activeSyncId: undefined,
      status: 'synced',
      lastError: undefined,
      lastSyncAt: now,
      updatedAt: now,
    });
    return { completed: true, pages: pageCount, redactions: redactionCount };
  },
});

/** Mark only the currently active generation as failed. */
export const failSync = internalMutation({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    status: v.union(v.literal('error'), v.literal('credential-not-landed')),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const [source, run] = await Promise.all([ctx.db.get(args.sourceId), ctx.db.get(args.runId)]);
    if (!source || !run || source.activeSyncId !== run._id || run.state !== 'running') return false;
    const now = Date.now();
    await ctx.db.patch(run._id, { state: 'error', completedAt: now });
    await ctx.db.patch(source._id, {
      activeSyncId: undefined,
      status: args.status,
      lastError: args.reason,
      updatedAt: now,
    });
    return true;
  },
});

/** Return non-secret completion counts for the local source probe. */
export const syncReport = internalQuery({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (!source) return null;
    const pages = await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .collect();
    const latest = await ctx.db
      .query('docSyncRuns')
      .withIndex('by_source', (index) => index.eq('sourceId', source._id))
      .order('desc')
      .first();
    return {
      status: source.status,
      pageCount: pages.length,
      redactionCount: latest?.redactionCount ?? 0,
      running: source.activeSyncId !== undefined,
      lastError: source.lastError,
    };
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
    await retireSourceState(ctx, source);
    for (const row of [...pages, ...mirrors]) await ctx.db.delete(row._id);
    await ctx.db.delete(source._id);
  }
  return sources.length;
}

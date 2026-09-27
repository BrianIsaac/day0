'use node';

import { v } from 'convex/values';
import type { PaginationResult } from 'convex/server';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { readerFor } from '../src/docs/readers';
import { markdownPageTitle } from '../src/docs/readers/folder';
import { unwrapWholePageFence } from '../src/docs/readers/mcp';
import { credentialSourceRef, redactCredentials } from '../src/docs/redaction';
import {
  RedactorUnavailableError,
  spanModelFromEnv,
  type SpanModel,
} from '../src/redaction/client';
import { ownerKnownValues } from '../src/redaction/known-values';
import { redactSecret } from '../src/surfaces/redact';
import { interruptedReadError } from '../src/lib/transport-error';
import { mirroredDocSlug, type DocPage, type DocSourceRecord } from '../src/docs/types';
import { ListingChangedError, type UnreadPage } from '../src/docs/readers/batch';
import {
  intakeScopeValues,
  restatedScope,
  type IntakeScope,
  type ScopePage,
} from '../src/surfaces/intake-scope';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { FINISHING_CURSOR, PAGED_READ } from './docSources';

export const SYNC_BATCH_SIZE = 25;

/**
 * The largest page Day0 stores, in UTF-8 bytes: under Convex's one-mebibyte
 * document (a page and its mirror each carry the whole body) and under the
 * redaction component's one-megabyte request once the text is JSON-escaped.
 * A larger page is not stored and keeps its last stored version (P5-11).
 */
export const MAX_STORED_PAGE_BYTES = 768 * 1024;

/** What one batch persisted, and the pages it could not. */
export interface PersistedBatch {
  refs: string[];
  credentialRefs: string[];
  pages: number;
  redactions: number;
  /** Pages read but not stored: too large, not redactable or not storable, each on its own. */
  unread: UnreadPage[];
}

/** A directory an author keeps procedures in: `runbooks/`, `how-to/`, `playbooks/`. */
const PROCEDURE_DIRECTORY = /^(?:runbooks?|how-?tos?|playbooks?)$/i;
const PROCEDURE_TITLE = /how[- ]to|runbook|playbook/i;

/**
 * The directories a page reference files the page under, outermost first.
 *
 * A URL reference is read by its path alone, so a query or a fragment that
 * happens to carry `/how-to/` files nothing (review m33); a relative
 * reference (a folder or git path) is its own path. The last segment is the
 * page itself, not a directory.
 */
function directoriesOf(ref: string): string[] {
  let path = ref;
  if (/^https?:\/\//i.test(ref)) {
    try {
      path = new URL(ref).pathname;
    } catch {
      // Not a URL after all: read the reference as the path it spells.
    }
  }
  return path.split('/').filter(Boolean).slice(0, -1);
}

/**
 * Classify a page for the Docs tab and the executor prompt, by its path or its title.
 *
 * A page kept under a procedures directory (`runbooks/`, `how-to/`,
 * `playbooks/`) is a how-to whatever its title says, so a checklist in
 * `runbooks/` reaches the executor as a procedure; otherwise the title or
 * the first `# ` heading decides, as before. The path is the author's own
 * filing, and a folder reader's title falls back to the file name.
 *
 * @param page - The page's reference (when the reader gives one), title and Markdown.
 * @returns The page's category.
 */
export function categoryForPage(
  page: Pick<DocPage, 'title' | 'markdown'> & { readonly ref?: string },
): 'team-doc' | 'how-to-guide' {
  if (
    page.ref !== undefined &&
    directoriesOf(page.ref).some((directory): boolean => PROCEDURE_DIRECTORY.test(directory))
  ) {
    return 'how-to-guide';
  }
  const firstHeading = page.markdown
    .split('\n')
    .find((line: string): boolean => /^#\s+/.test(line));
  return PROCEDURE_TITLE.test(`${page.title}\n${firstHeading || ''}`) ? 'how-to-guide' : 'team-doc';
}

/**
 * Redact the provider secret, the owner's stored values and every structural
 * secret from a persisted error.
 *
 * Args:
 *   error: Reader failure.
 *   secret: Optional provider credential.
 *   known: The owner's stored values, when the batch had resolved them.
 *
 * Returns:
 *   Bounded error text without credential material.
 */
export function safeSyncError(
  error: unknown,
  secret?: string,
  known: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecret(message, secret ?? '', known).slice(0, 500);
}

/**
 * Mirror safe pages into the existing per-agent Docs surface.
 *
 * Args:
 *   ctx: Convex action context.
 *   agentId: Agent receiving the pages.
 *   source: Owner-level source metadata.
 *   pages: Already-redacted pages to mirror.
 */
async function mirrorPages(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  source: Doc<'docSources'>,
  pages: DocPage[],
  syncRunId?: Id<'docSyncRuns'>,
): Promise<void> {
  for (const page of pages) {
    await ctx.runMutation(internal.mock.upsertDoc, {
      syncRunId,
      agentId,
      slug: mirroredDocSlug(source._id, page.ref),
      title: page.title,
      body: page.markdown,
      category: categoryForPage(page),
      sourceId: source._id,
      sourceRef: page.ref,
      sourceUrl: page.url,
    });
  }
}

/**
 * Store credentials, redact the raw body, and persist only safe page content.
 *
 * A page that cannot be stored (larger than `MAX_STORED_PAGE_BYTES`, refused
 * by the redaction or the credential store, or refused by the page store)
 * fails that page alone: it is named in `unread` and keeps its last stored
 * version (P5-11). Nothing of it is written before its credentials are
 * stored, so a failure never leaves a secret in a stored page. A stopped
 * redaction component, or a generation a newer sync superseded, is not one
 * page's failure and fails the batch.
 *
 * Args:
 *   ctx: Convex action context.
 *   source: Source that owns the provider pages.
 *   pages: Raw pages returned by the source reader.
 *   agents: Agents that inherit the source.
 *   model: The span model; defaults to the configured component.
 *
 * Returns:
 *   Safe completion metadata for the generation record.
 */
export async function persistPageBatch(
  ctx: ActionCtx,
  source: Doc<'docSources'>,
  pages: DocPage[],
  agents: Doc<'agents'>[],
  model: SpanModel | undefined = spanModelFromEnv(),
  knownValues?: readonly string[],
): Promise<PersistedBatch> {
  // The source came from the generation's own context read, so its active
  // generation is the one this batch belongs to; every write carries it.
  const syncRunId = source.activeSyncId;
  if (syncRunId === undefined) throw new Error('Documentation source has no running sync.');
  const safePages: DocPage[] = [];
  const credentialRefs: string[] = [];
  const unread: UnreadPage[] = [];
  let redactions = 0;
  // Every value the owner already stores is removed from every page before
  // the model is asked; resolved once for the batch.
  const known = knownValues ?? (await ownerKnownValues(ctx, source.userId));
  for (const page of pages) {
    try {
      const stored = await persistPage(ctx, source, page, syncRunId, { model, known });
      safePages.push(stored.page);
      credentialRefs.push(...stored.credentialRefs);
      redactions += stored.credentialRefs.length;
    } catch (error) {
      // Sync fails closed: a page the model could not read is not persisted,
      // and a stopped component is every page's failure, not this one's.
      if (error instanceof RedactorUnavailableError) throw error;
      const running = await ctx.runQuery(internal.docSources.syncContext, {
        sourceId: source._id,
        runId: syncRunId,
      });
      if (running === null) throw error;
      unread.push({ ref: page.ref, reason: safeSyncError(error, undefined, known) });
    }
  }
  for (const agent of agents) await mirrorPages(ctx, agent._id, source, safePages, syncRunId);
  return {
    refs: safePages.map((page: DocPage): string => page.ref),
    credentialRefs,
    pages: safePages.length,
    redactions,
    unread,
  };
}

/**
 * Redact one page, store its credentials and then the page.
 *
 * @throws Error when the page is too large to store, or any step refuses it.
 */
async function persistPage(
  ctx: ActionCtx,
  source: Doc<'docSources'>,
  page: DocPage,
  syncRunId: Id<'docSyncRuns'>,
  redaction: { readonly model: SpanModel | undefined; readonly known: readonly string[] },
): Promise<{ page: DocPage; credentialRefs: string[] }> {
  const bytes = Buffer.byteLength(page.markdown);
  if (bytes > MAX_STORED_PAGE_BYTES) {
    throw new Error(
      `The page is ${Math.ceil(bytes / 1024)} KiB, larger than the ${MAX_STORED_PAGE_BYTES / 1024} KiB Day0 stores.`,
    );
  }
  const unwrapped = unwrapWholePageFence(page.markdown);
  const result = await redactCredentials(
    unwrapped,
    markdownPageTitle(unwrapped, page.title),
    redaction,
  );
  const credentialRefs: string[] = [];
  for (const [index, credential] of result.credentials.entries()) {
    const ref = credentialSourceRef(page.ref, credential, result.credentials.length, index);
    await ctx.runAction(internal.credentials.store, {
      userId: source.userId,
      kind: 'value',
      label: credential.label,
      plaintext: credential.plaintext,
      explicitlyAssigned: credential.explicitlyAssigned,
      quoted: credential.quoted,
      source: {
        sourceId: source._id,
        ref,
      },
      syncRunId,
    });
    credentialRefs.push(ref);
  }
  const safePage: DocPage = {
    ...page,
    title: markdownPageTitle(result.markdown, result.title),
    markdown: result.markdown,
  };
  await ctx.runMutation(internal.docSources.upsertPage, { ...safePage, syncRunId });
  return { page: safePage, credentialRefs };
}

/**
 * What a generation keeps of the pages one batch could not read.
 *
 * Each keeps its stored version and its stored credentials: its ref and its
 * credential rows' refs go into the generation's current sets, so the final
 * batch neither deletes the page nor supersedes its values.
 *
 * @returns The refs and credential refs to add to the batch's own.
 */
async function keptUnreadPages(
  ctx: ActionCtx,
  source: Doc<'docSources'>,
  unread: readonly UnreadPage[],
): Promise<{ refs: string[]; credentialRefs: string[] }> {
  const credentialRefs: string[] = [];
  for (const page of unread) {
    const rows = await ctx.runQuery(internal.credentials.pageRowsForStore, {
      userId: source.userId,
      sourceId: source._id,
      pageRef: page.ref,
    });
    for (const row of rows) {
      if (typeof row.source !== 'string') credentialRefs.push(row.source.ref);
    }
  }
  return { refs: unread.map((page): string => page.ref), credentialRefs };
}

/** Whether a source is read with a secret: an MCP source always, another when linked with one. */
function readsWithSecret(source: Doc<'docSources'>): boolean {
  return source.kind === 'mcp' || source.credentialId !== undefined;
}

/** What one sync step reports to its caller. */
interface SyncResult {
  ok: boolean;
  pages: number;
  redactions: number;
  complete: boolean;
  reason?: string;
}

/**
 * Start a fenced source sync and execute its first bounded batch.
 *
 * A run that ended short is taken over from its cursor (`beginSync`), so the
 * first batch reads where that run stopped, or finishes it when it had read
 * every page. `fresh` starts at page one, as a new connection secret needs.
 */
export const syncSource = internalAction({
  args: { sourceId: v.id('docSources'), fresh: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<SyncResult> => {
    const source = await ctx.runQuery(internal.docSources.getInternal, {
      sourceId: args.sourceId,
    });
    if (!source) {
      return { ok: false, pages: 0, redactions: 0, complete: true, reason: 'source not found' };
    }
    const runId = await ctx.runMutation(internal.docSources.beginSync, {
      sourceId: source._id,
      fresh: args.fresh,
    });
    await ctx.runMutation(internal.docSources.pruneRunHistory, { sourceId: source._id });
    const context = await ctx.runQuery(internal.docSources.syncContext, {
      sourceId: source._id,
      runId,
    });
    return await ctx.runAction(internal.docSyncActions.syncBatch, {
      sourceId: source._id,
      runId,
      cursor: context?.run.cursor,
    });
  },
});

/**
 * Read and persist at most 25 pages, then schedule a secret-free continuation.
 *
 * After the last batch the run holds `FINISHING_CURSOR` and the same action
 * finishes it; a batch scheduled at that cursor (a resumed run) only finishes.
 */
export const syncBatch = internalAction({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    const context = await ctx.runQuery(internal.docSources.syncContext, {
      sourceId: args.sourceId,
      runId: args.runId,
    });
    if (!context) return { ok: false, pages: 0, redactions: 0, complete: true };
    const source = context.source;
    let secret: string | undefined;
    // Only a secret that could not be landed or opened makes the failure the credential's.
    let credentialUnavailable = false;
    let known: readonly string[] = [];
    try {
      if (args.cursor === FINISHING_CURSOR) return await finishGeneration(ctx, source, args.runId);
      known = await ownerKnownValues(ctx, source.userId);
      // An MCP source always reads with its connection secret; a git or URL
      // source reads with its own secret when it was linked with one (E-74).
      if (readsWithSecret(source)) {
        credentialUnavailable = true;
        if (!source.credentialId) throw new Error('Documentation credential is not landed.');
        secret = await ctx.runAction(internal.credentials.decrypt, {
          credentialId: source.credentialId,
        });
        credentialUnavailable = false;
      }
      const batch = await readerFor(source.kind).listPageBatch(
        source as DocSourceRecord,
        secret,
        args.cursor,
        SYNC_BATCH_SIZE,
      );
      if (batch.pages.length + batch.unread.length > SYNC_BATCH_SIZE) {
        throw new Error('Documentation reader exceeded the 25-page action limit.');
      }
      if (batch.nextCursor === FINISHING_CURSOR) {
        throw new Error('Documentation reader returned a continuation Day0 reserves.');
      }
      const agents = await ctx.runQuery(internal.docSources.agentsForSource, {
        sourceId: source._id,
      });
      const persisted = await persistPageBatch(
        ctx,
        source,
        batch.pages,
        agents,
        spanModelFromEnv(),
        known,
      );
      // A page the reader or the store could not take keeps its last stored
      // version and its credentials; its reason is stored with nothing secret in it.
      const unread = [
        ...batch.unread.map(
          (page): UnreadPage => ({
            ref: page.ref,
            reason: safeSyncError(page.reason, secret, known),
          }),
        ),
        ...persisted.unread,
      ];
      const kept = await keptUnreadPages(ctx, source, unread);
      if (batch.nextCursor !== undefined && batch.nextCursor === args.cursor) {
        throw new Error('Documentation reader repeated its continuation cursor.');
      }
      const nextCursor = batch.nextCursor ?? FINISHING_CURSOR;
      const recorded = await ctx.runMutation(internal.docSources.recordSyncBatch, {
        sourceId: source._id,
        runId: args.runId,
        currentCursor: args.cursor,
        nextCursor,
        refs: [...persisted.refs, ...kept.refs],
        credentialRefs: [...persisted.credentialRefs, ...kept.credentialRefs],
        pageCount: persisted.pages,
        redactionCount: persisted.redactions,
        unread,
      });
      const counts = { pages: persisted.pages, redactions: persisted.redactions };
      if (!recorded) return { ok: false, ...counts, complete: true };
      if (nextCursor === FINISHING_CURSOR) return await finishGeneration(ctx, source, args.runId);
      await ctx.scheduler.runAfter(0, internal.docSyncActions.syncBatch, {
        sourceId: source._id,
        runId: args.runId,
        cursor: nextCursor,
      });
      return { ok: true, ...counts, complete: false };
    } catch (error) {
      if (error instanceof ListingChangedError) {
        const restarted = await ctx.runMutation(internal.docSources.restartSync, {
          sourceId: source._id,
          runId: args.runId,
        });
        if (restarted !== null) {
          await ctx.scheduler.runAfter(0, internal.docSyncActions.syncBatch, {
            sourceId: source._id,
            runId: restarted,
          });
        }
        return { ok: restarted !== null, pages: 0, redactions: 0, complete: false };
      }
      // A read cut off mid-batch is recorded as the transient it is, with its cause.
      // A stopped redaction component is a person's to start, not a transient.
      const reason = safeSyncError(
        error instanceof RedactorUnavailableError
          ? error
          : (interruptedReadError(error, 'The documentation read') ?? error),
        secret,
        known,
      );
      await ctx.runMutation(internal.docSources.failSync, {
        sourceId: source._id,
        runId: args.runId,
        status: credentialUnavailable ? 'credential-not-landed' : 'error',
        reason,
      });
      return { ok: false, pages: 0, redactions: 0, complete: true, reason };
    }
  },
});

/** What walking one finishing step over a source's rows counted. */
interface PruneTotals {
  kept: number;
  removed: number;
}

/**
 * Finish a generation that has read every page, one bounded transaction at a time.
 *
 * The stored pages and mirrors it did not list are removed in pages, the
 * employees' intake scopes are re-read against the pages as they now stand
 * (real mode), and `finishSync` supersedes the credentials no page states and
 * publishes the synced state with what each step counted. Each step is fenced
 * on the run, so a newer sync stops it; a finish cut off part-way resumes at
 * `FINISHING_CURSOR`. A completed generation schedules discovery and the
 * re-orientation of the absent systems its pages may now document.
 */
async function finishGeneration(
  ctx: ActionCtx,
  source: Doc<'docSources'>,
  runId: Id<'docSyncRuns'>,
): Promise<SyncResult> {
  const pages = await pruneWhole(ctx, internal.docSources.prunePages, source._id, runId);
  const mirrors = await pruneWhole(ctx, internal.docSources.pruneMirrors, source._id, runId);
  const surfacesToReapprove =
    SURFACE_MODE === 'real' ? await restateScopes(ctx, source._id, runId) : 0;
  const completed = await ctx.runMutation(internal.docSources.finishSync, {
    sourceId: source._id,
    runId,
    currentCursor: FINISHING_CURSOR,
    refs: [],
    credentialRefs: [],
    pageCount: 0,
    redactionCount: 0,
    pruned: {
      pagesKept: pages.kept,
      pagesRemoved: pages.removed,
      mirrorsRemoved: mirrors.removed,
      surfacesToReapprove,
    },
  });
  if (completed.completed) {
    await ctx.scheduler.runAfter(0, internal.documentationDiscoveryActions.discoverSource, {
      sourceId: source._id,
      runId,
    });
    await ctx.scheduler.runAfter(0, internal.orientationActions.reorientAbsent, {
      sourceId: source._id,
    });
  }
  return {
    ok: completed.completed,
    pages: completed.pages,
    redactions: completed.redactions,
    complete: true,
  };
}

/** Walk one pruning step over the whole source, a bounded page per transaction. */
async function pruneWhole(
  ctx: ActionCtx,
  step: typeof internal.docSources.prunePages | typeof internal.docSources.pruneMirrors,
  sourceId: Id<'docSources'>,
  runId: Id<'docSyncRuns'>,
): Promise<PruneTotals> {
  const totals: PruneTotals = { kept: 0, removed: 0 };
  let cursor: string | null = null;
  for (;;) {
    const page: { kept: number; removed: number; continueCursor: string; isDone: boolean } =
      await ctx.runMutation(step, { sourceId, runId, cursor });
    totals.kept += page.kept;
    totals.removed += page.removed;
    if (page.isDone) return totals;
    cursor = page.continueCursor;
  }
}

/**
 * Re-read every approved intake scope quoting this source against its pages as they now stand.
 *
 * Only the pages that could state an approved value are held in memory (a
 * page states a value only by containing it); every page's ref is kept, so a
 * value whose page remains and stopped stating it drifts, and one whose page
 * is gone may follow it within its team (`restatedScope`).
 *
 * @returns How many cards the changed pages returned to the manager.
 */
async function restateScopes(
  ctx: ActionCtx,
  sourceId: Id<'docSources'>,
  runId: Id<'docSyncRuns'>,
): Promise<number> {
  const scoped = await ctx.runQuery(internal.docSources.scopedSurfaces, { sourceId });
  const values = scoped.flatMap((surface) =>
    intakeScopeValues(surface.intakeScope as IntakeScope)
      .filter((value): boolean => value.sourceId === sourceId)
      .map((value): string => value.value.toLowerCase()),
  );
  if (values.length === 0) return 0;
  const pages: ScopePage[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: PaginationResult<Doc<'docPages'>> = await ctx.runQuery(
      internal.docSources.pagesForSourceInternal,
      { sourceId, paginationOpts: { numItems: PAGED_READ.numItems, cursor } },
    );
    for (const row of page.page) {
      const text = row.markdown.toLowerCase();
      const statesValue = values.some((value): boolean => text.includes(value));
      pages.push({ sourceId, ref: row.ref, markdown: statesValue ? row.markdown : '' });
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  let reapprovals = 0;
  for (const surface of scoped) {
    const restated = restatedScope(surface.intakeScope, pages, sourceId);
    const drifted = restated.drift.length > 0;
    if (!drifted && JSON.stringify(restated.scope) === JSON.stringify(surface.intakeScope)) {
      continue;
    }
    const outcome = await ctx.runMutation(internal.docSources.applyRestatedScope, {
      sourceId,
      runId,
      surfaceId: surface.surfaceId,
      read: surface.intakeScope,
      restated: restated.scope,
      drifted,
    });
    if (outcome === 'reapproval') reapprovals += 1;
  }
  return reapprovals;
}

/**
 * Mirror already-synced inherited sources for a newly deployed agent.
 *
 * Each source is read a bounded page at a time and mirrored as it is read.
 */
export const mirrorForAgent = internalAction({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ pages: number }> => {
    const sources = await ctx.runQuery(internal.docSources.sourcesForAgentInternal, {
      agentId: args.agentId,
    });
    let count = 0;
    for (const source of sources) {
      let cursor: string | null = null;
      for (;;) {
        const page: PaginationResult<Doc<'docPages'>> = await ctx.runQuery(
          internal.docSources.pagesForSourceInternal,
          { sourceId: source._id, paginationOpts: { numItems: PAGED_READ.numItems, cursor } },
        );
        const normalised = page.page.map(
          (row): DocPage => ({
            sourceId: source._id,
            ref: row.ref,
            title: row.title,
            url: row.url,
            markdown: row.markdown,
            updatedAt: row.updatedAt,
          }),
        );
        await mirrorPages(ctx, args.agentId, source, normalised);
        count += normalised.length;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      await ctx.runMutation(internal.documentationDiscovery.seedForAgent, {
        agentId: args.agentId,
        sourceId: source._id,
      });
    }
    return { pages: count };
  },
});

/** Periodically start every eligible source without waiting for continuations. */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sources: number; passed: number }> => {
    let started = 0;
    let passed = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: PaginationResult<Doc<'docSources'>> = await ctx.runQuery(
        internal.docSources.listSyncable,
        { paginationOpts: { numItems: 100, cursor } },
      );
      for (const source of page.page) {
        const result = await ctx.runAction(internal.docSyncActions.syncSource, {
          sourceId: source._id,
        });
        started += 1;
        if (result.ok) passed += 1;
      }
      if (page.isDone) return { sources: started, passed };
      cursor = page.continueCursor;
    }
  },
});

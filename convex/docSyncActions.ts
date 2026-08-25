'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { readerFor } from '../src/docs/readers';
import { markdownPageTitle } from '../src/docs/readers/folder';
import { unwrapWholePageFence } from '../src/docs/readers/mcp';
import { credentialSourceRef, redactCredentials } from '../src/docs/redaction';
import { mirroredDocSlug, type DocPage, type DocSourceRecord } from '../src/docs/types';

export const SYNC_BATCH_SIZE = 25;

export interface PersistedBatch {
  refs: string[];
  credentialRefs: string[];
  pages: number;
  redactions: number;
}

/**
 * Classify a page for the existing Docs tab and executor prompt.
 *
 * Args:
 *   page: Normalised documentation page.
 *
 * Returns:
 *   Existing mock-document category.
 */
export function categoryForPage(
  page: Pick<DocPage, 'title' | 'markdown'>,
): 'team-doc' | 'how-to-guide' {
  const firstHeading = page.markdown
    .split('\n')
    .find((line: string): boolean => /^#\s+/.test(line));
  return /how[- ]to|runbook|playbook/i.test(`${page.title}\n${firstHeading || ''}`)
    ? 'how-to-guide'
    : 'team-doc';
}

/**
 * Redact provider secrets and token-shaped values from a persisted error.
 *
 * Args:
 *   error: Reader failure.
 *   secret: Optional provider credential.
 *
 * Returns:
 *   Bounded error text without credential material.
 */
export function safeSyncError(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = secret ? message.replaceAll(secret, '<redacted>') : message;
  return redacted
    .replace(/(?:ntn_|lin_api_|xox[bpa]-|secret_)[A-Za-z0-9._-]+/gi, '<redacted>')
    .slice(0, 500);
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
): Promise<void> {
  for (const page of pages) {
    await ctx.runMutation(internal.mock.upsertDoc, {
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
 * Args:
 *   ctx: Convex action context.
 *   source: Source that owns the provider pages.
 *   pages: Raw pages returned by the source reader.
 *   agents: Agents that inherit the source.
 *
 * Returns:
 *   Safe completion metadata for the generation record.
 */
export async function persistPageBatch(
  ctx: ActionCtx,
  source: Doc<'docSources'>,
  pages: DocPage[],
  agents: Doc<'agents'>[],
): Promise<PersistedBatch> {
  const safePages: DocPage[] = [];
  const credentialRefs: string[] = [];
  let redactions = 0;
  for (const page of pages) {
    const unwrapped = unwrapWholePageFence(page.markdown);
    const title = markdownPageTitle(unwrapped, page.title);
    const result = redactCredentials(unwrapped, title);
    for (const [index, credential] of result.credentials.entries()) {
      const ref = credentialSourceRef(page.ref, credential, result.credentials.length, index);
      await ctx.runAction(internal.credentials.store, {
        userId: source.userId,
        kind: 'value',
        label: credential.label,
        plaintext: credential.plaintext,
        source: {
          sourceId: source._id,
          ref,
        },
      });
      credentialRefs.push(ref);
    }
    redactions += result.credentials.length;
    const safePage: DocPage = { ...page, title, markdown: result.markdown };
    await ctx.runMutation(internal.docSources.upsertPage, safePage);
    safePages.push(safePage);
  }
  for (const agent of agents) await mirrorPages(ctx, agent._id, source, safePages);
  return {
    refs: safePages.map((page: DocPage): string => page.ref),
    credentialRefs,
    pages: safePages.length,
    redactions,
  };
}

/** Start a fenced source sync and execute its first bounded batch. */
export const syncSource = internalAction({
  args: { sourceId: v.id('docSources') },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    pages: number;
    redactions: number;
    complete: boolean;
    reason?: string;
  }> => {
    const source = await ctx.runQuery(internal.docSources.getInternal, {
      sourceId: args.sourceId,
    });
    if (!source) {
      return { ok: false, pages: 0, redactions: 0, complete: true, reason: 'source not found' };
    }
    const runId = await ctx.runMutation(internal.docSources.beginSync, { sourceId: source._id });
    return await ctx.runAction(internal.docSyncActions.syncBatch, {
      sourceId: source._id,
      runId,
    });
  },
});

/** Read and persist at most 25 pages, then schedule a secret-free continuation. */
export const syncBatch = internalAction({
  args: {
    sourceId: v.id('docSources'),
    runId: v.id('docSyncRuns'),
    cursor: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    pages: number;
    redactions: number;
    complete: boolean;
    reason?: string;
  }> => {
    const context = await ctx.runQuery(internal.docSources.syncContext, {
      sourceId: args.sourceId,
      runId: args.runId,
    });
    if (!context) return { ok: false, pages: 0, redactions: 0, complete: true };
    const source = context.source;
    let secret: string | undefined;
    try {
      if (source.kind === 'mcp') {
        if (!source.credentialId) throw new Error('Documentation credential is not landed.');
        secret = await ctx.runAction(internal.credentials.decrypt, {
          credentialId: source.credentialId,
        });
      }
      const batch = await readerFor(source.kind).listPageBatch(
        source as DocSourceRecord,
        secret,
        args.cursor,
        SYNC_BATCH_SIZE,
      );
      if (batch.pages.length > SYNC_BATCH_SIZE) {
        throw new Error('Documentation reader exceeded the 25-page action limit.');
      }
      const agents = await ctx.runQuery(internal.docSources.agentsForSource, {
        sourceId: source._id,
      });
      const persisted = await persistPageBatch(ctx, source, batch.pages, agents);
      if (batch.nextCursor) {
        if (batch.nextCursor === args.cursor) {
          throw new Error('Documentation reader repeated its continuation cursor.');
        }
        const recorded = await ctx.runMutation(internal.docSources.recordSyncBatch, {
          sourceId: source._id,
          runId: args.runId,
          currentCursor: args.cursor,
          nextCursor: batch.nextCursor,
          refs: persisted.refs,
          credentialRefs: persisted.credentialRefs,
          pageCount: persisted.pages,
          redactionCount: persisted.redactions,
        });
        if (!recorded) return { ok: false, ...persisted, complete: true };
        await ctx.scheduler.runAfter(0, internal.docSyncActions.syncBatch, {
          sourceId: source._id,
          runId: args.runId,
          cursor: batch.nextCursor,
        });
        return { ok: true, ...persisted, complete: false };
      }
      const completed = await ctx.runMutation(internal.docSources.finishSync, {
        sourceId: source._id,
        runId: args.runId,
        currentCursor: args.cursor,
        refs: persisted.refs,
        credentialRefs: persisted.credentialRefs,
        pageCount: persisted.pages,
        redactionCount: persisted.redactions,
      });
      return {
        ok: completed.completed,
        pages: completed.pages,
        redactions: completed.redactions,
        complete: true,
      };
    } catch (error) {
      const reason = safeSyncError(error, secret);
      await ctx.runMutation(internal.docSources.failSync, {
        sourceId: source._id,
        runId: args.runId,
        status: source.kind === 'mcp' && !secret ? 'credential-not-landed' : 'error',
        reason,
      });
      return { ok: false, pages: 0, redactions: 0, complete: true, reason };
    }
  },
});

/** Mirror already-synced inherited sources for a newly deployed agent. */
export const mirrorForAgent = internalAction({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ pages: number }> => {
    const sources = await ctx.runQuery(internal.docSources.sourcesForAgentInternal, {
      agentId: args.agentId,
    });
    let count = 0;
    for (const source of sources) {
      const pages = await ctx.runQuery(internal.docSources.pagesForSourceInternal, {
        sourceId: source._id,
      });
      const normalised = pages.map(
        (page): DocPage => ({
          sourceId: source._id,
          ref: page.ref,
          title: page.title,
          url: page.url,
          markdown: page.markdown,
          updatedAt: page.updatedAt,
        }),
      );
      await mirrorPages(ctx, args.agentId, source, normalised);
      count += pages.length;
    }
    return { pages: count };
  },
});

/** Periodically start every eligible source without waiting for continuations. */
export const syncAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sources: number; passed: number }> => {
    const sources = await ctx.runQuery(internal.docSources.listSyncable, {});
    let passed = 0;
    for (const source of sources) {
      const result = await ctx.runAction(internal.docSyncActions.syncSource, {
        sourceId: source._id,
      });
      if (result.ok) passed += 1;
    }
    return { sources: sources.length, passed };
  },
});

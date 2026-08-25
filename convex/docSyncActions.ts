'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { readerFor } from '../src/docs/readers';
import { mirroredDocSlug, type DocPage, type DocSourceRecord } from '../src/docs/types';

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
 * Redact the only source secret available to a sync before persisting errors.
 *
 * Args:
 *   error: Reader failure.
 *   secret: Optional provider credential.
 *
 * Returns:
 *   Bounded error text without the credential value.
 */
export function safeSyncError(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = secret ? message.replaceAll(secret, '<redacted>') : message;
  return redacted
    .replace(/(?:ntn_|lin_api_|xox[baprs]-)[A-Za-z0-9_-]+/g, '<redacted>')
    .slice(0, 500);
}

/**
 * Mirror normalised pages into the existing per-agent Docs surface.
 *
 * Args:
 *   ctx: Convex action context.
 *   agentId: Agent receiving the pages.
 *   source: Owner-level source metadata.
 *   pages: Pages to mirror.
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

/** Sync one documentation source and mirror it to every inheriting agent. */
export const syncSource = internalAction({
  args: { sourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<{ ok: boolean; pages: number; reason?: string }> => {
    const source = await ctx.runQuery(internal.docSources.getInternal, {
      sourceId: args.sourceId,
    });
    if (!source) return { ok: false, pages: 0, reason: 'source not found' };
    const secret = source.credentialRef ? process.env[source.credentialRef] : undefined;
    if (source.kind === 'mcp' && (!source.credentialRef || !secret)) {
      const reason = `${source.credentialRef || 'MCP credential'} is not landed in the deployment.`;
      await ctx.runMutation(internal.docSources.setStatus, {
        sourceId: source._id,
        status: 'credential-not-landed',
        lastError: reason,
      });
      return { ok: false, pages: 0, reason };
    }
    try {
      const pages = await readerFor(source.kind).listPages(source as DocSourceRecord, secret);
      for (const page of pages) {
        await ctx.runMutation(internal.docSources.upsertPage, page);
      }
      await ctx.runMutation(internal.docSources.deleteMissingPages, {
        sourceId: source._id,
        currentRefs: pages.map((page: DocPage): string => page.ref),
      });
      const agents = await ctx.runQuery(internal.docSources.agentsForSource, {
        sourceId: source._id,
      });
      for (const agent of agents) await mirrorPages(ctx, agent._id, source, pages);
      await ctx.runMutation(internal.docSources.setStatus, {
        sourceId: source._id,
        status: 'synced',
        lastSyncAt: Date.now(),
      });
      return { ok: true, pages: pages.length };
    } catch (error) {
      const reason = safeSyncError(error, secret);
      await ctx.runMutation(internal.docSources.setStatus, {
        sourceId: source._id,
        status: 'error',
        lastError: reason,
      });
      return { ok: false, pages: 0, reason };
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

/** Periodically resync every non-linking documentation source. */
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

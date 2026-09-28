'use node';

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { discoverMcpTools } from '../src/docs/readers/mcp';
import type { DocSourceRecord } from '../src/docs/types';

interface McpProbeResult {
  toolNames: string[];
  elapsedMs: number;
}

/**
 * Discover one linked MCP server through its encrypted stored credential.
 *
 * Args:
 *   ctx: Convex action context.
 *   args: Stored documentation source identifier.
 *
 * Returns:
 *   Provider tool names and elapsed discovery time.
 *
 * Raises:
 *   Error: If the source or its active credential is unavailable.
 */
export async function probeMcpHandler(
  ctx: ActionCtx,
  args: { docSourceId: Id<'docSources'> },
  discover: typeof discoverMcpTools = discoverMcpTools,
): Promise<McpProbeResult> {
  const source = await ctx.runQuery(internal.docSources.getInternal, {
    sourceId: args.docSourceId,
  });
  if (!source || source.kind !== 'mcp' || !source.credentialId) {
    throw new Error('Credential-backed MCP documentation source not found.');
  }
  const credential = await ctx.runAction(internal.credentials.decrypt, {
    credentialId: source.credentialId,
  });
  const startedAt = performance.now();
  const toolNames = await discover(source as DocSourceRecord, credential);
  return { toolNames, elapsedMs: Math.round(performance.now() - startedAt) };
}

export const probeMcp = internalAction({
  args: { docSourceId: v.id('docSources') },
  handler: async (ctx, args): Promise<McpProbeResult> => await probeMcpHandler(ctx, args),
});

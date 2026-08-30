'use node';

import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
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

interface FolderProbeResult {
  title: string;
  ref: string;
}

/**
 * Convert Mastra's namespaced MCP tool keys to provider tool names.
 *
 * Args:
 *   toolNames: Names returned by `MCPClient.listToolsWithErrors`.
 *   serverName: The configured Mastra server name.
 *
 * Returns:
 *   Sorted provider tool names without the server namespace.
 */
export function normaliseToolNames(toolNames: string[], serverName: string): string[] {
  const prefix = `${serverName}_`;
  return toolNames
    .map((name): string => (name.startsWith(prefix) ? name.slice(prefix.length) : name))
    .sort((left, right): number => left.localeCompare(right));
}

/**
 * Read a Markdown page title without exposing the page body.
 *
 * Args:
 *   markdown: Markdown source text.
 *   fallback: Title to use when no level-one heading exists.
 *
 * Returns:
 *   The first level-one heading, or the supplied fallback.
 */
export function markdownTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split('\n')) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) return heading[1].replace(/\s+#+$/, '').trim();
  }
  return fallback;
}

/**
 * Resolve a requested documentation directory inside the configured root.
 *
 * Args:
 *   docsRoot: Absolute root mounted into the backend container.
 *   requestedRoot: Relative directory requested by the operator.
 *
 * Returns:
 *   The absolute requested directory.
 *
 * Raises:
 *   Error: If the requested directory escapes the documentation root.
 */
export function resolveDocsDirectory(docsRoot: string, requestedRoot: string): string {
  const base = resolve(docsRoot);
  const requested = resolve(base, requestedRoot);
  const fromBase = relative(base, requested);
  if (
    fromBase === '..' ||
    fromBase.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromBase)
  ) {
    throw new Error('Folder probe root must stay inside DAY0_DOCS_ROOT.');
  }
  return requested;
}

/**
 * Find the first Markdown file below a directory in deterministic order.
 *
 * Args:
 *   directory: Directory to search recursively.
 *
 * Returns:
 *   The first Markdown path, or undefined when no Markdown page exists.
 */
async function firstMarkdownFile(directory: string): Promise<string | undefined> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right): number =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return path;
    if (entry.isDirectory()) {
      const nested = await firstMarkdownFile(path);
      if (nested) return nested;
    }
  }
  return undefined;
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
async function probeMcpHandler(
  ctx: ActionCtx,
  args: { docSourceId: Id<'docSources'> },
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
  const toolNames = await discoverMcpTools(source as DocSourceRecord, credential);
  return { toolNames, elapsedMs: Math.round(performance.now() - startedAt) };
}

/**
 * Read one Markdown page through the backend's read-only documentation mount.
 *
 * Args:
 *   _ctx: Convex action context, unused because the probe is read-only.
 *   args: Relative directory below `DAY0_DOCS_ROOT`.
 *
 * Returns:
 *   The page title and path relative to the documentation root.
 *
 * Raises:
 *   Error: If no Markdown page exists below the requested directory.
 */
async function probeFolderHandler(
  _ctx: ActionCtx,
  args: { root: string },
): Promise<FolderProbeResult> {
  const docsRoot = resolve(process.env.DAY0_DOCS_ROOT || '/docs');
  const requested = resolveDocsDirectory(docsRoot, args.root);
  const path = await firstMarkdownFile(requested);
  if (!path) throw new Error(`No Markdown pages found under ${args.root}.`);
  const markdown = await readFile(path, 'utf8');
  const fallback = basename(path, '.md').replaceAll('-', ' ');
  return { title: markdownTitle(markdown, fallback), ref: relative(docsRoot, path) };
}

export const probeMcp = internalAction({
  args: { docSourceId: v.id('docSources') },
  handler: probeMcpHandler,
});

export const probeFolder = internalAction({
  args: { root: v.string() },
  handler: probeFolderHandler,
});

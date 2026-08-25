'use node';

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { MCPClient } from '@mastra/mcp';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './_generated/server';

interface McpProbeResult {
  toolNames: string[];
  elapsedMs: number;
}

interface FolderProbeResult {
  title: string;
  ref: string;
}

const MCP_PROBE_TARGETS: Record<string, string> = {
  LINEAR_API_KEY: 'https://mcp.linear.app/mcp',
  NOTION_TOKEN: 'http://notion-mcp:3000/mcp',
};

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
 * Refuse any probe target that is not the exact allowlisted pair.
 *
 * A public action accepting arbitrary URLs could send a deployment
 * credential to a caller-controlled host, so the credential reference and
 * the URL must both match one allowlist entry exactly.
 *
 * Args:
 *   url: Requested MCP URL.
 *   headerEnv: Environment variable named as the bearer credential.
 *
 * Returns:
 *   The allowlisted URL, normalised.
 *
 * Raises:
 *   Error: If the reference is malformed, unknown, or paired with another URL.
 */
export function assertAllowlistedProbe(url: string, headerEnv: string): URL {
  if (!/^[A-Z][A-Z0-9_]*$/.test(headerEnv)) {
    throw new Error('headerEnv must be an uppercase environment variable name.');
  }
  const allowedUrl = MCP_PROBE_TARGETS[headerEnv];
  let requested: URL;
  try {
    requested = new URL(url);
  } catch {
    throw new Error('MCP probe target and credential reference are not allowlisted.');
  }
  if (!allowedUrl || requested.href !== new URL(allowedUrl).href) {
    throw new Error('MCP probe target and credential reference are not allowlisted.');
  }
  return requested;
}

/**
 * Discover one MCP server from inside the Convex Node action runtime.
 *
 * Args:
 *   _ctx: Convex action context, unused because the probe is read-only.
 *   args: MCP URL and deployment environment variable holding its bearer token.
 *
 * Returns:
 *   Provider tool names and elapsed discovery time.
 *
 * Raises:
 *   Error: If configuration is missing, the URL is unsafe, or discovery fails.
 */
async function probeMcpHandler(
  _ctx: ActionCtx,
  args: { url: string; headerEnv: string },
): Promise<McpProbeResult> {
  const url = assertAllowlistedProbe(args.url, args.headerEnv);
  const credential = process.env[args.headerEnv];
  if (!credential) throw new Error(`${args.headerEnv} is not configured in the deployment.`);

  const client = new MCPClient({
    id: `day0-probe-${randomUUID()}`,
    servers: {
      probe: {
        url,
        allowedHosts: [url.host],
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      },
    },
    timeout: 30_000,
  });
  const startedAt = performance.now();
  try {
    const { tools, errors } = await client.listToolsWithErrors({ perServerTimeoutMs: 30_000 });
    if (errors.probe) {
      throw new Error(errors.probe.replaceAll(credential, '<redacted>'));
    }
    const toolNames = normaliseToolNames(Object.keys(tools), 'probe');
    if (toolNames.length === 0) throw new Error('MCP server returned no tools.');
    return { toolNames, elapsedMs: Math.round(performance.now() - startedAt) };
  } finally {
    await client.disconnect();
  }
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
  args: { url: v.string(), headerEnv: v.string() },
  handler: probeMcpHandler,
});

export const probeFolder = internalAction({
  args: { root: v.string() },
  handler: probeFolderHandler,
});

'use node';

import { z } from 'zod';
import { v } from 'convex/values';
import { agentJson, makeAgent } from '../src/lib/mastra';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';

const URL_PATTERN = /https?:\/\/[^\s)>"'`]+/gi;
const NO_SURFACE_PATTERN =
  /no approved (?:api|mcp|connection|surface)|no endpoint|no approved connection surface/i;

const orientationSchema = z.object({
  path: z.enum(['mcp', 'documented-api', 'browser-driven', 'escalate']),
  fallbackPath: z.enum(['mcp', 'documented-api', 'browser-driven', 'escalate']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  endpoint: z.string().optional(),
  scopeRequested: z.array(z.string()),
  credentialOwner: z.string().optional(),
  credentialMethod: z.enum(['api-key', 'bot-token', 'oauth', 'none', 'unknown']),
  blastRadius: z.string(),
  costBand: z.enum(['none', 'low', 'medium', 'high']),
  expiresInDays: z.number().int().positive(),
  rollback: z.string(),
  openQuestions: z.array(z.string()),
});

type OrientationDraft = z.infer<typeof orientationSchema>;
type Evidence = { sourceId: string; ref: string; quote: string; url?: string };
type RegistryRemote = { type?: unknown; url?: unknown };
type RegistryServer = {
  description?: unknown;
  name?: unknown;
  remotes?: unknown;
  title?: unknown;
};

const orientationAgent = makeAgent(
  'surface-orientation',
  [
    'You classify how a workplace system can be reached using only supplied team documentation.',
    'Never invent an endpoint, credential, tool, owner or approval.',
    'Prefer MCP when the evidence names MCP, documented-api when it names an HTTP API, browser-driven only when it names a web UI, and escalate otherwise.',
    'The caller verifies every proposed path against literal evidence or the public MCP registry.',
  ].join('\n'),
);

/**
 * Select a concise evidence line that names a system.
 *
 * Args:
 *   markdown: Documentation page content.
 *   system: Manager-named system to locate.
 *
 * Returns:
 *   The first matching line, or undefined when the page does not name it.
 */
export function evidenceLine(markdown: string, system: string): string | undefined {
  return markdown
    .split('\n')
    .find((line: string): boolean => line.toLowerCase().includes(system.toLowerCase()))
    ?.trim();
}

/**
 * Decide whether a page is specifically about one named system.
 *
 * Args:
 *   markdown: Documentation page content.
 *   system: Manager-named system.
 *
 * Returns:
 *   True when the first markdown heading names the system.
 */
export function isDedicatedSystemPage(markdown: string, system: string): boolean {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1];
  return Boolean(heading?.toLowerCase().includes(system.toLowerCase()));
}

/**
 * Restrict path classification to text that actually concerns the system.
 *
 * Args:
 *   markdown: Documentation page content.
 *   system: Manager-named system.
 *
 * Returns:
 *   The whole dedicated page, or only paragraphs that name the system.
 */
export function relevantSystemText(markdown: string, system: string): string {
  if (isDedicatedSystemPage(markdown, system)) return markdown;
  const needle = system.toLowerCase();
  return markdown
    .split(/\n\s*\n/)
    .flatMap((paragraph: string): string[] => {
      if (!paragraph.toLowerCase().includes(needle)) return [];
      const tableLines = paragraph
        .split('\n')
        .filter((line: string): boolean => line.trimStart().startsWith('|'));
      if (tableLines.length < 2) return [paragraph];
      return tableLines.filter((line: string): boolean => line.toLowerCase().includes(needle));
    })
    .join('\n\n');
}

/**
 * Detect an explicit no-surface statement scoped to the named system.
 *
 * Args:
 *   markdown: Documentation page content.
 *   system: Manager-named system.
 *
 * Returns:
 *   True only when relevant text explicitly denies an approved connection.
 */
export function explicitlyDeniesSurface(markdown: string, system: string): boolean {
  if (isDedicatedSystemPage(markdown, system)) return NO_SURFACE_PATTERN.test(markdown);
  const needle = system.toLowerCase();
  return markdown.split('\n').some(
    (line: string): boolean =>
      line.toLowerCase().includes(needle) && NO_SURFACE_PATTERN.test(line),
  );
}

/**
 * Read the best Streamable HTTP endpoint from an MCP Registry response.
 *
 * Args:
 *   payload: Untrusted registry JSON.
 *   system: System name used to reject unrelated search results.
 *
 * Returns:
 *   A matching Streamable HTTP endpoint, or undefined.
 */
export function registryRemoteEndpoint(payload: unknown, system: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const entries = (payload as { servers?: unknown }).servers;
  if (!Array.isArray(entries)) return undefined;
  const tokens = system.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const server = (entry as { server?: RegistryServer }).server;
    if (!server) continue;
    const identity = [server.name, server.title, server.description]
      .filter((value: unknown): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    if (!tokens.every((token: string): boolean => identity.includes(token))) continue;
    if (!Array.isArray(server.remotes)) continue;
    const remote = (server.remotes as RegistryRemote[]).find(
      (candidate: RegistryRemote): boolean =>
        candidate.type === 'streamable-http' &&
        typeof candidate.url === 'string' &&
        /^https:\/\//i.test(candidate.url),
    );
    if (typeof remote?.url === 'string') return remote.url;
  }
  return undefined;
}

/**
 * Query the public MCP Registry for a named system.
 *
 * Args:
 *   system: Manager-named system.
 *
 * Returns:
 *   A registry-evidenced Streamable HTTP endpoint, or undefined.
 */
async function discoverRegistryEndpoint(system: string): Promise<string | undefined> {
  const url = new URL('https://registry.modelcontextprotocol.io/v0/servers');
  url.searchParams.set('search', system);
  url.searchParams.set('limit', '10');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return undefined;
    return registryRemoteEndpoint((await response.json()) as unknown, system);
  } catch {
    return undefined;
  }
}

/**
 * Produce a conservative draft when model classification is unavailable.
 *
 * Args:
 *   surface: Declared surface row.
 *   relevantText: Documentation excerpts scoped to that surface.
 *
 * Returns:
 *   A complete orientation artefact for hard-rule validation.
 */
function fallbackDraft(surface: Doc<'surfaces'>, relevantText: string): OrientationDraft {
  const hasUrl = /https?:\/\//i.test(relevantText);
  const path = /\bmcp\b/i.test(relevantText)
    ? 'mcp'
    : /\bapi\b/i.test(relevantText)
      ? 'documented-api'
      : hasUrl
        ? 'browser-driven'
        : 'escalate';
  return {
    path,
    fallbackPath: 'escalate',
    confidence: 0.6,
    reasoning: 'Classified conservatively from literal linked-documentation evidence.',
    scopeRequested: [`${surface.slug}:read`, `${surface.slug}:write`],
    credentialMethod: 'unknown',
    blastRadius: 'One named work system for this agent.',
    costBand: 'none',
    expiresInDays: 30,
    rollback: 'Revoke the credential and reject the surface.',
    openQuestions: ['Confirm the approved connection details.'],
  };
}

/**
 * Ask the orientation classifier for a structured connect-request draft.
 *
 * Args:
 *   surface: Declared surface row.
 *   relevantText: Documentation excerpts scoped to that surface.
 *
 * Returns:
 *   A schema-validated draft, with a deterministic fallback on model failure.
 */
async function draftOrientation(
  surface: Doc<'surfaces'>,
  relevantText: string,
): Promise<OrientationDraft> {
  try {
    return await agentJson<OrientationDraft>({
      agent: orientationAgent,
      schema: orientationSchema,
      user: [
        `System: ${surface.displayName}`,
        `Class: ${surface.class}`,
        'Documentation evidence:',
        relevantText.slice(0, 32_000),
      ].join('\n\n'),
    });
  } catch {
    return fallbackDraft(surface, relevantText);
  }
}

/** Orient every declared system from owner-linked documentation. */
export const run = internalAction({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ proposed: number; absent: number }> => {
    const surfaces: Doc<'surfaces'>[] = await ctx.runQuery(
      internal.orientationData.surfacesForAgent,
      args,
    );
    const pages = await ctx.runQuery(internal.orientationData.pagesForAgent, args);
    let proposed = 0;
    let absent = 0;
    for (const surface of surfaces.filter(
      (row: Doc<'surfaces'>): boolean => row.verdict === 'declared',
    )) {
      const matches = pages.filter((page): boolean =>
        page.markdown.toLowerCase().includes(surface.displayName.toLowerCase()),
      );
      const evidence: Evidence[] = matches.slice(0, 8).map(
        (page): Evidence => ({
          sourceId: String(page.sourceId),
          ref: page.ref,
          quote: evidenceLine(page.markdown, surface.displayName) || page.title,
          url: page.url,
        }),
      );
      const relevantText = matches
        .map((page): string => relevantSystemText(page.markdown, surface.displayName))
        .join('\n\n');
      const explicitNone = matches.some((page): boolean =>
        explicitlyDeniesSurface(page.markdown, surface.displayName),
      );
      if (matches.length === 0 || explicitNone) {
        await ctx.runMutation(internal.surfaces.markAbsent, {
          surfaceId: surface._id,
          searched: [surface.displayName, surface.class],
          whereFound: evidence,
        });
        absent += 1;
        continue;
      }

      const draft = await draftOrientation(surface, relevantText);
      const urls = relevantText.match(URL_PATTERN) ?? [];
      const documentedMcp = urls.find((url: string): boolean => /\/mcp(?:[/?#]|$)/i.test(url));
      const documentedApi = urls.find((url: string): boolean => /\/api(?:[/?#]|$)/i.test(url));
      const documentedWebUi = urls.find(
        (url: string): boolean => url !== documentedMcp && url !== documentedApi,
      );
      const registryEndpoint =
        !documentedMcp && /\bmcp\b/i.test(relevantText)
          ? await discoverRegistryEndpoint(surface.displayName)
          : undefined;
      const mcpEndpoint = documentedMcp ?? registryEndpoint;
      const path =
        (draft.path === 'mcp' || /\bmcp\b/i.test(relevantText)) && mcpEndpoint
          ? 'mcp'
          : draft.path === 'documented-api' && documentedApi
            ? 'documented-api'
            : draft.path === 'browser-driven' && documentedWebUi
              ? 'browser-driven'
              : 'escalate';
      const endpoint =
        path === 'mcp'
          ? mcpEndpoint
          : path === 'documented-api'
            ? documentedApi
            : path === 'browser-driven'
              ? documentedWebUi
              : undefined;
      const credentialRef = /\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY)\b/.exec(relevantText)?.[0];
      const request = {
        target: {
          system: surface.displayName,
          class: surface.class,
          chosenPath: path,
          fallbackPath: draft.fallbackPath,
          confidence: endpoint ? draft.confidence : Math.min(draft.confidence, 0.65),
          reasoning: draft.reasoning,
        },
        evidence,
        scopeRequested:
          draft.scopeRequested.length > 0
            ? draft.scopeRequested
            : [`${surface.slug}:read`, `${surface.slug}:write`],
        credential: {
          owner: draft.credentialOwner,
          method: credentialRef?.includes('BOT')
            ? 'bot-token'
            : credentialRef
              ? 'api-key'
              : draft.credentialMethod,
          envName: credentialRef || '',
        },
        blastRadius: draft.blastRadius,
        costBand: draft.costBand,
        expiresInDays: draft.expiresInDays,
        rollback: draft.rollback,
        openQuestions:
          endpoint || draft.openQuestions.length > 0
            ? draft.openQuestions
            : ['Confirm the approved connection endpoint.'],
      };
      await ctx.runMutation(internal.surfaces.propose, {
        surfaceId: surface._id,
        request,
        whereFound: evidence,
        path,
        fallbackPath: draft.fallbackPath,
        endpoint,
        credentialRef,
      });
      proposed += 1;
    }
    return { proposed, absent };
  },
});

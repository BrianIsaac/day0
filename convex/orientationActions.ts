'use node';

import { z } from 'zod';
import { v } from 'convex/values';
import type { GenericId } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import { agentJson, makeAgent } from '../src/lib/mastra';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';

const URL_PATTERN = /https?:\/\/[^\s)>"'`]+/gi;
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;
const MCP_SEGMENT = /\/mcp(?:[/?#]|$)/i;
const API_BASE = /\/api(?:[/?#]|$)|^https?:\/\/api\./i;

/**
 * Phrases by which team documentation says a system has no approved way in.
 *
 * Matched against a dedicated system page as a whole, or against a single
 * line that also names the system, so a denial about one system never
 * poisons another. A URL found in a sentence that matches here is never
 * treated as documented evidence.
 */
const NO_SURFACE_PATTERN =
  /\bno (?:approved |official |supported |sanctioned )?(?:api|mcp(?: server)?|connection(?: surface)?|integration(?: surface)?|endpoint|surface|access path)\b|\bnot (?:yet )?(?:an? )?approved\b|\bno approved\b/i;

const orientationSchema = z.object({
  path: z.enum(['mcp', 'documented-api', 'browser-driven', 'escalate']),
  fallbackPath: z.enum(['mcp', 'documented-api', 'browser-driven', 'escalate']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  endpoint: z.string().optional(),
  scopeRequested: z.array(z.string()),
  credential: z.object({
    found: z.enum(['value', 'location', 'none']),
    label: z.string().optional(),
    location: z.string().optional(),
    evidenceRef: z.string().optional(),
    method: z.enum(['api-key', 'bot-token', 'oauth', 'unknown']),
    governanceFinding: z.string().optional(),
  }),
  blastRadius: z.string(),
  costBand: z.enum(['none', 'low', 'medium', 'high']),
  expiresInDays: z.number().int().positive(),
  rollback: z.string(),
  openQuestions: z.array(z.string()),
});

type OrientationDraft = z.infer<typeof orientationSchema>;
type OrientationPath = OrientationDraft['path'];
type Evidence = { sourceId: string; ref: string; quote: string; url?: string };
type CredentialId = GenericId<'credentials'>;

type StoredCredentialSummary = {
  _id: CredentialId;
  label: string;
  revokedAt?: number;
};

/**
 * Lane A's read for a page-derived row, keyed the way its sync stored it.
 *
 * Orientation never calls `store`: the value was encrypted at sync time and
 * the marker is the only thing left on the page, so resolving it is a read.
 * Calling `store` without plaintext would be refused by lane A for a value
 * kind, and inventing a value is exactly what this run must never do.
 */
const credentialInternal = internal as unknown as {
  credentials: {
    bySourceForStore: FunctionReference<
      'query',
      'internal',
      { userId: string; sourceId: Id<'docSources'>; ref: string },
      StoredCredentialSummary | null
    >;
  };
};

/**
 * How many values lane A's sync can qualify on one page before its
 * label-qualified refs stop being tried here.
 */
const MAX_CREDENTIALS_PER_PAGE = 8;

export type CredentialMethod = 'api-key' | 'bot-token' | 'oauth' | 'unknown';

export interface CredentialFinding {
  found: 'value' | 'location' | 'none';
  label?: string;
  location?: string;
  evidenceRef?: string;
  method: CredentialMethod;
  governanceFinding?: string;
  sourceId?: string;
}

export interface CredentialPage {
  sourceId: string;
  ref: string;
  title: string;
  markdown: string;
}

const CREDENTIAL_MARKER = /<credential:\s*([^,>]+),\s*stored>/gi;
const CREDENTIAL_LOCATION = /\b(?:credential|api key|bot token|configuration token|access token)\b/i;
const CREDENTIAL_OWNER_OR_LOCATION =
  /\b(?:administrator|admin|owner|vault|approval|approve|issues?|provides?|hands? over|created? in|generated? in)\b/i;
const GOVERNANCE_FINDING = 'credential found in a shared page - rotate into a vault';

/** URLs the documentation attributes to one system, grouped by what they document. */
export interface DocumentedEndpoints {
  mcp?: string;
  api?: string;
  webUi?: string;
  /** A plaintext `http:` endpoint on a public host that was refused as an API or MCP base. */
  insecure?: string;
}
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
    'Credential values are already replaced with <credential: label, stored>; report that marker as found=value without copying or inventing a value.',
    'When the docs name a vault, administrator or OAuth installation procedure instead, report found=location and summarise only that documented location or procedure.',
    'The caller verifies every proposed path against literal evidence or the public MCP registry.',
  ].join('\n'),
);

/**
 * Build a whole-word matcher for a system name.
 *
 * "Slack" must not match "Slackbot", and "Linear" must not match "nonlinear":
 * the name has to stand as its own word or words. Punctuation between the
 * words of a multi-word name is tolerated ("Northstar-CRM"), as is a
 * possessive or other suffix that is not a letter or digit ("Linear's").
 *
 * Args:
 *   system: Manager-named system.
 *
 * Returns:
 *   A case-insensitive regular expression with no global flag.
 */
export function systemNamePattern(system: string): RegExp {
  const words = system
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const body = words.length > 0 ? words.join('[^a-z0-9]*') : '(?!)';
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}

/**
 * Decide whether text names a system as a whole word or phrase.
 *
 * Args:
 *   text: Documentation text.
 *   system: Manager-named system.
 *
 * Returns:
 *   True when the system is named, not merely contained in a longer word.
 */
export function namesSystem(text: string, system: string): boolean {
  return systemNamePattern(system).test(text);
}

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
  const pattern = systemNamePattern(system);
  return markdown
    .split('\n')
    .find((line: string): boolean => pattern.test(line))
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
  return heading !== undefined && namesSystem(heading, system);
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
  const pattern = systemNamePattern(system);
  return markdown
    .split(/\n\s*\n/)
    .flatMap((paragraph: string): string[] => {
      if (!pattern.test(paragraph)) return [];
      const tableLines = paragraph
        .split('\n')
        .filter((line: string): boolean => line.trimStart().startsWith('|'));
      if (tableLines.length < 2) return [paragraph];
      return tableLines.filter((line: string): boolean => pattern.test(line));
    })
    .join('\n\n');
}

/**
 * Infer the access method from redacted documentation text.
 *
 * Args:
 *   text: System-scoped documentation and any credential label.
 *
 * Returns:
 *   The safest method supported by literal wording in the documentation.
 */
function credentialMethodFor(text: string): CredentialMethod {
  if (/\boauth\b|\bconfiguration token\b|\binstall(?:ation)?\b/i.test(text)) return 'oauth';
  if (/\bbot token\b|\bxox[bpa]-\b/i.test(text)) return 'bot-token';
  if (/\bapi key\b|\bservice token\b|\bpersonal key\b|\baccess token\b/i.test(text)) {
    return 'api-key';
  }
  return 'unknown';
}

/**
 * Summarise an OAuth landing procedure without adding ungrounded steps.
 *
 * Args:
 *   text: Documentation scoped to the named system.
 *
 * Returns:
 *   A compact procedure assembled from the documentation's own relevant lines.
 */
function oauthProcedure(text: string): string {
  const lines = text
    .split('\n')
    .map((line: string): string => line.replace(/^\s*(?:\d+\.|[-*])\s*/, '').trim())
    .filter(
      (line: string): boolean =>
        line.length > 0 &&
        /\b(?:configuration token|manifest|install|oauth|bot token|administrator)\b/i.test(line),
    );
  return [...new Set(lines)].join(' ').slice(0, 1_000);
}

/**
 * Extract credential metadata from pages whose values were redacted at sync.
 *
 * A stored marker is the only evidence of a value. OAuth and other location
 * findings carry only the documented procedure or location. No return shape
 * has a field capable of carrying plaintext.
 *
 * Args:
 *   pages: Redacted pages already matched to the named system.
 *   system: Manager-named system.
 *
 * Returns:
 *   Structured credential evidence safe to persist in the request artefact.
 */
export function extractCredentialFinding(
  pages: readonly CredentialPage[],
  system: string,
): CredentialFinding {
  for (const page of pages) {
    const scoped = relevantSystemText(page.markdown, system);
    for (const match of scoped.matchAll(CREDENTIAL_MARKER)) {
      const label = match[1]?.trim();
      if (!label) continue;
      const labelMethod = credentialMethodFor(label);
      return {
        found: 'value',
        label,
        evidenceRef: page.ref,
        method: labelMethod === 'unknown' ? credentialMethodFor(scoped) : labelMethod,
        governanceFinding: GOVERNANCE_FINDING,
        sourceId: page.sourceId,
      };
    }
  }

  for (const page of pages) {
    const scoped = relevantSystemText(page.markdown, system);
    if (/\boauth\b|\bconfiguration token\b/i.test(scoped)) {
      const location = oauthProcedure(scoped);
      if (location) {
        return {
          found: 'location',
          label: `${system} OAuth access`,
          location,
          evidenceRef: page.ref,
          method: 'oauth',
          sourceId: page.sourceId,
        };
      }
    }
  }

  for (const page of pages) {
    const scoped = relevantSystemText(page.markdown, system);
    const location = scoped
      .split('\n')
      .map((line: string): string => line.trim())
      .find(
        (line: string): boolean =>
          CREDENTIAL_LOCATION.test(line) &&
          CREDENTIAL_OWNER_OR_LOCATION.test(line) &&
          !NO_SURFACE_PATTERN.test(line),
      );
    if (location) {
      return {
        found: 'location',
        label: `${system} access`,
        location: location.slice(0, 500),
        evidenceRef: page.ref,
        method: credentialMethodFor(location),
        sourceId: page.sourceId,
      };
    }
  }

  return { found: 'none', method: 'unknown' };
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
  const pattern = systemNamePattern(system);
  return markdown
    .split('\n')
    .some((line: string): boolean => pattern.test(line) && NO_SURFACE_PATTERN.test(line));
}

/**
 * Read the host of a documented URL, tolerating malformed values.
 *
 * Args:
 *   url: Candidate URL text.
 *
 * Returns:
 *   The lowercase host, or an empty string when the text is not a URL.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Decide whether a URL host carries a system slug as whole labels.
 *
 * Labels are the dot- and hyphen-separated parts of the host, so
 * `mcp.linear.app` and `linear-mcp` carry `linear`, while `mcp.slackbot.example`
 * does not carry `slack`. A multi-word slug such as `northstar-crm` matches
 * when every word is a label (`crm.northstar.example`) or when the words
 * appear joined as one label (`northstarcrm.internal`).
 *
 * Args:
 *   host: Lowercase URL host, possibly with a port.
 *   slug: The system's surface slug.
 *
 * Returns:
 *   True when the host names the system.
 */
export function hostCarriesSlug(host: string, slug: string): boolean {
  const hostname = host.replace(/:\d+$/, '');
  const labels = new Set(hostname.split(/[.-]/).filter(Boolean));
  const words = slug.split('-').filter(Boolean);
  if (words.length === 0) return false;
  if (labels.has(words.join(''))) return true;
  return words.every((word: string): boolean => labels.has(word));
}

/**
 * Collect the URLs the documentation attributes to one system.
 *
 * A URL belongs to a system only when the prose of the sentence it appears
 * in names the system as a whole word (the URL text itself does not count),
 * or when the URL host carries the system slug as whole labels.
 * Co-occurrence in a paragraph is not attribution: a page that documents
 * Linear's MCP endpoint and mentions Slack in the next sentence documents
 * nothing for Slack, and a sentence about Slackbot documents nothing for
 * Slack. A sentence that denies a surface contributes no URL at all.
 *
 * Args:
 *   text: Documentation text already scoped to the system.
 *   system: Manager-named system.
 *   slug: The system's surface slug.
 *
 * Returns:
 *   Attributed URLs in document order, without trailing punctuation.
 */
export function attributedUrls(text: string, system: string, slug: string): string[] {
  const pattern = systemNamePattern(system);
  const urls = new Set<string>();
  for (const line of text.split('\n')) {
    for (const sentence of line.split(SENTENCE_BOUNDARY)) {
      if (NO_SURFACE_PATTERN.test(sentence)) continue;
      const named = pattern.test(sentence.replace(URL_PATTERN, ' '));
      for (const raw of sentence.match(URL_PATTERN) ?? []) {
        const url = raw.replace(/[.,;:!?]+$/, '');
        if (named || hostCarriesSlug(hostOf(url), slug)) urls.add(url);
      }
    }
  }
  return [...urls];
}

/**
 * Decide whether a host is private to this machine or the compose network.
 *
 * A single-label name (`playwright-mcp`), loopback, or an RFC 1918 address
 * never leaves the operator's own network, so a plaintext endpoint there
 * exposes nothing on the wire.
 *
 * Args:
 *   hostname: URL hostname without a port.
 *
 * Returns:
 *   True for a private host.
 */
export function isPrivateHost(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name === '::1') return true;
  if (!name.includes('.')) return true;
  const octets = name.split('.').map(Number);
  if (octets.length === 4 && octets.every((octet: number): boolean => Number.isInteger(octet))) {
    if (octets[0] === 127 || octets[0] === 10) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  }
  return false;
}

/**
 * Decide whether a credential may be sent to a documented endpoint.
 *
 * The probe and the executors put a bearer on every request to an API or
 * MCP endpoint, so the endpoint has to be `https:` unless it is private to
 * this network. A plaintext endpoint on a public host is documented, but it
 * is not admitted as the place to send a credential.
 *
 * Args:
 *   url: Attributed documentation URL.
 *
 * Returns:
 *   True when a credential may travel to the URL.
 */
export function isCredentialSafeEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Group attributed URLs by the kind of surface they document.
 *
 * Args:
 *   urls: URLs attributed to one system.
 *
 * Returns:
 *   The first MCP endpoint, the first API base, the first other URL, and
 *   the first plaintext public endpoint refused as an MCP or API base.
 */
export function documentedEndpoints(urls: string[]): DocumentedEndpoints {
  const safe = urls.filter(isCredentialSafeEndpoint);
  const insecure = urls.find(
    (url: string): boolean =>
      !isCredentialSafeEndpoint(url) && (MCP_SEGMENT.test(url) || API_BASE.test(url)),
  );
  const mcp = safe.find((url: string): boolean => MCP_SEGMENT.test(url));
  const api = safe.find((url: string): boolean => url !== mcp && API_BASE.test(url));
  const webUi = urls.find((url: string): boolean => url !== mcp && url !== api);
  return { mcp, api, webUi, insecure };
}

/**
 * Admit a connection path from literal evidence.
 *
 * The model drafts the artefact; the code decides the path. An attributed
 * MCP endpoint wins, then a documented API base regardless of whether the
 * text also says "mcp", then a web UI only when the model asked for the
 * browser path, otherwise escalate. Nothing outside the linked evidence,
 * the public registry included, can become an endpoint here.
 *
 * Args:
 *   draftPath: Path the model proposed.
 *   endpoints: URLs the documentation attributes to the system.
 *
 * Returns:
 *   The admitted path and, for admitted paths, its documented endpoint.
 */
export function choosePath(
  draftPath: OrientationPath,
  endpoints: DocumentedEndpoints,
): { path: OrientationPath; endpoint?: string } {
  if (endpoints.mcp) return { path: 'mcp', endpoint: endpoints.mcp };
  if (endpoints.api) return { path: 'documented-api', endpoint: endpoints.api };
  if (endpoints.webUi && draftPath === 'browser-driven') {
    return { path: 'browser-driven', endpoint: endpoints.webUi };
  }
  return { path: 'escalate' };
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
    credential: { found: 'none', method: 'unknown' },
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

/**
 * Validate a model-produced location finding against the pages it cites.
 *
 * Args:
 *   draft: Model-produced credential metadata.
 *   pages: Pages matched to this surface.
 *
 * Returns:
 *   A safe location finding, or `none` when the claim is not evidence-backed.
 */
function validatedDraftCredential(
  draft: OrientationDraft['credential'],
  pages: readonly CredentialPage[],
): CredentialFinding {
  if (
    draft.found !== 'location' ||
    !draft.location?.trim() ||
    !draft.evidenceRef ||
    !pages.some((page: CredentialPage): boolean => page.ref === draft.evidenceRef)
  ) {
    return { found: 'none', method: 'unknown' };
  }
  const page = pages.find(
    (candidate: CredentialPage): boolean => candidate.ref === draft.evidenceRef,
  );
  return {
    found: 'location',
    label: draft.label?.trim() || undefined,
    location: draft.location.trim().slice(0, 500),
    evidenceRef: draft.evidenceRef,
    method: draft.method,
    sourceId: page?.sourceId,
  };
}

/**
 * Source references lane A's sync may have used for a marker on one page.
 *
 * A page holding a single value is keyed by the page ref alone; a page
 * holding several is keyed by the page ref qualified with the value's
 * position and label. Both shapes are tried, exact page ref first.
 *
 * Args:
 *   pageRef: Stable page reference the marker was found on.
 *   label: Label carried by the marker.
 *
 * Returns:
 *   Candidate refs in the order they should be looked up.
 */
export function candidateCredentialRefs(pageRef: string, label: string): string[] {
  const qualified = Array.from(
    { length: MAX_CREDENTIALS_PER_PAGE },
    (_unused: unknown, index: number): string =>
      `${pageRef}#credential=${index + 1}-${encodeURIComponent(label)}`,
  );
  return [pageRef, ...qualified];
}

/**
 * Resolve a redacted marker to the encrypted row lane A stored at sync time.
 *
 * Args:
 *   ctx: Action context used for the internal read.
 *   userId: Owner of the documentation source.
 *   sourceId: Source the page belongs to.
 *   pageRef: Page the marker was found on.
 *   label: Marker label, which must match the stored row's label.
 *
 * Returns:
 *   The active row id, or undefined when no matching row exists or the read
 *   itself is unavailable (lane A not deployed).
 */
async function resolveStoredCredential(
  ctx: { runQuery: ActionCtx['runQuery'] },
  userId: string,
  sourceId: Id<'docSources'>,
  pageRef: string,
  label: string,
): Promise<CredentialId | undefined> {
  const wanted = label.trim().toLowerCase();
  for (const ref of candidateCredentialRefs(pageRef, label)) {
    let row: StoredCredentialSummary | null;
    try {
      row = await ctx.runQuery(credentialInternal.credentials.bySourceForStore, {
        userId,
        sourceId,
        ref,
      });
    } catch {
      return undefined;
    }
    if (!row) continue;
    if (row.revokedAt !== undefined) continue;
    if (row.label.trim().toLowerCase() === wanted) return row._id;
  }
  return undefined;
}

/**
 * Orient one declared system from owner-linked documentation.
 *
 * Each scheduled invocation owns one surface, so a slow model or provider
 * call cannot fail charter approval or prevent the other systems orienting.
 * Only surface ids cross the scheduler boundary.
 */
export const orientOne = internalAction({
  args: { surfaceId: v.id('surfaces') },
  handler: async (
    ctx,
    args,
  ): Promise<{ outcome: 'proposed' | 'absent' | 'skipped'; surfaceId: Id<'surfaces'> }> => {
    const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, args);
    if (!context || context.surface.verdict !== 'declared') {
      return { outcome: 'skipped', surfaceId: args.surfaceId };
    }
    const surface = context.surface;
    const pages: Doc<'docPages'>[] = await ctx.runQuery(internal.orientationData.pagesForAgent, {
      agentId: surface.agentId,
    });
    const matches = pages.filter((page: Doc<'docPages'>): boolean =>
      namesSystem(page.markdown, surface.displayName),
    );
    const evidence: Evidence[] = matches.slice(0, 8).map(
      (page: Doc<'docPages'>): Evidence => ({
        sourceId: String(page.sourceId),
        ref: page.ref,
        quote: evidenceLine(page.markdown, surface.displayName) || page.title,
        url: page.url,
      }),
    );
    const relevantText = matches
      .map((page: Doc<'docPages'>): string =>
        relevantSystemText(page.markdown, surface.displayName),
      )
      .join('\n\n');
    const endpoints = documentedEndpoints(
      attributedUrls(relevantText, surface.displayName, surface.slug),
    );
    const explicitNone = matches.some((page: Doc<'docPages'>): boolean =>
      explicitlyDeniesSurface(page.markdown, surface.displayName),
    );
    if (matches.length === 0 || (explicitNone && !endpoints.mcp && !endpoints.api)) {
      const recorded = await ctx.runMutation(internal.surfaces.markAbsent, {
        surfaceId: surface._id,
        searched: [surface.displayName, surface.class],
        whereFound: evidence,
      });
      return { outcome: recorded ? 'absent' : 'skipped', surfaceId: surface._id };
    }

    const draft = await draftOrientation(surface, relevantText);
    const { path, endpoint } = choosePath(draft.path, endpoints);
    const mentionsMcp = /\bmcp\b/i.test(relevantText);
    const registrySuggestion =
      path === 'escalate' && (draft.path === 'mcp' || mentionsMcp)
        ? await discoverRegistryEndpoint(surface.displayName)
        : undefined;
    const credentialPages: CredentialPage[] = matches.map(
      (page: Doc<'docPages'>): CredentialPage => ({
        sourceId: String(page.sourceId),
        ref: page.ref,
        title: page.title,
        markdown: page.markdown,
      }),
    );
    const extractedCredential = extractCredentialFinding(
      credentialPages,
      surface.displayName,
    );
    const credential =
      extractedCredential.found === 'none'
        ? validatedDraftCredential(draft.credential, credentialPages)
        : extractedCredential;
    const openQuestions = [...draft.openQuestions];
    if (endpoints.insecure) {
      openQuestions.push(
        `The documented endpoint ${endpoints.insecure} is plaintext http on a public host and was not admitted; a credential is only sent over https.`,
      );
    }
    if (registrySuggestion) {
      openQuestions.push(
        `Confirm the MCP endpoint with IT; the public MCP Registry suggests ${registrySuggestion}, which is not linked evidence.`,
      );
    } else if (!endpoint && openQuestions.length === 0) {
      openQuestions.push('Confirm the approved connection endpoint.');
    }

    let credentialId: CredentialId | undefined;
    if (credential.found === 'value') {
      credentialId =
        credential.label && credential.evidenceRef && credential.sourceId && context.agent.userId
          ? await resolveStoredCredential(
              ctx,
              context.agent.userId,
              credential.sourceId as Id<'docSources'>,
              credential.evidenceRef,
              credential.label,
            )
          : undefined;
      if (!credentialId) {
        openQuestions.push(
          'The stored credential marker could not be resolved to an encrypted row; re-sync the documentation source.',
        );
      }
    }
    const { sourceId: _sourceId, ...requestCredential } = credential;
    void _sourceId;
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
      credential: requestCredential,
      registrySuggestion: registrySuggestion
        ? {
            endpoint: registrySuggestion,
            note: 'Public MCP Registry match, not linked evidence. IT enters the endpoint after confirming it.',
          }
        : undefined,
      blastRadius: draft.blastRadius,
      costBand: draft.costBand,
      expiresInDays: draft.expiresInDays,
      rollback: draft.rollback,
      openQuestions,
    };
    const recorded = await ctx.runMutation(internal.surfaces.propose, {
      surfaceId: surface._id,
      request,
      whereFound: evidence,
      path,
      fallbackPath: draft.fallbackPath,
      endpoint,
      credentialId,
      credentialLocation: credential.found === 'location' ? credential.location : undefined,
      expiresInDays: draft.expiresInDays,
    });
    return { outcome: recorded ? 'proposed' : 'skipped', surfaceId: surface._id };
  },
});

/**
 * Schedule one isolated orientation action per declared surface.
 *
 * Args:
 *   agentId: Agent whose declared systems should be oriented.
 *
 * Returns:
 *   Number of per-surface actions placed on the scheduler.
 */
export const run = internalAction({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    const surfaces: Doc<'surfaces'>[] = await ctx.runQuery(
      internal.orientationData.surfacesForAgent,
      args,
    );
    const declared = surfaces.filter(
      (surface: Doc<'surfaces'>): boolean => surface.verdict === 'declared',
    );
    for (const surface of declared) {
      await ctx.scheduler.runAfter(0, internal.orientationActions.orientOne, {
        surfaceId: surface._id,
      });
    }
    return { scheduled: declared.length };
  },
});

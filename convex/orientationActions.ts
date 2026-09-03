'use node';

import { z } from 'zod';
import { v } from 'convex/values';
import type { GenericId } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import { agentJson, makeAgent } from '../src/lib/mastra';
import { internalAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { containsTokenShape, redactTokenShapes, safeFailureMessage } from '../src/surfaces/redact';
import { browserTitleMarker } from '../src/surfaces/browser';

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

export const orientationSchema = z.object({
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
  kind: 'value' | 'location' | 'oauth';
  label: string;
  revokedAt?: number;
};

/** The stored row an orientation run attaches to a surface. */
interface ResolvedCredential {
  credentialId: CredentialId;
  kind: StoredCredentialSummary['kind'];
}

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
  /** One line for the surface row and the probe's reason; never persisted in the request. */
  summary?: string;
}

export interface CredentialPage {
  sourceId: string;
  ref: string;
  title: string;
  markdown: string;
}

const CREDENTIAL_MARKER = /<credential:\s*([^,>]+),\s*stored>/gi;
const CREDENTIAL_LOCATION =
  /\b(?:credential|api key|bot token|configuration token|access token)\b/i;
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

export interface SurfacePathCandidate {
  path: Exclude<OrientationPath, 'escalate'>;
  endpoint: string;
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
    'When the docs name a vault or an administrator who holds the credential instead, report found=location and summarise only that documented location.',
    'When the docs describe an OAuth installation procedure, report found=none with method=oauth and summarise only that documented procedure.',
    'The caller verifies every proposed path against literal evidence or the public MCP registry.',
  ].join('\n'),
);

/**
 * Build a whole-word matcher for a system name.
 *
 * "Slack" must not match "Slackbot", and "Linear" must not match "nonlinear":
 * the name has to stand as its own word or words. Punctuation between the
 * words of a multi-word name is tolerated ("Atlas-CRM"), as is a
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

/** A quote chosen for a surface card, and whether it attributes anything to the system. */
export interface EvidenceQuote {
  quote: string;
  /**
   * True when the sentence documents the system rather than merely naming it:
   * the heading of its dedicated page, a sentence attributing a URL to it, a
   * sentence denying it a surface, or a sentence carrying its credential marker.
   */
  attributed: boolean;
}

const CREDENTIAL_MARK = /<credential:[^>]*>|<redacted>/i;

/**
 * Select the sentence of a page that best evidences a system.
 *
 * The endpoint attribution rule applied to quotes: sentences are the unit,
 * a sentence counts when its prose names the system as a whole word (URL
 * text does not count) or when it carries a URL attributed to the system,
 * and a sentence that attributes something to the system - a URL, a
 * credential marker, the heading of its own page, or a line denying it a
 * surface - is preferred over one that only mentions it.
 * A Slack policy line
 * that says to preserve the Linear identifier names Linear but attributes
 * nothing to it, so it is evidence for Linear only when nothing better exists.
 *
 * Args:
 *   markdown: Documentation page content.
 *   system: Manager-named system to locate.
 *   slug: The system's surface slug.
 *
 * Returns:
 *   The attributing sentence when there is one, else the first naming
 *   sentence, else undefined when the page does not name the system.
 */
export function evidenceQuote(
  markdown: string,
  system: string,
  slug: string,
): EvidenceQuote | undefined {
  const pattern = systemNamePattern(system);
  let mention: string | undefined;
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const heading = /^#\s+(.+)$/.exec(trimmed)?.[1];
    if (heading !== undefined) {
      if (pattern.test(heading)) return { quote: trimmed, attributed: true };
      continue;
    }
    // A denial is read per line, as `explicitlyDeniesSurface` reads it: in a
    // table row the sentence that denies rarely repeats the system's name.
    if (pattern.test(trimmed.replace(URL_PATTERN, ' ')) && NO_SURFACE_PATTERN.test(trimmed)) {
      return { quote: trimmed, attributed: true };
    }
    for (const raw of trimmed.split(SENTENCE_BOUNDARY)) {
      const sentence = raw.trim();
      const urls = attributedUrls(sentence, system, slug);
      const named = pattern.test(sentence.replace(URL_PATTERN, ' '));
      if (!named && urls.length === 0) continue;
      const attributed = urls.length > 0 || CREDENTIAL_MARK.test(redactTokenShapes(sentence));
      if (attributed) return { quote: sentence, attributed: true };
      mention ??= sentence;
    }
  }
  return mention === undefined ? undefined : { quote: mention, attributed: false };
}

/**
 * Decide whether a page is specifically about one named system.
 *
 * Args:
 *   markdown: Documentation page content.
 *   system: Manager-named system.
 *   title: Provider page title when it is stored separately from Markdown.
 *
 * Returns:
 *   True when the first Markdown heading or the provider page title names the system.
 */
export function isDedicatedSystemPage(
  markdown: string,
  system: string,
  title?: string,
): boolean {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1];
  return (
    (heading !== undefined && namesSystem(heading, system)) ||
    (title !== undefined && namesSystem(title, system))
  );
}

/**
 * Restrict path classification to text that actually concerns the system.
 *
 * Args:
 *   markdown: Documentation page content.
 *   system: Manager-named system.
 *   title: Provider page title when it is stored separately from Markdown.
 *
 * Returns:
 *   The whole dedicated page, or only paragraphs that name the system.
 */
export function relevantSystemText(markdown: string, system: string, title?: string): string {
  if (isDedicatedSystemPage(markdown, system, title)) return markdown;
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
  const lines = redactTokenShapes(text)
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
 * Decide whether a stored marker belongs to the named system.
 *
 * A marker is attributed only when the page is dedicated to the system or
 * the marker's own label names it, so a shared page that stores Linear's
 * token next to a sentence about Slack lends nothing to Slack.
 *
 * Args:
 *   page: Page the marker was found on.
 *   label: Label carried by the marker.
 *   system: Manager-named system.
 *
 * Returns:
 *   True when the marker is evidence for this system.
 */
function markerBelongsToSystem(page: CredentialPage, label: string, system: string): boolean {
  return isDedicatedSystemPage(page.markdown, system, page.title) || namesSystem(label, system);
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
    const scoped = relevantSystemText(page.markdown, system, page.title);
    for (const match of scoped.matchAll(CREDENTIAL_MARKER)) {
      const label = match[1]?.trim();
      if (!label || !markerBelongsToSystem(page, label, system)) continue;
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
    const scoped = relevantSystemText(page.markdown, system, page.title);
    if (/\boauth\b|\bconfiguration token\b/i.test(scoped)) {
      const location = oauthProcedure(scoped);
      if (location) {
        return {
          found: 'none',
          label: `${system} OAuth access`,
          location,
          evidenceRef: page.ref,
          method: 'oauth',
          sourceId: page.sourceId,
          summary: `OAuth install flow documented in ${page.title}; the installing administrator lands the token`,
        };
      }
    }
  }

  for (const page of pages) {
    const scoped = relevantSystemText(page.markdown, system, page.title);
    const location = scoped
      .split('\n')
      .map((line: string): string => line.trim())
      .find(
        (line: string): boolean =>
          CREDENTIAL_LOCATION.test(line) &&
          CREDENTIAL_OWNER_OR_LOCATION.test(line) &&
          !NO_SURFACE_PATTERN.test(line) &&
          !containsTokenShape(line),
      );
    if (location) {
      const clipped = location.slice(0, 500);
      return {
        found: 'location',
        label: `${system} access`,
        location: clipped,
        evidenceRef: page.ref,
        method: credentialMethodFor(location),
        sourceId: page.sourceId,
        summary: clipped,
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
 *   title: Provider page title when it is stored separately from Markdown.
 *
 * Returns:
 *   True only when relevant text explicitly denies an approved connection.
 */
export function explicitlyDeniesSurface(
  markdown: string,
  system: string,
  title?: string,
): boolean {
  if (isDedicatedSystemPage(markdown, system, title)) return NO_SURFACE_PATTERN.test(markdown);
  const pattern = systemNamePattern(system);
  return markdown
    .split('\n')
    .some((line: string): boolean => pattern.test(line) && NO_SURFACE_PATTERN.test(line));
}

/**
 * Drop URLs that address the documentation itself rather than a system.
 *
 * A handbook index links to each system's own page, and those links are
 * attributed to the system they name - correctly, as evidence. They are not
 * addresses of the system: they are addresses of the page about it. An MCP or
 * API URL is unambiguous enough to survive this on its own, but a web UI is
 * decided by elimination, so without this rule every system documented in a
 * linked wiki would look as though it had one.
 *
 * Args:
 *   urls: URLs the documentation attributes to a system.
 *   pages: The agent's own documentation pages.
 *
 * Returns:
 *   The URLs that are not the address of a linked documentation page.
 */
export function withoutDocumentationUrls(
  urls: readonly string[],
  pages: readonly { url?: string }[],
): string[] {
  const documentation = new Set<string>();
  for (const page of pages) {
    if (!page.url) continue;
    documentation.add(page.url);
    const host = hostOf(page.url);
    if (host) documentation.add(host);
  }
  if (documentation.size === 0) return [...urls];
  return urls.filter((url: string): boolean => {
    if (documentation.has(url)) return false;
    const host = hostOf(url);
    return !(host && documentation.has(host));
  });
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
 * `mcp.kanban.app` and `kanban-mcp` carry `kanban`, while `mcp.mailbot.example`
 * does not carry `mail`. A multi-word slug such as `atlas-crm` matches
 * when every word is a label (`crm.atlas.example`) or when the words
 * appear joined as one label (`atlascrm.internal`).
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
 * Build the descending set of connection paths admitted by literal evidence.
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
 *   hasLoginCredential: Whether the same linked evidence carries a stored web login.
 *
 * Returns:
 *   Evidence-backed, probeable paths in strongest-to-weakest order.
 */
export function connectionLadder(
  draftPath: OrientationPath,
  endpoints: DocumentedEndpoints,
  hasLoginCredential = false,
  hasProbeMarker = false,
): SurfacePathCandidate[] {
  const candidates: SurfacePathCandidate[] = [];
  if (endpoints.mcp) candidates.push({ path: 'mcp', endpoint: endpoints.mcp });
  if (endpoints.api) candidates.push({ path: 'documented-api', endpoint: endpoints.api });
  // The browser rung used to need a stored web login, which was literal
  // evidence. Dropping it for the public floor left the model's own draft path
  // deciding whether a rung is admitted, which is the one thing the model does
  // not decide here. The documented page-title marker restores an evidence
  // condition, and it is the condition the browser probe already refuses
  // without - so both approvers now ratify only rungs that can actually run.
  if (endpoints.webUi && hasProbeMarker && (draftPath === 'browser-driven' || hasLoginCredential)) {
    candidates.push({ path: 'browser-driven', endpoint: endpoints.webUi });
  }
  return candidates;
}

/** Admit the strongest evidence-backed path, or escalate when none is probeable. */
export function choosePath(
  draftPath: OrientationPath,
  endpoints: DocumentedEndpoints,
  hasLoginCredential = false,
  hasProbeMarker = false,
): { path: OrientationPath; endpoint?: string } {
  return (
    connectionLadder(draftPath, endpoints, hasLoginCredential, hasProbeMarker)[0] ?? {
      path: 'escalate',
    }
  );
}

/** Whether a page-derived stored value is explicitly a web login credential. */
export function isBrowserLoginCredential(credential: CredentialFinding): boolean {
  return (
    credential.found === 'value' &&
    /\b(?:login|password|passcode|passphrase)\b/i.test(credential.label ?? '')
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
    credential: { found: 'none', method: 'unknown' },
    blastRadius: 'One named work system for this agent.',
    costBand: 'none',
    expiresInDays: 30,
    rollback: 'Revoke the credential and reject the surface.',
    openQuestions: ['Confirm the approved connection details.'],
  };
}

/** How long one surface's model call may take before literal evidence decides alone. */
export const MODEL_BUDGET_MS = 120_000;

/** A draft together with where it came from. */
export interface OrientationDraftResult {
  draft: OrientationDraft;
  /** Present when the model did not decide: a sentence for the card's open questions. */
  note?: string;
}

/**
 * Ask the orientation classifier for a structured connect-request draft.
 *
 * A provider call that never answers must not hold the surface: after the
 * budget the literal-evidence fallback decides and the card says so. The
 * abandoned call is left to time out on its own inside the action.
 *
 * Args:
 *   surface: Declared surface row.
 *   relevantText: Documentation excerpts scoped to that surface.
 *   budgetMs: Longest wait for the model before falling back.
 *
 * Returns:
 *   A schema-validated draft, with a deterministic fallback on model failure.
 */
export async function draftOrientation(
  surface: Doc<'surfaces'>,
  relevantText: string,
  budgetMs: number = MODEL_BUDGET_MS,
): Promise<OrientationDraftResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<'timeout'>((resolve): void => {
    timer = setTimeout((): void => resolve('timeout'), budgetMs);
  });
  const model = agentJson<OrientationDraft>({
    agent: orientationAgent,
    schema: orientationSchema,
    user: [
      `System: ${surface.displayName}`,
      `Class: ${surface.class}`,
      'Documentation evidence:',
      relevantText.slice(0, 32_000),
    ].join('\n\n'),
  });
  try {
    const outcome = await Promise.race([model, budget]);
    if (outcome === 'timeout') {
      model.catch((): void => undefined);
      return {
        draft: fallbackDraft(surface, relevantText),
        note: `The model did not classify this system within ${Math.round(budgetMs / 1000)} s; the path was decided from literal documentation evidence alone.`,
      };
    }
    return { draft: outcome };
  } catch (error) {
    return {
      draft: fallbackDraft(surface, relevantText),
      note: `The model could not classify this system (${safeFailureMessage(error, '', 'no detail')}); the path was decided from literal documentation evidence alone.`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  const location = redactTokenShapes(draft.location.trim()).slice(0, 500);
  return {
    found: 'location',
    label: draft.label ? redactTokenShapes(draft.label.trim()) || undefined : undefined,
    location,
    evidenceRef: draft.evidenceRef,
    method: draft.method,
    sourceId: page?.sourceId,
    summary: location,
  };
}

/**
 * Scrub every free-text field of a model draft.
 *
 * The model only ever receives redacted text, but a page that escaped
 * redaction would otherwise be copied straight into the card by a model
 * that quotes its input.
 *
 * Args:
 *   draft: Schema-validated model output.
 *
 * Returns:
 *   The same draft with token shapes removed from every string.
 */
function sanitisedDraft(draft: OrientationDraft): OrientationDraft {
  return {
    ...draft,
    reasoning: redactTokenShapes(draft.reasoning),
    endpoint: draft.endpoint ? redactTokenShapes(draft.endpoint) : undefined,
    scopeRequested: draft.scopeRequested.map(redactTokenShapes),
    credential: {
      ...draft.credential,
      label: draft.credential.label ? redactTokenShapes(draft.credential.label) : undefined,
      location: draft.credential.location
        ? redactTokenShapes(draft.credential.location)
        : undefined,
      governanceFinding: draft.credential.governanceFinding
        ? redactTokenShapes(draft.credential.governanceFinding)
        : undefined,
    },
    blastRadius: redactTokenShapes(draft.blastRadius),
    rollback: redactTokenShapes(draft.rollback),
    openQuestions: draft.openQuestions.map(redactTokenShapes),
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
): Promise<ResolvedCredential | undefined> {
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
    if (row.label.trim().toLowerCase() === wanted) {
      return { credentialId: row._id, kind: row.kind };
    }
  }
  return undefined;
}

/**
 * Choose the pages and quotes a surface card cites.
 *
 * Every page that attributes something to the system is cited with its
 * attributing sentence. Pages that only mention the system are cited only
 * when no page attributes anything, so a card never quotes a co-occurrence
 * beside real evidence. At most eight pages are cited, in page order.
 *
 * Args:
 *   pages: Pages whose text names the system.
 *   system: Manager-named system.
 *   slug: The system's surface slug.
 *
 * Returns:
 *   Evidence entries with token shapes redacted.
 */
export function selectEvidence(
  pages: readonly Doc<'docPages'>[],
  system: string,
  slug: string,
): Evidence[] {
  const quoted = pages.map(
    (page: Doc<'docPages'>): { page: Doc<'docPages'>; quote: EvidenceQuote } => ({
      page,
      quote: evidenceQuote(page.markdown, system, slug) ?? {
        quote: page.title,
        attributed: namesSystem(page.title, system),
      },
    }),
  );
  const attributed = quoted.filter(({ quote }): boolean => quote.attributed);
  return (attributed.length > 0 ? attributed : quoted).slice(0, 8).map(
    ({ page, quote }): Evidence => ({
      sourceId: String(page.sourceId),
      ref: page.ref,
      quote: redactTokenShapes(quote.quote),
      url: page.url,
    }),
  );
}

/** Outcome of one isolated orientation job. */
export interface OrientationOutcome {
  outcome: 'proposed' | 'absent' | 'skipped' | 'failed';
  surfaceId: Id<'surfaces'>;
}

/** Collaborators a test can replace to drive one orientation run. */
export interface OrientationDependencies {
  draft: typeof draftOrientation;
  registry: typeof discoverRegistryEndpoint;
}

const orientationDependencies: OrientationDependencies = {
  draft: draftOrientation,
  registry: discoverRegistryEndpoint,
};

/** The subset of the action context one orientation run needs. */
export type OrientationCtx = Pick<ActionCtx, 'runQuery' | 'runMutation'>;

/**
 * Orient one declared system from owner-linked documentation.
 *
 * Args:
 *   ctx: Action context.
 *   surfaceId: Declared surface to orient.
 *   dependencies: Model and registry collaborators.
 *
 * Returns:
 *   The outcome recorded on the surface.
 *
 * Raises:
 *   Error: Any failure of a Convex read or write; the caller records it.
 */
export async function orientSurface(
  ctx: OrientationCtx,
  surfaceId: Id<'surfaces'>,
  dependencies: OrientationDependencies = orientationDependencies,
): Promise<OrientationOutcome> {
  const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, { surfaceId });
  if (!context || context.surface.verdict !== 'declared') {
    return { outcome: 'skipped', surfaceId };
  }
  const surface = context.surface;
  const pages: Doc<'docPages'>[] = await ctx.runQuery(internal.orientationData.pagesForAgent, {
    agentId: surface.agentId,
  });
  const matches = pages.filter((page: Doc<'docPages'>): boolean =>
    namesSystem(`${page.title}\n${page.markdown}`, surface.displayName),
  );
  const evidence: Evidence[] = selectEvidence(matches, surface.displayName, surface.slug);
  const relevantText = redactTokenShapes(
    matches
      .map((page: Doc<'docPages'>): string =>
        relevantSystemText(page.markdown, surface.displayName, page.title),
      )
      .join('\n\n'),
  );
  const endpoints = documentedEndpoints(
    withoutDocumentationUrls(
      attributedUrls(relevantText, surface.displayName, surface.slug),
      pages,
    ),
  );
  const explicitNone = matches.some((page: Doc<'docPages'>): boolean =>
    explicitlyDeniesSurface(page.markdown, surface.displayName, page.title),
  );
  // A page that says "no API" while documenting the web UI staff use has
  // recorded a surface, and it is the one the browser floor exists for.
  // `absent` means no surface is recorded at all, never "no API" - reading it
  // the other way would make the floor unreachable from exactly the pages that
  // describe it. A denial with no attributed address of any kind is still absent.
  if (
    matches.length === 0 ||
    (explicitNone && !endpoints.mcp && !endpoints.api && !endpoints.webUi)
  ) {
    const recorded = await ctx.runMutation(internal.surfaces.markAbsent, {
      surfaceId: surface._id,
      searched: [surface.displayName, surface.class],
      whereFound: evidence,
    });
    return { outcome: recorded ? 'absent' : 'skipped', surfaceId: surface._id };
  }

  const drafted = await dependencies.draft(surface, relevantText);
  const draft = sanitisedDraft(drafted.draft);
  const credentialPages: CredentialPage[] = matches.map(
    (page: Doc<'docPages'>): CredentialPage => ({
      sourceId: String(page.sourceId),
      ref: page.ref,
      title: page.title,
      markdown: page.markdown,
    }),
  );
  const extractedCredential = extractCredentialFinding(credentialPages, surface.displayName);
  const credential =
    extractedCredential.found === 'none' && extractedCredential.method === 'unknown'
      ? validatedDraftCredential(draft.credential, credentialPages)
      : extractedCredential;
  const hasBrowserLogin = isBrowserLoginCredential(credential);
  const hasProbeMarker = browserTitleMarker(relevantText) !== undefined;
  const pathCandidates = connectionLadder(
    draft.path,
    endpoints,
    hasBrowserLogin,
    hasProbeMarker,
  );
  const selected: { path: OrientationPath; endpoint?: string } = pathCandidates[0] ?? {
    path: 'escalate',
  };
  const { path, endpoint } = selected;
  const fallbackPath = pathCandidates[1]?.path ?? 'escalate';
  const credentiallessBrowser =
    pathCandidates.some((candidate): boolean => candidate.path === 'browser-driven') &&
    !hasBrowserLogin;
  const mentionsMcp = /\bmcp\b/i.test(relevantText);
  const registrySuggestion =
    path === 'escalate' && (draft.path === 'mcp' || mentionsMcp)
      ? await dependencies.registry(surface.displayName)
      : undefined;
  const openQuestions = [...draft.openQuestions];
  if (drafted.note) openQuestions.push(drafted.note);
  if (credentiallessBrowser) {
    openQuestions.push(
      'No web login credential was found; browser access is limited to content the documented UI exposes without sign-in.',
    );
  }
  if (endpoints.webUi && !hasProbeMarker && draft.path === 'browser-driven') {
    openQuestions.push(
      `Document the page title Day0 should see at ${endpoints.webUi}, as "Probe marker: page title" followed by the title in backticks, before approving browser-driven access.`,
    );
  }
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

  let stored: ResolvedCredential | undefined;
  if (credential.found === 'value') {
    stored =
      credential.label && credential.evidenceRef && credential.sourceId && context.agent.userId
        ? await resolveStoredCredential(
            ctx,
            context.agent.userId,
            credential.sourceId as Id<'docSources'>,
            credential.evidenceRef,
            credential.label,
          )
        : undefined;
    if (!stored) {
      openQuestions.push(
        'The stored credential marker could not be resolved to an encrypted row; re-sync the documentation source.',
      );
    }
  }
  const { sourceId: _sourceId, summary: _summary, ...requestCredential } = credential;
  void _sourceId;
  void _summary;
  const request = {
    target: {
      system: surface.displayName,
      class: surface.class,
      chosenPath: path,
      fallbackPath,
      ladder: pathCandidates,
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
    fallbackPath,
    pathCandidates,
    endpoint,
    credentialId: stored?.credentialId,
    credentialKind: stored?.kind,
    credentialLocation: credential.found === 'value' ? undefined : credential.summary,
    expiresInDays: draft.expiresInDays,
  });
  return { outcome: recorded ? 'proposed' : 'skipped', surfaceId: surface._id };
}

/**
 * Orient one declared system from owner-linked documentation.
 *
 * Each scheduled invocation owns one surface, so a slow model or provider
 * call cannot fail charter approval or prevent the other systems orienting.
 * Only surface ids cross the scheduler boundary. A run that throws leaves
 * its surface `declared` with the failure as its reason, so the card says
 * what happened and the re-run control applies.
 */
export const orientOne = internalAction({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<OrientationOutcome> => {
    try {
      return await orientSurface(ctx, args.surfaceId);
    } catch (error) {
      await ctx.runMutation(internal.surfaces.recordOrientationFailure, {
        surfaceId: args.surfaceId,
        reason: safeFailureMessage(error, '', 'orientation failed without detail'),
      });
      return { outcome: 'failed', surfaceId: args.surfaceId };
    }
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
    let scheduled = 0;
    for (const surface of declared) {
      const claimed: boolean = await ctx.runMutation(internal.surfaces.scheduleOrientation, {
        surfaceId: surface._id,
      });
      if (claimed) scheduled += 1;
    }
    return { scheduled };
  },
});

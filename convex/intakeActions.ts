'use node';

import { randomUUID } from 'node:crypto';
import type { ToolExecutionContext } from '@mastra/core/tools';
import type { FunctionReference } from 'convex/server';
import type { GenericId } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import { SURFACE_MODE, type SurfaceMode } from '../src/lib/surface-mode';
import { safeFailureMessage } from '../src/surfaces/redact';
import { createSecretMcpClient } from '../src/surfaces/mcp-client';
import { browserComponentRefusal } from '../src/surfaces/browser';
import { documentedChannelNames } from '../src/surfaces/slack-policy';
import { extractDocumentedSystemOrder, orderSurfaceWaterfall } from '../src/surfaces/waterfall';
import type { WorkCandidate } from '../src/work/types';
import { parseDecisionReply, type DecisionReply } from '../src/work/manager-channel';

const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_MCP_PAGES = 5;
const MAX_SLACK_CHANNEL_PAGES = 3;
const MAX_SLACK_HISTORY_PAGES = 5;
const PAGE_SIZE = 100;

type CredentialId = GenericId<'credentials'>;

const credentialInternal = internal as unknown as {
  credentials: {
    decrypt: FunctionReference<'action', 'internal', { credentialId: CredentialId }, string>;
  };
};

interface McpToolDefinition {
  inputSchema?: unknown;
  name?: string;
}

interface McpExecutableTool {
  execute?: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
}

interface McpIntakeClient {
  listToolDefinitionsWithErrors(options?: { perServerTimeoutMs?: number }): Promise<{
    definitions: Record<string, Record<string, McpToolDefinition>>;
    errors: Record<string, string>;
  }>;
  toolFromDefinition(args: {
    serverName: string;
    definition: McpToolDefinition;
  }): Promise<McpExecutableTool>;
  disconnect(): Promise<void>;
}

interface IntakeRecord {
  surfaceId: Id<'surfaces'>;
  waterfallPosition: number;
  skipReason?: string;
  polledAt?: number;
}

interface IntakeSeed extends Omit<WorkCandidate, 'observedAt'> {
  agentId: Id<'agents'>;
}

interface IntakeDecisionReply {
  surfaceId: Id<'surfaces'>;
  userId: string;
  messageTs: string;
  reply: DecisionReply;
}

export interface IntakeRuntime {
  listSurfaces(): Promise<Doc<'surfaces'>[]>;
  getAgent(agentId: Id<'agents'>): Promise<Doc<'agents'> | null>;
  listPages(agentId: Id<'agents'>): Promise<Doc<'docPages'>[]>;
  decrypt(credentialId: CredentialId): Promise<string>;
  recordIntake(record: IntakeRecord): Promise<void>;
  recordDecisionPoll(record: { surfaceId: Id<'surfaces'>; polledAt: number }): Promise<void>;
  seed(candidate: IntakeSeed): Promise<void>;
  resolveDecision(reply: IntakeDecisionReply): Promise<void>;
  /** Decision requests that landed on this surface and are still undecided. */
  listOpenDecisionRequests(surfaceId: Id<'surfaces'>): Promise<Array<{ ts: string }>>;
}

export interface IntakeDependencies {
  fetcher?: IntakeFetcher;
  makeMcpClient?: (endpoint: URL, credential: string) => McpIntakeClient;
  mode?: SurfaceMode;
  now?: () => number;
  /** This deployment's browser driver address; absent means no browser component. */
  browserMcpUrl?: string;
}

export interface IntakeSweepResult {
  candidates: number;
  mode: SurfaceMode;
  polled: number;
  skipped: number;
  surfaces: number;
}

export type DecisionSweepResult = Omit<IntakeSweepResult, 'candidates'>;

interface LinearScope {
  project: string;
  team?: string;
}

interface McpPage {
  issues: Record<string, unknown>[];
  nextCursor?: string;
}

interface SlackChannel {
  id: string;
  name: string;
}

interface SlackMessage {
  text: string;
  ts: string;
  user?: string;
  /** The parent message when the mention itself sits inside a thread. */
  threadTs?: string;
}

interface ChatPollResult {
  candidates: WorkCandidate[];
  decisionReplies: Array<Omit<IntakeDecisionReply, 'surfaceId'>>;
}

type IntakeFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Convert an untrusted provider value to an object when possible.
 *
 * Args:
 *   value: Provider response fragment.
 *
 * Returns:
 *   The object value, or undefined for arrays and primitives.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Redact and bound one provider failure before it reaches surface metadata.
 *
 * Args:
 *   error: Untrusted provider or transport failure.
 *   credential: Decrypted bearer that must never be persisted.
 *
 * Returns:
 *   A single safe line suitable for a surface card.
 */
export function safeIntakeError(error: unknown, credential: string): string {
  return safeFailureMessage(error, credential, 'Provider intake failed.');
}

/**
 * Read the bounded Linear project and team named by the runbook.
 *
 * Args:
 *   pages: Documentation pages visible to one agent.
 *
 * Returns:
 *   The documented project and optional team identifier.
 *
 * Raises:
 *   Error: If no Linear project is documented.
 */
export function linearScopeFromPages(pages: readonly Doc<'docPages'>[]): LinearScope {
  const markdown = pages
    .filter((page: Doc<'docPages'>): boolean => /linear/i.test(`${page.title}\n${page.markdown}`))
    .map((page: Doc<'docPages'>): string => page.markdown)
    .join('\n');
  const project =
    /(?:^|\n)\s*-?\s*Project\s*:\s*`([^`]+)`/im.exec(markdown)?.[1] ??
    /\bproject\s+`([^`]+)`/i.exec(markdown)?.[1];
  if (!project?.trim()) throw new Error('Linear runbook names no project.');
  const team =
    /\bidentifier\s+`([^`]+)`/i.exec(markdown)?.[1] ??
    /(?:^|\n)\s*-?\s*Team\s*:\s*`([^`]+)`/im.exec(markdown)?.[1];
  return { project: project.trim(), team: team?.trim() };
}

/**
 * Read Slack channel names from the policy's explicit Channels field.
 *
 * Args:
 *   pages: Documentation pages visible to one agent.
 *
 * Returns:
 *   Unique channel names without the hash prefix.
 */
export function slackChannelsFromPages(pages: readonly Doc<'docPages'>[]): string[] {
  return documentedChannelNames(pages);
}

/**
 * Read top-level keys from a provider-discovered JSON schema.
 *
 * Args:
 *   schema: Untrusted MCP tool input schema.
 *
 * Returns:
 *   The schema property map, or an empty object.
 */
function schemaProperties(schema: unknown): Record<string, unknown> {
  const record = asRecord(schema);
  const properties = asRecord(record?.properties);
  return properties ?? {};
}

/**
 * Find one actual schema key from supported semantic spellings.
 *
 * Args:
 *   properties: Provider-discovered input properties.
 *   supported: Semantic spellings understood by the poller.
 *
 * Returns:
 *   The provider's exact key, or undefined.
 */
function discoveredArgument(
  properties: Record<string, unknown>,
  supported: readonly string[],
): string | undefined {
  const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = new Set(supported.map((name: string): string => normalise(name)));
  return Object.keys(properties).find((name: string): boolean => wanted.has(normalise(name)));
}

/** A Linear list request and which of its bounds the provider itself enforces. */
export interface LinearListRequest {
  args: Record<string, unknown>;
  /** True when the schema had a project argument; otherwise issues are filtered here. */
  projectEnforced: boolean;
  /** True when the schema had an updated-at argument; otherwise issues are filtered here. */
  checkpointEnforced: boolean;
}

/** Issue fields intake reads, requested by name when the schema lets a caller choose. */
const LINEAR_ISSUE_FIELDS = [
  'id',
  'title',
  'description',
  'url',
  'priority',
  'status',
  'statusType',
  'createdAt',
  'updatedAt',
  'createdBy',
  'assignee',
  'project',
  'projectId',
  'team',
] as const;

/**
 * Read the field names a schema's `fields` selector accepts.
 *
 * Args:
 *   properties: Provider-discovered input properties.
 *
 * Returns:
 *   The enumerated field names, or undefined when there is no such selector.
 */
function selectableFields(properties: Record<string, unknown>): Set<string> | undefined {
  const selector = asRecord(properties.fields);
  const items = asRecord(selector?.items);
  const names = items?.enum;
  if (!Array.isArray(names)) return undefined;
  return new Set(names.filter((name): name is string => typeof name === 'string'));
}

/**
 * Build a bounded Linear list request only from discovered argument names.
 *
 * Argument names come from the live schema, never from the runbook. When
 * the schema offers no way to express the project or the checkpoint, the
 * request is still made and the poller applies that bound to the returned
 * issues itself, so an unknown schema degrades to more reading, not to no
 * intake. When the schema lets the caller choose response fields, the
 * fields intake reads are named explicitly: Linear's default response omits
 * the project, so the client-side project bound and the checkpoint would
 * otherwise have nothing to compare.
 *
 * Args:
 *   inputSchema: Live schema advertised for list_issues.
 *   scope: Project and team read from the runbook.
 *   lastPolledAt: Previous completed poll checkpoint.
 *   cursor: Provider cursor for the next bounded page.
 *
 * Returns:
 *   Arguments accepted by the live schema and which bounds it enforces.
 *
 * Raises:
 *   Error: If the provider returned a cursor the schema cannot take back.
 */
export function linearListArguments(
  inputSchema: unknown,
  scope: LinearScope,
  lastPolledAt?: number,
  cursor?: string,
): LinearListRequest {
  const properties = schemaProperties(inputSchema);
  const args: Record<string, unknown> = {};
  const projectName = discoveredArgument(properties, ['project', 'projectName', 'projectId']);
  if (projectName) args[projectName] = scope.project;

  const teamName = discoveredArgument(properties, ['team', 'teamName', 'teamKey', 'teamId']);
  if (teamName && scope.team) args[teamName] = scope.team;

  const limitName = discoveredArgument(properties, ['limit', 'first', 'pageSize']);
  if (limitName) args[limitName] = PAGE_SIZE;

  const selectable = selectableFields(properties);
  if (selectable) {
    const fields = LINEAR_ISSUE_FIELDS.filter((name: string): boolean => selectable.has(name));
    if (fields.length > 0) args.fields = fields;
  }

  let checkpointEnforced = false;
  if (lastPolledAt !== undefined) {
    const updatedName = discoveredArgument(properties, [
      'updatedAt',
      'updatedAfter',
      'updatedSince',
      'updated_at',
    ]);
    if (updatedName) {
      args[updatedName] = new Date(Math.max(0, lastPolledAt - 1)).toISOString();
      checkpointEnforced = true;
    }
  }

  if (cursor) {
    const cursorName = discoveredArgument(properties, ['cursor', 'after', 'pageToken']);
    if (!cursorName) throw new Error('Linear list_issues returned an unsupported cursor.');
    args[cursorName] = cursor;
  }
  return { args, projectEnforced: projectName !== undefined, checkpointEnforced };
}

/**
 * Read the project an issue belongs to, in the shapes providers use.
 *
 * Args:
 *   issue: Provider issue object.
 *
 * Returns:
 *   The project name or id, or undefined when the issue carries none.
 */
export function issueProject(issue: Record<string, unknown>): string | undefined {
  if (typeof issue.project === 'string') return issue.project;
  const project = asRecord(issue.project);
  if (typeof project?.name === 'string') return project.name;
  if (typeof issue.projectName === 'string') return issue.projectName;
  if (typeof project?.id === 'string') return project.id;
  return undefined;
}

/**
 * Decode a JSON-valued MCP content response.
 *
 * Args:
 *   value: Raw or Mastra-normalised tool result.
 *
 * Returns:
 *   Structured provider payload when one is present.
 */
function decodeMcpPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (record?.structuredContent !== undefined) return record.structuredContent;
  const content = record?.content;
  if (!Array.isArray(content)) return value;
  for (const item of content) {
    const block = asRecord(item);
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      continue;
    }
  }
  return value;
}

/**
 * Locate issue arrays in the supported MCP result envelopes.
 *
 * Args:
 *   value: Decoded provider result.
 *
 * Returns:
 *   Issue objects and an optional next-page cursor.
 */
export function mcpIssuePage(value: unknown): McpPage {
  const decoded = decodeMcpPayload(value);
  if (Array.isArray(decoded)) {
    return { issues: decoded.map(asRecord).filter((row): row is Record<string, unknown> => !!row) };
  }
  const record = asRecord(decoded) ?? {};
  const data = asRecord(record.data);
  const container = data ?? record;
  const candidates = container.issues ?? container.items ?? container.nodes;
  const issues = Array.isArray(candidates)
    ? candidates.map(asRecord).filter((row): row is Record<string, unknown> => !!row)
    : [];
  const pageInfo = asRecord(container.pageInfo) ?? asRecord(record.pageInfo);
  const cursor =
    container.nextCursor ??
    container.next_cursor ??
    (pageInfo?.hasNextPage === false ? undefined : pageInfo?.endCursor);
  return { issues, nextCursor: typeof cursor === 'string' && cursor ? cursor : undefined };
}

/**
 * Read who asked for an issue, in the shapes providers use.
 *
 * Linear's MCP server returns `createdBy` and `assignee` as display names;
 * GraphQL-shaped payloads nest a `creator` or `assignee` object.
 *
 * Args:
 *   issue: Provider issue object.
 *
 * Returns:
 *   The creator's or assignee's name or email, or undefined.
 */
function requesterOf(issue: Record<string, unknown>): string | undefined {
  for (const key of ['creator', 'createdBy', 'assignee']) {
    const value = issue[key];
    if (typeof value === 'string' && value.trim()) return value;
    const record = asRecord(value);
    if (typeof record?.name === 'string') return record.name;
    if (typeof record?.email === 'string') return record.email;
  }
  return undefined;
}

/**
 * Create one normalised work candidate from a Linear issue.
 *
 * Args:
 *   issue: Provider issue object.
 *   surface: Connected Linear surface.
 *   observedAt: Poll observation time.
 *
 * Returns:
 *   A bounded candidate, or undefined when identity, title, or URL is absent.
 */
export function linearCandidate(
  issue: Record<string, unknown>,
  surface: Doc<'surfaces'>,
  observedAt: number,
): WorkCandidate | undefined {
  const id = typeof issue.id === 'string' ? issue.id : undefined;
  const title = typeof issue.title === 'string' ? issue.title.trim() : '';
  const url = typeof issue.url === 'string' ? issue.url : undefined;
  if (!id || !title || !url) return undefined;
  const description =
    typeof issue.description === 'string'
      ? issue.description
      : typeof issue.body === 'string'
        ? issue.body
        : title;
  const priorityObject = asRecord(issue.priority);
  const priority =
    typeof issue.priority === 'string'
      ? issue.priority
      : typeof priorityObject?.label === 'string'
        ? priorityObject.label
        : typeof priorityObject?.name === 'string'
          ? priorityObject.name
          : undefined;
  const requesterLabel = requesterOf(issue);
  return {
    sourceCategory: 'ticket-queue',
    sourceSystem: surface.slug,
    externalId: id,
    title: title.slice(0, 240),
    contentSummary: description.slice(0, 4_000),
    contentRefs: [url],
    observedAt: new Date(observedAt),
    priority,
    requesterLabel,
  };
}

/** The one MCP server this deployment's kanban intake reader speaks to. */
const LINEAR_MCP_ENDPOINT = 'https://mcp.linear.app/mcp';

/**
 * Create the production Linear MCP client for one exact documented endpoint.
 *
 * Args:
 *   endpoint: Validated Linear endpoint.
 *   credential: Decrypted bearer retained inside the Node action.
 *
 * Returns:
 *   The bounded client contract used by intake.
 */
function createMcpClient(endpoint: URL, credential: string): McpIntakeClient {
  return createSecretMcpClient({
    id: `day0-intake-${randomUUID()}`,
    servers: {
      surface: {
        url: endpoint,
        allowedHosts: [endpoint.host],
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      },
    },
    timeout: PROVIDER_TIMEOUT_MS,
  }) as unknown as McpIntakeClient;
}

/**
 * Validate the only MCP origin this intake reader supports locally.
 *
 * Args:
 *   endpoint: Evidence-derived surface endpoint.
 *
 * Returns:
 *   The exact Linear Streamable HTTP endpoint.
 *
 * Raises:
 *   Error: If the endpoint could leak the bearer to another host.
 */
function linearEndpoint(endpoint: string | undefined): URL {
  if (!endpoint) throw new Error('Linear surface has no documented endpoint.');
  const parsed = new URL(endpoint);
  if (parsed.href !== LINEAR_MCP_ENDPOINT) {
    throw new Error('Linear surface endpoint is not the approved host.');
  }
  return parsed;
}

/**
 * Whether this deployment has a kanban intake reader for a connected surface.
 *
 * The probe admits any documented MCP server now, so a connected kanban surface
 * is no longer necessarily Linear's. Intake still reads only Linear's contract,
 * and saying so is the honest answer: telling an operator that their Jira row
 * "is not the approved Linear host" is a claim about their configuration that
 * Day0's own missing reader does not support.
 *
 * Args:
 *   surface: A connected kanban surface.
 *
 * Returns:
 *   Whether the waterfall can read work from it.
 */
export function hasKanbanIntakeReader(surface: Doc<'surfaces'>): boolean {
  return surface.path === 'mcp' && surface.endpoint === LINEAR_MCP_ENDPOINT;
}

/**
 * Poll all bounded Linear pages and map their issues to candidates.
 *
 * Args:
 *   surface: Connected kanban surface.
 *   pages: Runbook pages visible to its agent.
 *   credential: Decrypted bearer.
 *   observedAt: Poll start used for candidate timestamps.
 *   makeClient: Injectable MCP client factory.
 *
 * Returns:
 *   Normalised candidates newer than the previous checkpoint.
 */
async function pollLinear(
  surface: Doc<'surfaces'>,
  pages: readonly Doc<'docPages'>[],
  credential: string,
  observedAt: number,
  makeClient: (endpoint: URL, credential: string) => McpIntakeClient,
): Promise<WorkCandidate[]> {
  if (!surface.toolAllowlist?.includes('list_issues')) {
    throw new Error('Connected Linear surface does not allow list_issues.');
  }
  const scope = linearScopeFromPages(pages);
  const client = makeClient(linearEndpoint(surface.endpoint), credential);
  try {
    const { definitions, errors } = await client.listToolDefinitionsWithErrors({
      perServerTimeoutMs: PROVIDER_TIMEOUT_MS,
    });
    if (errors.surface) throw new Error(errors.surface);
    const definition = definitions.surface?.list_issues;
    if (!definition) throw new Error('Linear MCP server exposes no list_issues tool.');
    const tool = await client.toolFromDefinition({ serverName: 'surface', definition });
    if (!tool.execute) throw new Error('Linear list_issues tool is not executable.');

    const candidates: WorkCandidate[] = [];
    const cursors = new Set<string>();
    const wantedProject = scope.project.toLowerCase();
    let seen = 0;
    let withProject = 0;
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_MCP_PAGES; pageIndex += 1) {
      const request = linearListArguments(
        definition.inputSchema,
        scope,
        surface.lastPolledAt,
        cursor,
      );
      const value = await tool.execute(request.args, {
        abortSignal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      const page = mcpIssuePage(value);
      for (const issue of page.issues) {
        seen += 1;
        const project = issueProject(issue);
        if (project !== undefined) withProject += 1;
        if (project !== undefined && project.toLowerCase() !== wantedProject) continue;
        const updatedAt = typeof issue.updatedAt === 'string' ? Date.parse(issue.updatedAt) : NaN;
        if (
          surface.lastPolledAt !== undefined &&
          Number.isFinite(updatedAt) &&
          updatedAt < surface.lastPolledAt
        ) {
          continue;
        }
        const candidate = linearCandidate(issue, surface, observedAt);
        if (candidate) candidates.push(candidate);
      }
      if (!request.projectEnforced && seen > 0 && withProject === 0) {
        throw new Error(
          `Linear list_issues has no project argument and its issues carry no project field, so intake cannot be bounded to project ${scope.project}.`,
        );
      }
      if (!page.nextCursor) break;
      if (cursors.has(page.nextCursor)) {
        throw new Error('Linear list_issues repeated a cursor before pagination completed.');
      }
      if (pageIndex === MAX_MCP_PAGES - 1) {
        throw new Error('Linear list_issues pagination did not complete within the page limit.');
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return candidates;
  } finally {
    await client.disconnect();
  }
}

/**
 * Call one allowlisted Slack read method and enforce Slack's in-band errors.
 *
 * Args:
 *   fetcher: HTTP implementation.
 *   credential: Decrypted Slack bot token.
 *   method: Allowed Slack Web API read method.
 *   query: Query parameters.
 *
 * Returns:
 *   Successful response object.
 */
async function slackGet(
  fetcher: IntakeFetcher,
  credential: string,
  method: 'conversations.list' | 'conversations.history' | 'conversations.replies',
  query: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetcher(url, {
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const payload = asRecord(await response.json()) ?? {};
  if (!response.ok || payload.ok !== true) {
    const error =
      typeof payload.error === 'string' ? payload.error : `Slack returned HTTP ${response.status}.`;
    throw new Error(error);
  }
  return payload;
}

/**
 * Read a Slack pagination cursor from a Web API response.
 *
 * Args:
 *   payload: Successful Slack response.
 *
 * Returns:
 *   A non-empty cursor, or undefined.
 */
function slackCursor(payload: Record<string, unknown>): string | undefined {
  const metadata = asRecord(payload.response_metadata);
  const cursor = metadata?.next_cursor;
  return typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined;
}

/**
 * Resolve documented Slack names to channel ids with bounded pagination.
 *
 * Args:
 *   fetcher: HTTP implementation.
 *   credential: Decrypted bot token.
 *   names: Documented channel names without hashes.
 *
 * Returns:
 *   Exactly the visible documented channels.
 *
 * Raises:
 *   Error: If one or more documented channels are not visible to the app.
 */
async function resolveSlackChannels(
  fetcher: IntakeFetcher,
  credential: string,
  names: readonly string[],
): Promise<SlackChannel[]> {
  const wanted = new Set(names.map((name: string): string => name.toLowerCase()));
  const found = new Map<string, SlackChannel>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_SLACK_CHANNEL_PAGES; pageIndex += 1) {
    const payload = await slackGet(fetcher, credential, 'conversations.list', {
      exclude_archived: 'true',
      limit: '200',
      types: 'public_channel',
      ...(cursor ? { cursor } : {}),
    });
    const channels = Array.isArray(payload.channels) ? payload.channels : [];
    for (const item of channels) {
      const channel = asRecord(item);
      if (typeof channel?.id !== 'string' || typeof channel.name !== 'string') continue;
      const name = channel.name.toLowerCase();
      if (wanted.has(name)) found.set(name, { id: channel.id, name });
    }
    if (found.size === wanted.size) break;
    cursor = slackCursor(payload);
    if (!cursor) break;
  }
  const missing = [...wanted].filter((name: string): boolean => !found.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Slack channels are not visible: ${missing.map((name: string): string => `#${name}`).join(', ')}.`,
    );
  }
  return names.map((name: string): SlackChannel => found.get(name.toLowerCase())!);
}

/**
 * Read bounded channel history newer than the last completed poll.
 *
 * Args:
 *   fetcher: HTTP implementation.
 *   credential: Decrypted bot token.
 *   channelId: Provider channel id.
 *   lastPolledAt: Previous completed checkpoint.
 *
 * Returns:
 *   Slack message identity and text fields.
 */
async function slackHistory(
  fetcher: IntakeFetcher,
  credential: string,
  channelId: string,
  lastPolledAt?: number,
  thread?: { ts: string },
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const method = thread ? 'conversations.replies' : 'conversations.history';
  for (let pageIndex = 0; pageIndex < MAX_SLACK_HISTORY_PAGES; pageIndex += 1) {
    const payload = await slackGet(fetcher, credential, method, {
      channel: channelId,
      ...(thread ? { ts: thread.ts } : {}),
      inclusive: 'true',
      limit: '200',
      ...(lastPolledAt !== undefined ? { oldest: String(lastPolledAt / 1_000) } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const rows = Array.isArray(payload.messages) ? payload.messages : [];
    for (const item of rows) {
      const row = asRecord(item);
      if (typeof row?.ts !== 'string' || typeof row.text !== 'string') continue;
      messages.push({
        ts: row.ts,
        text: row.text,
        user: typeof row.user === 'string' ? row.user : undefined,
        threadTs: typeof row.thread_ts === 'string' ? row.thread_ts : undefined,
      });
    }
    const nextCursor = slackCursor(payload);
    if (!nextCursor) break;
    if (cursors.has(nextCursor)) {
      throw new Error(`Slack ${method} repeated a cursor before pagination completed.`);
    }
    if (pageIndex === MAX_SLACK_HISTORY_PAGES - 1) {
      throw new Error(`Slack ${method} pagination did not complete within the page limit.`);
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return messages;
}

function mcpMessagePage(value: unknown): { messages: SlackMessage[]; nextCursor?: string } {
  const decoded = decodeMcpPayload(value);
  const record = asRecord(decoded) ?? {};
  const data = asRecord(record.data);
  const container = data ?? record;
  const rows = Array.isArray(container.messages)
    ? container.messages
    : Array.isArray(container.items)
      ? container.items
      : [];
  const messages = rows.flatMap((item): SlackMessage[] => {
    const row = asRecord(item);
    if (typeof row?.ts !== 'string' || typeof row.text !== 'string') return [];
    return [
      {
        ts: row.ts,
        text: row.text,
        user: typeof row.user === 'string' ? row.user : undefined,
        threadTs: typeof row.thread_ts === 'string' ? row.thread_ts : undefined,
      },
    ];
  });
  const metadata = asRecord(container.response_metadata) ?? asRecord(record.response_metadata);
  const cursor = container.nextCursor ?? container.next_cursor ?? metadata?.next_cursor;
  return {
    messages,
    nextCursor: typeof cursor === 'string' && cursor.trim() ? cursor.trim() : undefined,
  };
}

/** Read the manager DM through a generic chat MCP connection's discovered history tool. */
async function pollMcpManagerReplies(
  surface: Doc<'surfaces'>,
  credential: string,
  makeClient: (endpoint: URL, credential: string) => McpIntakeClient,
): Promise<ChatPollResult['decisionReplies']> {
  if (!surface.managerDmChannelId || !surface.managerUserId) return [];
  const historyTool = surface.toolAllowlist?.find((tool) =>
    /(?:^|[._-])(?:conversations?[._-])?history$/i.test(tool),
  );
  if (!historyTool) throw new Error('Connected chat MCP surface exposes no history tool.');
  if (!surface.endpoint) throw new Error('Connected chat MCP surface has no endpoint.');
  const endpoint = new URL(surface.endpoint);
  if (endpoint.protocol !== 'https:') throw new Error('Chat MCP endpoint must use HTTPS.');
  const client = makeClient(endpoint, credential);
  try {
    const { definitions, errors } = await client.listToolDefinitionsWithErrors({
      perServerTimeoutMs: PROVIDER_TIMEOUT_MS,
    });
    if (errors.surface) throw new Error(errors.surface);
    const definition = definitions.surface?.[historyTool];
    if (!definition) throw new Error(`Chat MCP server exposes no ${historyTool} tool.`);
    const properties = schemaProperties(definition.inputSchema);
    const channelName = discoveredArgument(properties, [
      'channel',
      'channelId',
      'conversation',
      'conversationId',
    ]);
    if (!channelName) throw new Error('Chat history tool has no channel argument.');
    const tool = await client.toolFromDefinition({ serverName: 'surface', definition });
    if (!tool.execute) throw new Error('Chat history tool is not executable.');
    const replies: ChatPollResult['decisionReplies'] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_SLACK_HISTORY_PAGES; pageIndex += 1) {
      const args: Record<string, unknown> = { [channelName]: surface.managerDmChannelId };
      const limitName = discoveredArgument(properties, ['limit', 'first', 'pageSize']);
      if (limitName) args[limitName] = PAGE_SIZE;
      const oldestName = discoveredArgument(properties, ['oldest', 'since', 'updatedAfter']);
      if (oldestName && surface.lastPolledAt !== undefined) {
        // One millisecond of overlap, as the Linear poll does: a generic history tool
        // has no inclusive flag, and a reply stamped exactly on the checkpoint must not
        // be excluded forever. Re-observing a reply is safe; the decision keys on its ts.
        args[oldestName] = String((surface.lastPolledAt - 1) / 1_000);
      }
      if (cursor) {
        const cursorName = discoveredArgument(properties, ['cursor', 'after', 'pageToken']);
        if (!cursorName) throw new Error('Chat history returned an unsupported cursor.');
        args[cursorName] = cursor;
      }
      const page = mcpMessagePage(
        await tool.execute(args, { abortSignal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }),
      );
      for (const message of page.messages) {
        if (!message.user || message.user === surface.providerIdentityId) continue;
        const reply = parseDecisionReply(message.text);
        if (reply) replies.push({ userId: message.user, messageTs: message.ts, reply });
      }
      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error('Chat history repeated a cursor before pagination completed.');
      }
      if (pageIndex === MAX_SLACK_HISTORY_PAGES - 1) {
        throw new Error('Chat history pagination did not complete within the page limit.');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return replies;
  } finally {
    await client.disconnect();
  }
}

/**
 * Create one normalised work candidate from a Slack mention.
 *
 * Args:
 *   message: Channel history message mentioning the agent.
 *   channel: Documented channel containing it.
 *   surface: Connected Slack surface.
 *   observedAt: Poll observation time.
 *
 * Returns:
 *   Normalised event-stream candidate.
 */
export function slackCandidate(
  message: SlackMessage,
  channel: SlackChannel,
  surface: Doc<'surfaces'>,
  observedAt: number,
): WorkCandidate {
  const teamId = surface.providerWorkspaceId!;
  const threadKey = `${channel.id}-${message.ts.replace('.', '')}`;
  return {
    sourceCategory: 'event-stream',
    sourceSystem: surface.slug,
    externalId: `${channel.id}:${message.ts}`,
    title: `Slack mention in #${channel.name}`,
    contentSummary: message.text.slice(0, 4_000),
    contentRefs: [`https://app.slack.com/client/${teamId}/${channel.id}/thread/${threadKey}`],
    observedAt: new Date(observedAt),
    requesterLabel: message.user,
    // A reply belongs in the ask's thread: under the mention itself, or under
    // the parent when the mention was already a threaded message.
    replyTarget: {
      channel: channel.id,
      channelName: channel.name,
      threadTs: message.threadTs ?? message.ts,
    },
  };
}

/**
 * Poll documented Slack channels for exact mentions of the connected bot.
 *
 * Args:
 *   surface: Connected Slack surface with probe identity metadata.
 *   pages: Policy pages visible to the agent.
 *   credential: Decrypted bot token.
 *   observedAt: Poll start used for candidate timestamps.
 *   fetcher: Injectable HTTP implementation.
 *
 * Returns:
 *   Normalised mention candidates.
 */
async function pollSlack(
  surface: Doc<'surfaces'>,
  pages: readonly Doc<'docPages'>[],
  credential: string,
  observedAt: number,
  fetcher: IntakeFetcher,
  listOpenRequests: () => Promise<Array<{ ts: string }>>,
  include: { decisions: boolean; work: boolean },
): Promise<ChatPollResult> {
  const requiredMethods = include.work
    ? ['conversations.list', 'conversations.history']
    : ['conversations.history'];
  for (const method of requiredMethods) {
    if (!surface.toolAllowlist?.includes(method)) {
      throw new Error(`Connected Slack surface does not allow ${method}.`);
    }
  }
  const candidates: WorkCandidate[] = [];
  if (include.work) {
    if (!surface.providerIdentityId) throw new Error('Slack probe stored no bot identity.');
    if (!surface.providerWorkspaceId) throw new Error('Slack probe stored no workspace identity.');
    const names = slackChannelsFromPages(pages);
    if (names.length === 0) throw new Error('Slack policy names no intake channels.');
    const channels = await resolveSlackChannels(fetcher, credential, names);
    const mention = `<@${surface.providerIdentityId}>`;
    for (const channel of channels) {
      const messages = await slackHistory(fetcher, credential, channel.id, surface.lastPolledAt);
      for (const message of messages) {
        if (!message.text.includes(mention) || message.user === surface.providerIdentityId) continue;
        candidates.push(slackCandidate(message, channel, surface, observedAt));
      }
    }
  }
  const decisionReplies = new Map<string, ChatPollResult['decisionReplies'][number]>();
  const collect = (messages: SlackMessage[], skipTs?: string): void => {
    for (const message of messages) {
      if (message.ts === skipTs) continue;
      if (!message.user || message.user === surface.providerIdentityId) continue;
      const reply = parseDecisionReply(message.text);
      if (reply)
        decisionReplies.set(message.ts, { userId: message.user, messageTs: message.ts, reply });
    }
  };
  if (include.decisions && surface.managerDmChannelId && surface.managerUserId) {
    const dm = surface.managerDmChannelId;
    collect(await slackHistory(fetcher, credential, dm, surface.lastPolledAt));
    // `conversations.history` lists only top-level messages. A manager who answers in
    // the thread under the request is answering all the same, so each open request's
    // thread is read too, when the probe allowlisted the replies method.
    if (surface.toolAllowlist?.includes('conversations.replies')) {
      for (const request of await listOpenRequests()) {
        collect(
          await slackHistory(fetcher, credential, dm, surface.lastPolledAt, { ts: request.ts }),
          request.ts,
        );
      }
    }
  }
  return { candidates, decisionReplies: [...decisionReplies.values()] };
}

/**
 * Order two provider message timestamps without losing microsecond precision.
 *
 * Slack timestamps are `<seconds>.<fraction>` strings; a float comparison at
 * 1.7e9 seconds rounds the last microsecond, so compare the parts as digits.
 */
export function compareProviderTs(left: string, right: string): number {
  const [leftWhole = '', leftFraction = ''] = left.split('.', 2);
  const [rightWhole = '', rightFraction = ''] = right.split('.', 2);
  const width = Math.max(leftWhole.length, rightWhole.length);
  const wholes = leftWhole.padStart(width, '0').localeCompare(rightWhole.padStart(width, '0'));
  if (wholes !== 0) return wholes;
  const scale = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(scale, '0').localeCompare(rightFraction.padEnd(scale, '0'));
}

/** Poll a connected chat surface by its approved path, independent of provider name. */
async function pollChat(
  surface: Doc<'surfaces'>,
  pages: readonly Doc<'docPages'>[],
  credential: string,
  observedAt: number,
  fetcher: IntakeFetcher,
  makeClient: (endpoint: URL, credential: string) => McpIntakeClient,
  listOpenRequests: () => Promise<Array<{ ts: string }>>,
  include: { decisions: boolean; work: boolean },
): Promise<ChatPollResult> {
  const polled = await (async (): Promise<ChatPollResult> => {
    if (surface.path === 'documented-api') {
      return await pollSlack(
        surface,
        pages,
        credential,
        observedAt,
        fetcher,
        listOpenRequests,
        include,
      );
    }
    if (surface.path === 'mcp') {
      return {
        candidates: [],
        decisionReplies: include.decisions
          ? await pollMcpManagerReplies(surface, credential, makeClient)
          : [],
      };
    }
    throw new Error(
      `Connected chat surface path ${surface.path ?? 'unknown'} has no intake reader.`,
    );
  })();
  // Providers list newest first. Replies must resolve in the order the manager sent
  // them, so the first answer decides and a later change of mind is the duplicate.
  return {
    ...polled,
    decisionReplies: [...polled.decisionReplies].sort((left, right) =>
      compareProviderTs(left.messageTs, right.messageTs),
    ),
  };
}

/**
 * Persist one mapped candidate through the existing deduplicating mutation.
 *
 * Args:
 *   runtime: Convex or test runtime.
 *   agentId: Candidate owner.
 *   candidate: Normalised provider item.
 */
async function seedCandidate(
  runtime: IntakeRuntime,
  agentId: Id<'agents'>,
  candidate: WorkCandidate,
): Promise<void> {
  await runtime.seed({
    agentId,
    sourceCategory: candidate.sourceCategory,
    sourceSystem: candidate.sourceSystem,
    externalId: candidate.externalId,
    title: candidate.title,
    contentSummary: candidate.contentSummary,
    contentRefs: candidate.contentRefs,
    priority: candidate.priority,
    requesterLabel: candidate.requesterLabel,
    replyTarget: candidate.replyTarget,
  });
}

/**
 * Describe why a non-connected surface cannot be polled yet.
 *
 * Args:
 *   surface: Surface reached in waterfall order.
 *
 * Returns:
 *   Existing evidence-backed reason or a stable lifecycle reason.
 */
function disconnectedReason(surface: Doc<'surfaces'>): string {
  if (surface.reason) return surface.reason;
  if (surface.verdict === 'ungranted' && surface.credentialLocation) {
    return `credential not in the docs; ${surface.credentialLocation}`;
  }
  return `surface is ${surface.verdict}; awaiting connection`;
}

/**
 * Run one deployment-wide waterfall sweep.
 *
 * Args:
 *   runtime: Persistence and credential boundary.
 *   dependencies: Provider clients, clock, and deployment mode.
 *
 * Returns:
 *   Safe aggregate counters containing no provider payloads.
 */
export async function runIntakeSweep(
  runtime: IntakeRuntime,
  dependencies: IntakeDependencies = {},
): Promise<IntakeSweepResult> {
  const mode = dependencies.mode ?? SURFACE_MODE;
  if (mode !== 'real') return { candidates: 0, mode, polled: 0, skipped: 0, surfaces: 0 };
  const fetcher: IntakeFetcher = dependencies.fetcher ?? fetch;
  const makeMcpClient = dependencies.makeMcpClient ?? createMcpClient;
  const now = dependencies.now ?? Date.now;
  const browserAbsent = browserComponentRefusal(
    dependencies.browserMcpUrl ?? process.env.DAY0_BROWSER_MCP_URL,
  );
  const surfaces = await runtime.listSurfaces();
  const byAgent = new Map<Id<'agents'>, Doc<'surfaces'>[]>();
  for (const surface of surfaces) {
    const rows = byAgent.get(surface.agentId) ?? [];
    rows.push(surface);
    byAgent.set(surface.agentId, rows);
  }

  let candidates = 0;
  let polled = 0;
  let skipped = 0;
  for (const [agentId, agentSurfaces] of byAgent) {
    const agent = await runtime.getAgent(agentId);
    if (!agent) continue;
    const pages = await runtime.listPages(agentId);
    const documentedNames = extractDocumentedSystemOrder(
      pages.map((page: Doc<'docPages'>): { title: string; content: string } => ({
        title: page.title,
        content: page.markdown,
      })),
    );
    const ordered = orderSurfaceWaterfall(agentSurfaces, documentedNames);
    for (const [index, surface] of ordered.entries()) {
      const waterfallPosition = index + 1;
      if (surface.verdict !== 'connected') {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: disconnectedReason(surface),
        });
        skipped += 1;
        continue;
      }
      if (!surface.credentialId) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: 'connected surface has no stored credential; re-probe required',
        });
        skipped += 1;
        continue;
      }
      // A surface driven through the browser needs the browser component, and a
      // deployment that does not run it skips the row with that as the reason
      // rather than with a reader complaint that hides which part is missing.
      if (surface.path === 'browser-driven' && browserAbsent) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: browserAbsent,
        });
        skipped += 1;
        continue;
      }
      if (surface.class !== 'kanban' && surface.class !== 'chat') {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: `no intake reader for connected ${surface.class} surface`,
        });
        skipped += 1;
        continue;
      }
      // Checked before the credential is decrypted, and named as Day0's gap.
      if (surface.class === 'kanban' && !hasKanbanIntakeReader(surface)) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: `no intake reader for ${surface.displayName}; this Day0 deployment reads kanban work through Linear's MCP contract`,
        });
        skipped += 1;
        continue;
      }

      const pollStartedAt = now();
      let credential = '';
      try {
        credential = await runtime.decrypt(surface.credentialId);
        const chat =
          surface.class === 'chat'
            ? await pollChat(
                surface,
                pages,
                credential,
                pollStartedAt,
                fetcher,
                makeMcpClient,
                () => runtime.listOpenDecisionRequests(surface._id),
                { decisions: false, work: true },
              )
            : undefined;
        const mapped = chat
          ? chat.candidates
          : await pollLinear(surface, pages, credential, pollStartedAt, makeMcpClient);
        for (const candidate of mapped) await seedCandidate(runtime, agentId, candidate);
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          polledAt: pollStartedAt,
        });
        candidates += mapped.length;
        polled += 1;
      } catch (error) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: `intake failed: ${safeIntakeError(error, credential)}`,
        });
        skipped += 1;
      } finally {
        credential = '';
      }
    }
  }
  return { candidates, mode, polled, skipped, surfaces: surfaces.length };
}

/** Poll only manager decision replies, without touching discovery checkpoints. */
export async function runDecisionSweep(
  runtime: IntakeRuntime,
  dependencies: IntakeDependencies = {},
): Promise<DecisionSweepResult> {
  const mode = dependencies.mode ?? SURFACE_MODE;
  if (mode !== 'real') return { mode, polled: 0, skipped: 0, surfaces: 0 };
  const fetcher: IntakeFetcher = dependencies.fetcher ?? fetch;
  const makeMcpClient = dependencies.makeMcpClient ?? createMcpClient;
  const now = dependencies.now ?? Date.now;
  const surfaces = (await runtime.listSurfaces()).filter(
    (surface): boolean => surface.class === 'chat',
  );
  let polled = 0;
  let skipped = 0;
  for (const surface of surfaces) {
    if (
      surface.verdict !== 'connected' ||
      !surface.credentialId ||
      !surface.managerDmChannelId ||
      !surface.managerUserId
    ) {
      skipped += 1;
      continue;
    }
    const pollStartedAt = now();
    let credential = '';
    try {
      credential = await runtime.decrypt(surface.credentialId);
      const checkpointed = {
        ...surface,
        lastPolledAt: surface.lastDecisionPolledAt ?? surface.lastPolledAt,
      };
      const chat = await pollChat(
        checkpointed,
        [],
        credential,
        pollStartedAt,
        fetcher,
        makeMcpClient,
        () => runtime.listOpenDecisionRequests(surface._id),
        { decisions: true, work: false },
      );
      for (const reply of chat.decisionReplies) {
        await runtime.resolveDecision({ surfaceId: surface._id, ...reply });
      }
      await runtime.recordDecisionPoll({ surfaceId: surface._id, polledAt: pollStartedAt });
      polled += 1;
    } catch (error) {
      console.warn(
        `Manager decision poll failed for ${surface.slug}: ${safeIntakeError(error, credential)}`,
      );
      skipped += 1;
    } finally {
      credential = '';
    }
  }
  return { mode, polled, skipped, surfaces: surfaces.length };
}

/** Create the Convex runtime boundary used by the scheduled action. */
function convexRuntime(ctx: ActionCtx): IntakeRuntime {
  return {
    listSurfaces: async (): Promise<Doc<'surfaces'>[]> =>
      await ctx.runQuery(internal.orientationData.surfacesForIntake, {}),
    getAgent: async (agentId: Id<'agents'>): Promise<Doc<'agents'> | null> =>
      await ctx.runQuery(internal.agents.getInternal, { agentId }),
    listPages: async (agentId: Id<'agents'>): Promise<Doc<'docPages'>[]> =>
      await ctx.runQuery(internal.orientationData.pagesForAgent, { agentId }),
    decrypt: async (credentialId: CredentialId): Promise<string> =>
      await ctx.runAction(credentialInternal.credentials.decrypt, { credentialId }),
    recordIntake: async (record: IntakeRecord): Promise<void> => {
      await ctx.runMutation(internal.surfaces.recordIntake, record);
    },
    recordDecisionPoll: async (record): Promise<void> => {
      await ctx.runMutation(internal.work.recordDecisionPoll, record);
    },
    seed: async (candidate: IntakeSeed): Promise<void> => {
      await ctx.runMutation(internal.work.seedItem, candidate);
    },
    resolveDecision: async (reply: IntakeDecisionReply): Promise<void> => {
      await ctx.runMutation(internal.work.resolveChannelDecision, reply);
    },
    listOpenDecisionRequests: async (surfaceId: Id<'surfaces'>): Promise<Array<{ ts: string }>> =>
      await ctx.runQuery(internal.work.openDecisionRequests, { surfaceId }),
  };
}

/** Poll all connected real surfaces in evidence-derived waterfall order. */
export const pollAll = internalAction({
  args: {},
  handler: async (ctx): Promise<IntakeSweepResult> =>
    await runIntakeSweep(convexRuntime(ctx), { mode: SURFACE_MODE }),
});

/** Poll manager decisions on the latency-sensitive schedule. */
export const pollDecisions = internalAction({
  args: {},
  handler: async (ctx): Promise<DecisionSweepResult> =>
    await runDecisionSweep(convexRuntime(ctx), { mode: SURFACE_MODE }),
});

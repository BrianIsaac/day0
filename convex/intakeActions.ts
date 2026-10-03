'use node';

import { LINEAR_MCP_ENDPOINT } from '../src/surfaces/fixed-endpoints';
import { randomUUID } from 'node:crypto';
import type { ToolExecutionContext } from '@mastra/core/tools';
import { v, type GenericId } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { SweepRead } from './intakeSeed';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import { readSurfaceBearer } from './mcpOauthActions';
import { forEachStoredPage, namesSystem } from './orientationActions';
import { SURFACE_MODE, type SurfaceMode } from '../src/lib/surface-mode';
import { log } from '../src/lib/logger';
import { safeFailureMessage } from '../src/surfaces/redact';
import { intakeFailureWords } from '../src/surfaces/intake-failure-words';
import { createSecretMcpClient } from '../src/surfaces/mcp-client';
import { checkMcpAddress, pinnedFetch, resolveHostname } from '../src/surfaces/mcp-address';
import {
  fetchWithBackoff,
  PROVIDER_BACKOFF,
  TransientProviderError,
  transportFailureKind,
  type BackoffPolicy,
} from '../src/lib/transport-error';
import type { McpConnection } from '../src/surfaces/mcp';
import { browserComponentRefusal } from '../src/surfaces/browser';
import { documentedChannelNames } from '../src/surfaces/slack-policy';
import {
  ChatReadRefused,
  chatReaderFor,
  MAX_HISTORY_PAGES,
  type ChatChannel,
  type ChatMessage,
  type ChatReader,
} from '../src/surfaces/chat-reader';
import { slackApiBaseUrl } from '../src/surfaces/slack-endpoint';
import { toSurfaceRecord } from '../src/surfaces/records';
import {
  approvedChannelNames,
  approvedLinearScope,
  emptyScopeReason,
  isEmptyScope,
} from '../src/surfaces/intake-scope';
import {
  extractDocumentedSystemOrder,
  orderSurfaceWaterfall,
  waterfallEntry,
  type WaterfallPage,
} from '../src/surfaces/waterfall';
import type { WorkCandidate } from '../src/work/types';
import {
  appIdentityOf,
  DO_NOT_AUTOMATE_LABEL,
  isAppIdentity,
  isClosedStateType,
  personKey,
  samePerson,
  ticketHolder,
  ticketLabels,
  ticketSnapshot,
  ticketStateType,
  type PersonIdentity,
  type TicketSnapshot,
} from '../src/work/ticket-ownership';
import {
  heldReplyCodes,
  NOTHING_OPEN,
  parseDecisionReply,
  readsManagerDm,
  type DecisionReply,
  type OpenDecisions,
} from '../src/work/manager-channel';
import { accessEnded, accessEndedReason } from '../src/work/surface-access';
import { agentZone } from '../src/lib/zone';

const PROVIDER_TIMEOUT_MS = 10_000;
/**
 * No backoff wait in a sweep starts after this long, so a rate-limited
 * workspace leaves the rest to the next sweep instead of reaching the
 * action's ten-minute limit with surfaces unrecorded.
 */
const SWEEP_WAIT_BUDGET_MS = 6 * 60_000;
const MAX_MCP_PAGES = 5;
const PAGE_SIZE = 100;

type CredentialId = GenericId<'credentials'>;

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

/** A listed item as intake reads it: the candidate and, when the provider says, when it was asked. */
export interface IntakeCandidate extends WorkCandidate {
  /** When the item was raised, by the provider's clock (a Linear issue's `createdAt`). */
  askedAt?: number;
}

interface IntakeSeed extends Omit<WorkCandidate, 'observedAt'> {
  agentId: Id<'agents'>;
  /** The ticket as this listing showed it, kept for the re-read before apply. */
  tracker?: TicketSnapshot;
  /** When the item was raised, by the provider's clock; a chat ask's is its message `ts`. */
  askedAt?: number;
  /** When intake read it: the poll's start. */
  observedAt: number;
}

interface IntakeDecisionReply {
  surfaceId: Id<'surfaces'>;
  userId: string;
  messageTs: string;
  reply: DecisionReply;
}

/** What intake reads of an employee's documentation. */
export interface IntakeDocumentation {
  /** The systems the documentation orders, from its systems table. */
  readonly order: string[];
  /** The pages that name one of the systems intake polls, whole. */
  readonly pages: Doc<'docPages'>[];
}

export interface IntakeRuntime {
  /**
   * Every declared surface and its employee's owner, read in one transaction: the owner each
   * employee is polled under and its seeds are fenced by (FR-m4).
   */
  readSweep(): Promise<SweepRead>;
  /** The chat rows alone, for the poll that runs once a minute. */
  listChatSurfaces(): Promise<Doc<'surfaces'>[]>;
  getAgent(agentId: Id<'agents'>): Promise<Doc<'agents'> | null>;
  /**
   * The employee's documentation as intake reads it, a bounded page at a time
   * (D D3): the systems order its systems table gives, and whole only the
   * pages that name one of `systems`, which a card with no approved scope
   * reads its queue from; every other page counts only for the order.
   */
  intakeDocumentation(
    agentId: Id<'agents'>,
    systems: readonly string[],
  ): Promise<IntakeDocumentation>;
  /** The scopes the employee holds now: granted and not revoked. */
  grantedScopes(agentId: Id<'agents'>): Promise<string[]>;
  /** The rows waiting to be evaluated for the employee, and the bound intake keeps (N7). */
  waitingWork(agentId: Id<'agents'>): Promise<{ waiting: number; limit: number }>;
  /** Which of the listed items already have a row for the employee. */
  seededItems(
    agentId: Id<'agents'>,
    sourceSystem: string,
    externalIds: readonly string[],
  ): Promise<string[]>;
  decrypt(credentialId: CredentialId): Promise<string>;
  recordIntake(record: IntakeRecord): Promise<void>;
  recordDecisionPoll(record: {
    surfaceId: Id<'surfaces'>;
    polledAt?: number;
    failure?: string;
  }): Promise<void>;
  /**
   * Seed one listed item, fenced by the owner the sweep read the employee under: nothing lands
   * once a handover moved it to another (U3-m2).
   */
  seed(candidate: IntakeSeed, startedUnder: string | null): Promise<void>;
  /** Bring the row of a ticket intake refused up to the listing, and withdraw it if it waits. */
  withdraw(candidate: IntakeSeed & { leftQueue: string }): Promise<void>;
  resolveDecision(reply: IntakeDecisionReply): Promise<void>;
  /** What the surface's manager DM has open; nothing open leaves it unread (Q13). */
  openDecisions(surfaceId: Id<'surfaces'>): Promise<OpenDecisions>;
  /** Close a delivered request whose thread the provider says is gone, and send it again. */
  closeDecisionThread(record: { surfaceId: Id<'surfaces'>; decisionId: string }): Promise<void>;
  /** Tell the manager, once, that a reply could not be read as a decision. */
  noticeUnreadableReply(record: {
    surfaceId: Id<'surfaces'>;
    userId: string;
    messageTs: string;
  }): Promise<void>;
  /** Keep the bot id intake read for a row connected before the probe stored one. */
  recordBotIdentity(record: {
    surfaceId: Id<'surfaces'>;
    generation: number;
    providerBotId: string;
  }): Promise<void>;
}

export interface IntakeDependencies {
  fetcher?: IntakeFetcher;
  makeMcpClient?: (endpoint: URL, credential: string) => McpIntakeClient;
  mode?: SurfaceMode;
  now?: () => number;
  /** This deployment's browser driver address; absent means no browser component. */
  browserMcpUrl?: string;
  /**
   * Poll this one surface and record nothing for the rest of its agent's
   * waterfall; the poll a fresh connection schedules for itself.
   */
  surfaceId?: Id<'surfaces'>;
  /** How a provider read waits before it is tried again; a test records the waits instead. */
  sleep?: (ms: number) => Promise<void>;
}

export interface IntakeSweepResult {
  candidates: number;
  mode: SurfaceMode;
  polled: number;
  skipped: number;
  surfaces: number;
}

/** What one decision poll did, per chat surface. */
export interface DecisionSweepResult extends Omit<IntakeSweepResult, 'candidates'> {
  /** Surfaces whose DM was left unread because nothing was open (Q13's back-off). */
  idle: number;
}

/** The Linear bounds intake reads: the approved scope, or the page scan's for older rows. */
interface LinearScope {
  project?: string;
  projects?: string[];
  team?: string;
}

interface McpPage {
  issues: Record<string, unknown>[];
  nextCursor?: string;
}

interface ChatPollResult {
  candidates: WorkCandidate[];
  /** The replies read as a decision whose every read succeeded, to resolve now. */
  decisionReplies: Array<Omit<IntakeDecisionReply, 'surfaceId'>>;
  /** The manager's messages after an open request that read as no decision. */
  unreadableReplies: Array<{ userId: string; messageTs: string }>;
  /** Open requests whose thread the provider says does not exist, by code. */
  missingThreads: string[];
  /** Reads that failed after their retries, by what was read; the checkpoint holds while any did. */
  unread: Array<{ what: string; error: unknown }>;
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
 * What an intake card says when the provider did not answer before the poll's time ran out, in
 * place of the platform's abort (the real-Linear walk's m12: "TimeoutError: The operation was
 * aborted due to timeout"). Every poll reads again, so the words say nothing of a retry: a
 * partial read's line already says it reads the rest next time.
 */
export const PROVIDER_DID_NOT_ANSWER = 'the provider did not answer in time';

/** How far down an error's causes a timed-out request is looked for. */
const TIMEOUT_CAUSE_DEPTH = 3;

/**
 * Whether a failure is a timed-out request: the platform's `TimeoutError`, a client's error that
 * carries one in its words (an MCP client hands the abort on as text), or one that wraps it as
 * its cause.
 */
function isTimedOut(error: unknown, depth = 0): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/\bTimeoutError: The operation was aborted due to timeout/.test(message)) return true;
  return (
    depth < TIMEOUT_CAUSE_DEPTH &&
    error instanceof Error &&
    error.cause !== undefined &&
    isTimedOut(error.cause, depth + 1)
  );
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
  if (isTimedOut(error)) return PROVIDER_DID_NOT_ANSWER;
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
export function linearScopeFromPages(pages: readonly Doc<'docPages'>[]): {
  project: string;
  team?: string;
} {
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

/**
 * Whether a discovered argument's schema accepts one string value.
 *
 * Args:
 *   schema: The argument's advertised schema.
 *   value: The value intake would send.
 *
 * Returns:
 *   True when the schema lists the value, or lists no values at all.
 */
function schemaAccepts(schema: unknown, value: string): boolean {
  const options = asRecord(schema)?.enum;
  return !Array.isArray(options) || options.includes(value);
}

/** A Linear list request and which of its bounds the provider itself enforces. */
export interface LinearListRequest {
  args: Record<string, unknown>;
  /** True when the schema had a project argument; otherwise issues are filtered here. */
  projectEnforced: boolean;
  /** True when the schema had a team argument; otherwise issues are filtered here. */
  teamEnforced: boolean;
  /** True when the schema had an updated-at argument; otherwise issues are filtered here. */
  checkpointEnforced: boolean;
  /**
   * What the person-ticket rule reads that the schema's `fields` selector
   * cannot select (`an assignee`, `a label`, `a state type`); empty when it
   * can, or when there is no selector and the provider's default fields apply.
   */
  unselectable: string[];
}

/**
 * Issue fields intake reads, requested by name when the schema lets a caller
 * choose. A named selection returns nothing else, so the item's other name
 * (`uuid` beside an identifier `id`, `identifier` beside a UUID `id`) is asked
 * for here or `linearCandidate` never sees it and no alias is stored.
 */
const LINEAR_ISSUE_FIELDS = [
  'id',
  'uuid',
  'identifier',
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
  'assigneeId',
  'delegate',
  'delegateId',
  'labels',
  'state',
  'project',
  'projectId',
  'team',
] as const;

/**
 * The fields that let the person-ticket rule see each fact it reads (Q11):
 * who the ticket is assigned to, by id, since a printed name identifies
 * nobody; its labels; and its workflow state type, which a status name
 * alone does not carry.
 */
const PERSON_TICKET_FIELDS: ReadonlyArray<{
  readonly fact: string;
  readonly fields: readonly string[];
}> = [
  { fact: 'an assignee', fields: ['assigneeId'] },
  { fact: 'a label', fields: ['labels'] },
  { fact: 'a state type', fields: ['statusType', 'state'] },
];

/**
 * What the rule reads beside {@link PERSON_TICKET_FIELDS} for a card acting as an app (D6): the
 * delegate, since Linear sets an app user a ticket is assigned to as its delegate and leaves the
 * person as the assignee, so a list without it would read every ticket handed to the employee as
 * the manager's.
 */
const APP_TICKET_FIELDS: ReadonlyArray<{
  readonly fact: string;
  readonly fields: readonly string[];
}> = [{ fact: 'a delegate', fields: ['delegateId', 'delegate'] }];

/**
 * The facts an app identity's ticket rule reads that the schema's `fields` selector cannot select;
 * empty when there is no selector and the provider's default fields apply.
 *
 * @param inputSchema - The live schema advertised for list_issues.
 */
function appTicketFactsUnselectable(inputSchema: unknown): string[] {
  const selectable = selectableFields(schemaProperties(inputSchema));
  if (!selectable) return [];
  return APP_TICKET_FIELDS.filter(({ fields }) => !fields.some((name) => selectable.has(name))).map(
    ({ fact }) => fact,
  );
}

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
  if (projectName && scope.project) args[projectName] = scope.project;

  const teamName = discoveredArgument(properties, ['team', 'teamName', 'teamKey', 'teamId']);
  if (teamName && scope.team) args[teamName] = scope.team;

  const limitName = discoveredArgument(properties, ['limit', 'first', 'pageSize']);
  if (limitName) args[limitName] = PAGE_SIZE;

  // Creation order keeps a ticket on its page while the walk pages: under the
  // default update order, a ticket edited mid-walk moves pages and can be
  // skipped or read twice (P9-1).
  const orderName = discoveredArgument(properties, ['orderBy']);
  if (orderName && schemaAccepts(properties[orderName], 'createdAt')) {
    args[orderName] = 'createdAt';
  }

  const selectable = selectableFields(properties);
  if (selectable) {
    const fields = LINEAR_ISSUE_FIELDS.filter((name: string): boolean => selectable.has(name));
    if (fields.length > 0) args.fields = fields;
  }
  const unselectable = selectable
    ? PERSON_TICKET_FIELDS.filter(({ fields }) => !fields.some((name) => selectable.has(name))).map(
        ({ fact }) => fact,
      )
    : [];

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
  return {
    args,
    projectEnforced: projectName !== undefined,
    teamEnforced: teamName !== undefined,
    checkpointEnforced,
    unselectable,
  };
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
 * Read every way an issue names its team, in lower case.
 *
 * Linear's MCP server returns the team's display name and the issue
 * identifier (`FIN-4`), whose prefix is the team key; GraphQL-shaped
 * payloads nest a team object. A documented team is usually the key, so
 * the identifier's prefix is what lets the key be compared at all.
 *
 * Args:
 *   issue: Provider issue object.
 *
 * Returns:
 *   The team's name, key or id as the issue carries them; empty when none.
 */
export function issueTeamLabels(issue: Record<string, unknown>): string[] {
  const labels = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) labels.add(value.trim().toLowerCase());
  };
  add(issue.team);
  const team = asRecord(issue.team);
  add(team?.key);
  add(team?.name);
  add(team?.id);
  add(issue.teamKey);
  add(issue.teamName);
  add(issue.teamId);
  const identifier =
    typeof issue.identifier === 'string'
      ? issue.identifier
      : typeof issue.id === 'string'
        ? issue.id
        : '';
  add(/^([A-Z][A-Z0-9_]*)-\d+$/.exec(identifier)?.[1]);
  return [...labels];
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
 * A GraphQL connection (`{ issues: { nodes, pageInfo } }`) nests its rows one
 * level down. A shape with no list in any of these places is refused rather
 * than read as an empty page: an empty page advances the checkpoint, and every
 * ticket updated in that window would never be seen (P5-14).
 *
 * Args:
 *   value: Decoded provider result.
 *
 * Returns:
 *   Issue objects and an optional next-page cursor.
 *
 * Raises:
 *   Error: If the result carries no issue list intake can read.
 */
export function mcpIssuePage(value: unknown): McpPage {
  const decoded = decodeMcpPayload(value);
  if (Array.isArray(decoded)) {
    return { issues: decoded.map(asRecord).filter((row): row is Record<string, unknown> => !!row) };
  }
  const record = asRecord(decoded) ?? {};
  const data = asRecord(record.data);
  const container = data ?? record;
  const listed = container.issues ?? container.items ?? container.nodes;
  const connection = Array.isArray(listed) ? undefined : asRecord(listed);
  const rows: unknown = Array.isArray(listed) ? listed : connection?.nodes;
  if (!Array.isArray(rows)) {
    const keys = Object.keys(container).slice(0, 8).join(', ') || 'none';
    throw new Error(
      `Linear list_issues returned a shape intake cannot read (top-level keys: ${keys}), so the checkpoint is not advanced.`,
    );
  }
  const issues = rows.map(asRecord).filter((row): row is Record<string, unknown> => !!row);
  const pageInfo =
    asRecord(connection?.pageInfo) ?? asRecord(container.pageInfo) ?? asRecord(record.pageInfo);
  const cursor =
    container.nextCursor ??
    container.next_cursor ??
    (pageInfo?.hasNextPage === false ? undefined : pageInfo?.endCursor);
  return { issues, nextCursor: typeof cursor === 'string' && cursor ? cursor : undefined };
}

/** Why an assigned ticket is left alone when the key's owner could not be read. */
const OWNER_UNREAD = "the ticket is assigned and the key's owner could not be read";

/** Why a ticket assigned to somebody Day0 can name but not identify is left alone. */
const ASSIGNEE_UNIDENTIFIED =
  'the ticket is assigned to a person named without an id or email Day0 can compare';

/** The refusals that say nothing about whose ticket it is: they hold the checkpoint, never withdraw. */
const HELD_REFUSALS: ReadonlySet<string> = new Set([OWNER_UNREAD, ASSIGNEE_UNIDENTIFIED]);

/**
 * Why intake leaves a Linear ticket alone, by the kanban's own primitives
 * (Q11): a completed or cancelled state, the do-not-automate label, or a
 * holder (the delegate when one is set, else the assignee: `ticketHolder`)
 * who is not the identity Day0's token acts as, compared by id and then by
 * email, never by name: under an app identity that is the employee's app
 * user, so a ticket assigned to the manager is not taken (D6). When that
 * identity could not be read, any held ticket is left alone: it may be
 * somebody else's, and the unassigned ones are still worked.
 *
 * Args:
 *   issue: Provider issue object.
 *   owner: The id and address of the identity the token acts as, or
 *     undefined when unread.
 *
 * Returns:
 *   The reason to skip, or undefined when the ticket is intake's to take.
 */
export function linearIntakeRefusal(
  issue: Record<string, unknown>,
  owner: PersonIdentity | undefined,
): string | undefined {
  const state = ticketStateType(issue);
  if (isClosedStateType(state)) return `the ticket is ${state}`;
  if (ticketLabels(issue).includes(DO_NOT_AUTOMATE_LABEL)) {
    return `the ticket is labelled ${DO_NOT_AUTOMATE_LABEL}`;
  }
  const assignee = ticketHolder(issue);
  if (assignee === undefined) return undefined;
  if (owner === undefined) return OWNER_UNREAD;
  const same = samePerson(assignee, owner);
  if (same === undefined) return ASSIGNEE_UNIDENTIFIED;
  return same ? undefined : 'the ticket is assigned to someone else';
}

/**
 * Ask Linear who the intake key belongs to, through the key's own `get_user`
 * with `me`, so a holder can be compared with it. A card acting as an app
 * never asks: the app user its probe read is the owner (`appIdentityOf`).
 *
 * Args:
 *   client: The connected MCP client.
 *   tools: The tools the server listed.
 *   allowlist: The tools the surface's approval allows.
 *   credential: The decrypted bearer, kept out of any logged reason.
 *
 * Returns:
 *   The owner's id and address, lower-cased; undefined when the tool is not
 *   allowed or the answer carries neither, since a name identifies nobody.
 */
async function linearKeyOwner(
  client: McpIntakeClient,
  tools: Record<string, McpToolDefinition> | undefined,
  allowlist: readonly string[] | undefined,
  credential: string,
): Promise<PersonIdentity | undefined> {
  const definition = tools?.get_user;
  if (!definition || !allowlist?.includes('get_user')) return undefined;
  const argument = discoveredArgument(schemaProperties(definition.inputSchema), [
    'query',
    'id',
    'userId',
    'user',
  ]);
  if (!argument) return undefined;
  try {
    const tool = await client.toolFromDefinition({ serverName: 'surface', definition });
    if (!tool.execute) return undefined;
    const answer = asRecord(
      decodeMcpPayload(
        await tool.execute(
          { [argument]: 'me' },
          { abortSignal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) },
        ),
      ),
    );
    const user = asRecord(answer?.user) ?? answer;
    const owner: PersonIdentity = { id: personKey(user?.id), email: personKey(user?.email) };
    return owner.id !== undefined || owner.email !== undefined ? owner : undefined;
  } catch (error) {
    log.warn('linear key owner unreadable; assigned tickets are left alone this poll', {
      reason: safeIntakeError(error, credential),
    });
    return undefined;
  }
}

/**
 * Read a person field in the shapes providers use.
 *
 * Linear's MCP server returns `createdBy` and `assignee` as display names;
 * GraphQL-shaped payloads nest a `creator` or `assignee` object.
 *
 * Args:
 *   issue: Provider issue object.
 *   keys: Field names to try, in order.
 *
 * Returns:
 *   The first name or email found, or undefined.
 */
function personOf(issue: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
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
): IntakeCandidate | undefined {
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
  const requester = personOf(issue, ['creator', 'createdBy']);
  const owner = personOf(issue, ['assignee']);
  // Linear's MCP server prints the identifier as `id` and the UUID as `uuid`;
  // a GraphQL-shaped read prints the UUID as `id` beside `identifier`.
  const alias = [issue.uuid, issue.identifier].find(
    (name): name is string => typeof name === 'string' && name.trim() !== '' && name !== id,
  );
  const createdAt = typeof issue.createdAt === 'string' ? Date.parse(issue.createdAt) : NaN;
  return {
    sourceCategory: 'ticket-queue',
    sourceSystem: surface.slug,
    externalId: id,
    ...(alias === undefined ? {} : { externalAlias: alias.trim() }),
    title: title.slice(0, 240),
    contentSummary: description.slice(0, 4_000),
    contentRefs: [url],
    observedAt: new Date(observedAt),
    ...(Number.isNaN(createdAt) ? {} : { askedAt: createdAt }),
    priority,
    requesterLabel: requester ?? owner,
    ...(owner === undefined ? {} : { owner }),
    ...(requester === undefined ? {} : { requester }),
  };
}

/**
 * Create the production MCP client intake polls one endpoint with.
 *
 * The client resolves the endpoint's hostname once, before its first
 * request, refuses it unless every answer is public, and then dials only
 * those answers, as the surfaces layer's clients do: the bearer never
 * reaches an address the check did not see.
 *
 * A request the server answers with a 429 or a 5xx is tried again under the
 * provider backoff, keeping the client's own signal.
 *
 * @param endpoint - The validated endpoint.
 * @param credential - The decrypted bearer, kept inside the Node action.
 * @param connection - The resolver and transport; a test supplies its own.
 * @param backoff - How a rate-limited request waits; a test records the waits.
 * @returns The bounded client contract intake uses, connected on first use.
 */
export function createMcpClient(
  endpoint: URL,
  credential: string,
  connection: McpConnection = { resolveHostname },
  backoff: BackoffPolicy = PROVIDER_BACKOFF,
): McpIntakeClient {
  let created: Promise<McpIntakeClient> | undefined;
  const create = async (): Promise<McpIntakeClient> => {
    const checked = await checkMcpAddress(endpoint, connection.resolveHostname);
    return createSecretMcpClient({
      id: `day0-intake-${randomUUID()}`,
      servers: {
        surface: {
          url: checked.url,
          allowedHosts: [checked.url.host],
          fetch: fetchWithBackoff(pinnedFetch(checked, connection.request), undefined, backoff),
          requestInit: { headers: { Authorization: `Bearer ${credential}` } },
        },
      },
      timeout: PROVIDER_TIMEOUT_MS,
    }) as unknown as McpIntakeClient;
  };
  const client = (): Promise<McpIntakeClient> => (created ??= create());
  return {
    listToolDefinitionsWithErrors: async (options) =>
      await (await client()).listToolDefinitionsWithErrors(options),
    toolFromDefinition: async (args) => await (await client()).toolFromDefinition(args),
    disconnect: async (): Promise<void> => {
      if (!created) return;
      // A client whose address check refused it never connected, so there is nothing to close.
      const connected = await created.catch((): undefined => undefined);
      await connected?.disconnect();
    },
  };
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

/** A ticket intake refused on this poll, and why it left the queue. */
interface WithdrawnTicket {
  readonly candidate: IntakeCandidate;
  readonly leftQueue: string;
}

/** What one Linear poll found. */
interface LinearPoll {
  readonly candidates: readonly IntakeCandidate[];
  readonly withdrawn: readonly WithdrawnTicket[];
  /** Each listed ticket as the ownership rule read it, by external id. */
  readonly trackers: ReadonlyMap<string, TicketSnapshot>;
  readonly holdCheckpoint?: string;
}

/**
 * The card line for a server whose list cannot show who owns a ticket.
 *
 * @param unselectable - The facts the `fields` selector cannot select.
 * @returns The surface's intake reason while the checkpoint is held.
 */
function unreadableOwnershipHold(unselectable: readonly string[]): string {
  const facts =
    unselectable.length > 1
      ? `${unselectable.slice(0, -1).join(', ')} or ${unselectable.at(-1)}`
      : unselectable.join('');
  return `Day0 cannot see who owns these tickets on this server: its list_issues cannot select ${facts}. No ticket is taken until the schema is confirmed.`;
}

/**
 * Poll all bounded Linear pages and map their issues to candidates.
 *
 * A card approved with an intake scope reads that team and project and
 * nothing else; a row connected before the scope existed keeps the page
 * scan as it was. A bound the schema cannot express is applied to the
 * returned issues here: the project always, the team for an approved scope.
 *
 * Args:
 *   surface: Connected kanban surface.
 *   pages: Runbook pages visible to its agent.
 *   credential: Decrypted bearer.
 *   observedAt: Poll start used for candidate timestamps.
 *   makeClient: Injectable MCP client factory.
 *
 * Returns:
 *   Normalised candidates newer than the previous checkpoint; the tickets
 *   the rule refused, with why each left the queue, so a row seeded before
 *   is withdrawn; and why the checkpoint must stay where it is when the
 *   schema cannot show who owns a ticket, or an assigned ticket was left
 *   alone only because the key's owner could not be read: it may be the
 *   owner's, and the next poll reads the same window again.
 */
async function pollLinear(
  surface: Doc<'surfaces'>,
  pages: readonly Doc<'docPages'>[],
  credential: string,
  observedAt: number,
  makeClient: (endpoint: URL, credential: string) => McpIntakeClient,
): Promise<LinearPoll> {
  if (!surface.toolAllowlist?.includes('list_issues')) {
    throw new Error('Connected Linear surface does not allow list_issues.');
  }
  const scope: LinearScope = surface.intakeScope
    ? approvedLinearScope(surface.intakeScope)
    : linearScopeFromPages(pages);
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
    // Fail closed (review M8, decision D2): a list that cannot carry who owns
    // a ticket would seed a person's ticket as unassigned.
    const unselectable = [
      ...linearListArguments(definition.inputSchema, { team: scope.team }).unselectable,
      ...(isAppIdentity(surface) ? appTicketFactsUnselectable(definition.inputSchema) : []),
    ];
    if (unselectable.length > 0) {
      return {
        candidates: [],
        withdrawn: [],
        trackers: new Map(),
        holdCheckpoint: unreadableOwnershipHold(unselectable),
      };
    }
    // Under an app identity the owner is the app user the card acts as (D6), read at the probe.
    const owner =
      appIdentityOf(surface) ??
      (await linearKeyOwner(client, definitions.surface, surface.toolAllowlist, credential));

    const candidates: WorkCandidate[] = [];
    const candidateIds = new Set<string>();
    const withdrawn: WithdrawnTicket[] = [];
    const trackers = new Map<string, TicketSnapshot>();
    const leftAlone = new Map<string, number>();
    const projects = scope.projects?.length ? [...new Set(scope.projects)] : [scope.project];
    // Only an approved team is enforced here. A row still on the page scan
    // keeps its behaviour exactly, and the scan's team may be another
    // role's handbook's, which is the defect the approved scope replaces.
    const wantedTeam = surface.intakeScope ? scope.team?.toLowerCase() : undefined;
    for (const approvedProject of projects) {
      const cursors = new Set<string>();
      const wantedProject = approvedProject?.toLowerCase();
      let seen = 0;
      let withProject = 0;
      let withTeam = 0;
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_MCP_PAGES; pageIndex += 1) {
        const request = linearListArguments(
          definition.inputSchema,
          { team: scope.team, project: approvedProject },
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
          if (
            wantedProject !== undefined &&
            (project === undefined
              ? surface.intakeScope !== undefined
              : project.toLowerCase() !== wantedProject)
          ) {
            continue;
          }
          if (wantedTeam !== undefined && !request.teamEnforced) {
            const teams = issueTeamLabels(issue);
            if (teams.length > 0) withTeam += 1;
            if (!teams.includes(wantedTeam)) continue;
          }
          const updatedAt = typeof issue.updatedAt === 'string' ? Date.parse(issue.updatedAt) : NaN;
          if (
            surface.lastPolledAt !== undefined &&
            Number.isFinite(updatedAt) &&
            updatedAt < surface.lastPolledAt
          ) {
            continue;
          }
          const refusal = linearIntakeRefusal(issue, owner);
          if (refusal !== undefined) {
            leftAlone.set(refusal, (leftAlone.get(refusal) ?? 0) + 1);
            // An unread owner or an unidentified assignee says nothing about
            // whose ticket it is, so its row stays and the window is read again.
            const left = HELD_REFUSALS.has(refusal)
              ? undefined
              : linearCandidate(issue, surface, observedAt);
            if (left && !candidateIds.has(left.externalId)) {
              withdrawn.push({ candidate: left, leftQueue: refusal });
              trackers.set(left.externalId, ticketSnapshot(issue));
              candidateIds.add(left.externalId);
            }
            continue;
          }
          const candidate = linearCandidate(issue, surface, observedAt);
          if (candidate && !candidateIds.has(candidate.externalId)) {
            candidates.push(candidate);
            trackers.set(candidate.externalId, ticketSnapshot(issue));
            candidateIds.add(candidate.externalId);
          }
        }
        if (
          wantedProject !== undefined &&
          !request.projectEnforced &&
          seen > 0 &&
          withProject === 0
        ) {
          throw new Error(
            `Linear list_issues has no project argument and its issues carry no project field, so intake cannot be bounded to project ${approvedProject}.`,
          );
        }
        if (wantedTeam !== undefined && !request.teamEnforced && seen > 0 && withTeam === 0) {
          throw new Error(
            `Linear list_issues has no team argument and its issues carry no team, so intake cannot be bounded to team ${scope.team}.`,
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
    }
    if (leftAlone.size > 0) {
      log.info('linear intake left tickets alone', {
        surfaceId: surface._id,
        reasons: Object.fromEntries(leftAlone),
      });
    }
    const unread = leftAlone.get(OWNER_UNREAD) ?? 0;
    const unidentified = leftAlone.get(ASSIGNEE_UNIDENTIFIED) ?? 0;
    const held = [
      ...(unread > 0 ? [`${unread} because the key's owner could not be read`] : []),
      ...(unidentified > 0
        ? [`${unidentified} because the assignee could not be identified by id or email`]
        : []),
    ];
    return held.length === 0
      ? { candidates, withdrawn, trackers }
      : {
          candidates,
          withdrawn,
          trackers,
          holdCheckpoint: `${unread + unidentified} assigned ticket(s) left alone, ${held.join(' and ')}; the checkpoint is held so the next poll reads them again.`,
        };
  } finally {
    await client.disconnect();
  }
}

function mcpMessagePage(value: unknown): { messages: ChatMessage[]; nextCursor?: string } {
  const decoded = decodeMcpPayload(value);
  const record = asRecord(decoded) ?? {};
  const data = asRecord(record.data);
  const container = data ?? record;
  const rows = Array.isArray(container.messages)
    ? container.messages
    : Array.isArray(container.items)
      ? container.items
      : [];
  const messages = rows.flatMap((item): ChatMessage[] => {
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

/** Slack's answer for a thread whose parent message is not in the channel. */
const SLACK_THREAD_NOT_FOUND = 'thread_not_found';

/** What reads of the manager DM found, keyed by message ts so a message read twice counts once. */
interface ManagerMessages {
  /** The messages read as approve or reject. */
  readonly replies: Map<string, ChatPollResult['decisionReplies'][number]>;
  /** The manager's own messages read as neither. */
  readonly unreadable: Map<string, ChatPollResult['unreadableReplies'][number]>;
}

/** An empty read of the manager DM. */
function managerMessages(): ManagerMessages {
  return { replies: new Map(), unreadable: new Map() };
}

/**
 * Sort the messages of one DM read into replies read as a decision and the
 * manager's messages read as none. Day0's own posts are neither.
 *
 * @param found - The reads so far, added to.
 * @param surface - The chat surface, for the bot's and the manager's ids.
 * @param messages - The messages this read returned.
 * @param skipTs - A thread's parent, which is Day0's request, not a reply.
 */
function collectManagerMessages(
  found: ManagerMessages,
  surface: Doc<'surfaces'>,
  messages: readonly ChatMessage[],
  skipTs?: string,
): void {
  for (const message of messages) {
    if (message.ts === skipTs) continue;
    if (!message.user || message.user === surface.providerIdentityId) continue;
    const reply = parseDecisionReply(message.text);
    if (reply) {
      found.replies.set(message.ts, { userId: message.user, messageTs: message.ts, reply });
    } else if (message.user === surface.managerUserId) {
      found.unreadable.set(message.ts, { userId: message.user, messageTs: message.ts });
    }
  }
}

/** Read the manager DM through a generic chat MCP connection's discovered history tool. */
async function pollMcpManagerReplies(
  surface: Doc<'surfaces'>,
  credential: string,
  makeClient: (endpoint: URL, credential: string) => McpIntakeClient,
): Promise<ManagerMessages> {
  const found = managerMessages();
  if (!surface.managerDmChannelId || !surface.managerUserId) return found;
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
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
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
      collectManagerMessages(found, surface, page.messages);
      if (!page.nextCursor) break;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error('Chat history repeated a cursor before pagination completed.');
      }
      if (pageIndex === MAX_HISTORY_PAGES - 1) {
        throw new Error('Chat history pagination did not complete within the page limit.');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return found;
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
  message: ChatMessage,
  channel: ChatChannel,
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
    requester: message.user,
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
 * Whether the connected app itself posted a message, under whatever name.
 *
 * A post sent with a customised display name carries no `user`, so the bot's
 * user id alone never matches it. Every employee posts that way, and siblings
 * on a shared key are one app, so without the app's own identity an employee's
 * post in a shared channel reads as an ask to its siblings and to itself.
 * Another app's post and a person's message match none of the three.
 *
 * Args:
 *   message: One channel history row.
 *   surface: Connected Slack surface with the identity its probe stored.
 *
 * Returns:
 *   True when the message is the app's own.
 */
function postedByConnectedApp(
  message: ChatMessage,
  surface: Doc<'surfaces'>,
  botId: string,
): boolean {
  if (message.user !== undefined && message.user === surface.providerIdentityId) return true;
  if (message.botId === botId) return true;
  return message.appId !== undefined && message.appId === surface.provisioning?.appId;
}

const NO_APP_IDENTITY = 'Slack probe stored no app identity; probe the surface again.';

/**
 * The connected app's bot id: the one the probe stored, or, for a row connected
 * before the probe stored it, the one the credential itself reports now.
 *
 * A restored bed holds such rows, and its first poll must not wait an hour for
 * the re-probe. The answer is trusted only when it names the bot user the probe
 * did store, so a credential changed since never lends its identity to the row;
 * it is then kept, so this is asked once. Anything short of that reads no work:
 * without the identity the app's own customised posts cannot be told from asks.
 *
 * Args:
 *   surface: Connected Slack surface.
 *   reader: The surface's chat reader.
 *   remember: Persists an identity read here against the row's probe generation.
 *
 * Returns:
 *   The bot id Slack stamps on everything this app posts.
 *
 * Raises:
 *   Error: If the identity is neither stored nor establishable.
 */
async function connectedBotId(
  surface: Doc<'surfaces'>,
  reader: ChatReader,
  remember: (providerBotId: string, generation: number) => Promise<void>,
): Promise<string> {
  if (surface.providerBotId) return surface.providerBotId;
  if (!surface.toolAllowlist?.includes('auth.test') || surface.probeGeneration === undefined) {
    throw new Error(NO_APP_IDENTITY);
  }
  const identity = await reader.identity();
  if (identity.userId !== surface.providerIdentityId) throw new Error(NO_APP_IDENTITY);
  if (!identity.botId) throw new Error(NO_APP_IDENTITY);
  await remember(identity.botId, surface.probeGeneration);
  return identity.botId;
}

/** What one chat poll reads: the manager's decision replies, the channels' asks, or both. */
interface ChatPollScope {
  /** What the manager DM has open, when this poll reads decisions; absent, it reads none. */
  readonly decisions?: OpenDecisions;
  readonly work: boolean;
  /**
   * When the agent was deployed, in epoch milliseconds. A mention written
   * before it was addressed to whatever answered the bot then (an earlier
   * agent, or another deployment on the same workspace), so the work read
   * starts here and never takes an older mention, as a decision reply that
   * predates the agent is never taken either.
   */
  readonly mentionsSince?: number;
}

/**
 * Poll a chat surface's approved channels for exact mentions of the connected
 * bot, and its manager DM for decision replies, through the surface's chat
 * reader (B's contract, A6: one reader per rung, no bespoke adapter here).
 *
 * Args:
 *   surface: Connected chat surface with probe identity metadata.
 *   reader: The surface's chat reader.
 *   pages: Policy pages visible to the agent, for a card with no approved scope.
 *   observedAt: Poll start used for candidate timestamps.
 *
 * Returns:
 *   Normalised mention candidates, and the manager's replies.
 */
async function pollChatReader(
  surface: Doc<'surfaces'>,
  reader: ChatReader,
  pages: readonly Doc<'docPages'>[],
  observedAt: number,
  include: ChatPollScope,
  rememberBotId: (providerBotId: string, generation: number) => Promise<void>,
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
  const unread: ChatPollResult['unread'] = [];
  if (include.work) {
    if (!surface.providerIdentityId) throw new Error('Slack probe stored no bot identity.');
    if (!surface.providerWorkspaceId) throw new Error('Slack probe stored no workspace identity.');
    const botId = await connectedBotId(surface, reader, rememberBotId);
    const names = surface.intakeScope
      ? approvedChannelNames(surface.intakeScope)
      : slackChannelsFromPages(pages);
    if (names.length === 0) throw new Error('Slack policy names no intake channels.');
    const channels = await reader.listChannels(names);
    const mention = `<@${surface.providerIdentityId}>`;
    const since = include.mentionsSince;
    const sinceTs = since === undefined ? undefined : String(since / 1_000);
    for (const channel of channels) {
      // One channel that still fails after its retries costs that channel's
      // read, not the rest of the poll: its mentions are read again next time.
      let messages: ChatMessage[];
      try {
        messages = await reader.readSince(channel.id, surface.lastPolledAt ?? since);
      } catch (error) {
        // A refusal (`not_in_channel`, `invalid_auth`, the page limit) is not
        // waited out by reading again, so it fails the poll as it always did.
        if (
          !(error instanceof TransientProviderError) &&
          transportFailureKind(error) !== 'interrupted'
        ) {
          throw error;
        }
        unread.push({ what: `#${channel.name}`, error });
        continue;
      }
      for (const message of messages) {
        if (!message.text.includes(mention) || postedByConnectedApp(message, surface, botId))
          continue;
        if (sinceTs !== undefined && compareProviderTs(message.ts, sinceTs) < 0) continue;
        candidates.push(slackCandidate(message, channel, surface, observedAt));
      }
    }
  }
  const found = managerMessages();
  const missingThreads: string[] = [];
  const unreadThreads: string[] = [];
  const open = include.decisions;
  if (open && surface.managerDmChannelId && surface.managerUserId) {
    const dm = surface.managerDmChannelId;
    // The top-level read is the poll: when it fails nothing is resolved and
    // the checkpoint holds.
    collectManagerMessages(found, surface, await reader.readSince(dm, surface.lastPolledAt));
    // `conversations.history` lists only top-level messages. A manager who answers in
    // the thread under the request is answering all the same, so each open request's
    // thread is read too, when the probe allowlisted the replies method. A thread
    // that cannot be read holds only the replies to its own request (Q13).
    if (surface.toolAllowlist?.includes('conversations.replies')) {
      for (const request of open.requests) {
        if (request.ts === undefined) continue;
        try {
          collectManagerMessages(
            found,
            surface,
            await reader.readThread(dm, request.ts, surface.lastPolledAt),
            request.ts,
          );
        } catch (error) {
          if (error instanceof ChatReadRefused && error.code === SLACK_THREAD_NOT_FOUND) {
            missingThreads.push(request.decisionId);
            continue;
          }
          unreadThreads.push(request.decisionId);
          unread.push({ what: `the thread of decision ${request.decisionId}`, error });
        }
      }
    }
  }
  const held = heldReplyCodes(open ?? NOTHING_OPEN, unreadThreads);
  return {
    candidates,
    decisionReplies: [...found.replies.values()].filter((reply) => !held.has(reply.reply.id)),
    unreadableReplies: open && open.requests.length > 0 ? [...found.unreadable.values()] : [],
    missingThreads,
    unread,
  };
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
  include: ChatPollScope,
  rememberBotId: (providerBotId: string, generation: number) => Promise<void>,
): Promise<ChatPollResult> {
  const polled = await (async (): Promise<ChatPollResult> => {
    // The MCP rung reads the manager DM through its own history tool; the
    // chat reader has no MCP rung yet, and switching would stop MCP decisions.
    if (surface.path === 'mcp') {
      const found = include.decisions
        ? await pollMcpManagerReplies(surface, credential, makeClient)
        : managerMessages();
      return {
        candidates: [],
        decisionReplies: [...found.replies.values()],
        unreadableReplies:
          include.decisions && include.decisions.requests.length > 0
            ? [...found.unreadable.values()]
            : [],
        missingThreads: [],
        unread: [],
      };
    }
    const chosen = chatReaderFor(toSurfaceRecord(surface), {
      credential,
      fetch: fetcher,
      slackApiBase: slackApiBaseUrl(),
    });
    if (!chosen.ok) throw new Error(chosen.reason);
    return await pollChatReader(surface, chosen.reader, pages, observedAt, include, rememberBotId);
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
 *   agent: The employee as the sweep read it; the seed lands only while its owner is unchanged.
 *   candidate: Normalised provider item.
 */
async function seedCandidate(
  runtime: IntakeRuntime,
  agent: Pick<Doc<'agents'>, '_id' | 'userId'>,
  candidate: IntakeCandidate,
  trackers: ReadonlyMap<string, TicketSnapshot> = new Map(),
): Promise<void> {
  await runtime.seed(seedOf(agent._id, candidate, trackers), agent.userId ?? null);
}

/**
 * The seed a candidate makes for one agent, with the ticket as it was listed,
 * when it was raised and when this poll read it.
 */
function seedOf(
  agentId: Id<'agents'>,
  candidate: IntakeCandidate,
  trackers: ReadonlyMap<string, TicketSnapshot>,
): IntakeSeed {
  const tracker = trackers.get(candidate.externalId);
  return {
    ...(tracker ? { tracker } : {}),
    ...(candidate.askedAt === undefined ? {} : { askedAt: candidate.askedAt }),
    observedAt: candidate.observedAt.getTime(),
    agentId,
    sourceCategory: candidate.sourceCategory,
    sourceSystem: candidate.sourceSystem,
    externalId: candidate.externalId,
    externalAlias: candidate.externalAlias,
    title: candidate.title,
    contentSummary: candidate.contentSummary,
    contentRefs: candidate.contentRefs,
    priority: candidate.priority,
    requesterLabel: candidate.requesterLabel,
    owner: candidate.owner,
    requester: candidate.requester,
    replyTarget: candidate.replyTarget,
  };
}

/** Bind the runtime's identity write to one surface. */
function rememberBotId(
  runtime: IntakeRuntime,
  surfaceId: Id<'surfaces'>,
): (providerBotId: string, generation: number) => Promise<void> {
  return (providerBotId: string, generation: number): Promise<void> =>
    runtime.recordBotIdentity({ surfaceId, generation, providerBotId });
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
 * Why intake reads nothing from a surface whose read scope is not held.
 *
 * Args:
 *   scope: The surface's read scope, `<slug>:read`.
 *
 * Returns:
 *   The skip reason the card shows.
 */
function ungrantedReadReason(scope: string): string {
  return `read scope ${scope} is not granted; intake reads nothing here until the manager grants it again`;
}

/**
 * Why intake stopped short while the employee's waiting queue is at its bound.
 *
 * Args:
 *   limit: The bound on waiting rows.
 *   held: How many listed items were left for a later poll, when known.
 *
 * Returns:
 *   The skip reason the card shows.
 */
function queueFullReason(limit: number, held?: number): string {
  const rest = held === undefined ? 'more' : `${held} more`;
  return `${limit} items are waiting to be evaluated; intake reads ${rest} once the queue drains`;
}

/**
 * The listed items a poll seeds within the bound on waiting work (N7).
 *
 * An item that already has a row is re-listed whatever the room, since it
 * adds nothing to the queue; a new item takes a place while one is left.
 *
 * Args:
 *   runtime: Persistence boundary.
 *   agentId: The employee.
 *   candidates: The poll's items, in list order.
 *   room: Places left in the employee's waiting queue.
 *
 * Returns:
 *   The items to seed, how many new items were left for a later poll, and the room left.
 */
async function admitWithinBound(
  runtime: IntakeRuntime,
  agentId: Id<'agents'>,
  candidates: readonly WorkCandidate[],
  room: number,
): Promise<{ admitted: WorkCandidate[]; held: number; room: number }> {
  const known = new Set<string>();
  for (const sourceSystem of new Set(candidates.map((candidate) => candidate.sourceSystem))) {
    const ids = candidates
      .filter((candidate) => candidate.sourceSystem === sourceSystem)
      .map((candidate) => candidate.externalId);
    for (const id of await runtime.seededItems(agentId, sourceSystem, ids)) {
      known.add(`${sourceSystem}:${id}`);
    }
  }
  const admitted: WorkCandidate[] = [];
  let held = 0;
  let left = room;
  for (const candidate of candidates) {
    if (known.has(`${candidate.sourceSystem}:${candidate.externalId}`)) {
      admitted.push(candidate);
    } else if (left > 0) {
      admitted.push(candidate);
      left -= 1;
    } else {
      held += 1;
    }
  }
  return { admitted, held, room: left };
}

/**
 * Run one deployment-wide waterfall sweep.
 *
 * A connected surface is read only while its employee holds `<slug>:read`
 * (Q7): a revoked read scope stops intake before the credential is touched.
 * Seeding is bounded (N7): while the employee's waiting queue is at its bound
 * nothing is read, and a poll seeds new items only into the room left, holding
 * the checkpoint so the rest is read again once the queue drains. An item that
 * already has a row is always re-listed: it adds nothing to the queue.
 * The manager's decision poll (`runDecisionSweep`) runs under the manager
 * channel's own scope and is not stopped by it (N2).
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
  const now = dependencies.now ?? Date.now;
  const fetcher = providerFetcher(dependencies, now);
  const makeMcpClient = dependencies.makeMcpClient ?? createMcpClient;
  const browserAbsent = browserComponentRefusal(
    dependencies.browserMcpUrl ?? process.env.DAY0_BROWSER_MCP_URL,
  );
  const { surfaces, owners } = await runtime.readSweep();
  const ownerAtRead = new Map(owners.map(({ agentId, owner }) => [agentId, owner]));
  const target = dependencies.surfaceId;
  const inScope = (surface: Doc<'surfaces'>): boolean =>
    target === undefined || surface._id === target;
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
    if (!agentSurfaces.some(inScope)) continue;
    const startedUnder = ownerAtRead.get(agentId);
    const agent = await runtime.getAgent(agentId);
    // Gone at the read, gone since, or handed over since: the rows read above carry the old
    // owner's connection, so nothing is polled with them; the next sweep reads the new owner's.
    if (!agent || startedUnder === undefined || (agent.userId ?? null) !== startedUnder) continue;
    let documentation: IntakeDocumentation;
    let scopes: string[];
    let queue: { waiting: number; limit: number };
    try {
      [documentation, scopes, queue] = await Promise.all([
        runtime.intakeDocumentation(
          agentId,
          agentSurfaces.filter(inScope).map((surface) => surface.displayName),
        ),
        runtime.grantedScopes(agentId),
        runtime.waitingWork(agentId),
      ]);
    } catch (error) {
      // One employee's reads failing is that employee's poll failing, not the sweep's.
      for (const surface of agentSurfaces.filter(inScope)) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          // The order is read from the pages that could not be read; keep the last one.
          waterfallPosition: surface.waterfallPosition ?? 0,
          skipReason: `intake failed: ${safeIntakeError(error, '')}`,
        });
        skipped += 1;
      }
      continue;
    }
    const granted = new Set(scopes);
    let waiting = queue.waiting;
    const { order: documentedNames, pages } = documentation;
    const ordered = orderSurfaceWaterfall(agentSurfaces, documentedNames);
    for (const [index, surface] of ordered.entries()) {
      if (!inScope(surface)) continue;
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
      // The end date is the boundary, not the hourly sweep that ends the row.
      if (surface.expiresAt !== undefined && accessEnded(surface, now())) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: accessEndedReason(surface.expiresAt, agentZone(agent)),
        });
        skipped += 1;
        continue;
      }
      const readScope = `${surface.slug}:read`;
      if (!granted.has(readScope)) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: ungrantedReadReason(readScope),
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
      // An approved scope with nothing in it is an answer, not a fault: this
      // employee reads nothing here, and no credential is touched to find that out.
      if (surface.intakeScope && isEmptyScope(surface.intakeScope, surface.class)) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: emptyScopeReason(surface.displayName, surface.class),
        });
        skipped += 1;
        continue;
      }

      if (waiting >= queue.limit) {
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: queueFullReason(queue.limit),
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
                { work: true, mentionsSince: agent.createdAt },
                rememberBotId(runtime, surface._id),
              )
            : undefined;
        const polledPage: LinearPoll = chat
          ? { candidates: chat.candidates, withdrawn: [], trackers: new Map() }
          : await pollLinear(surface, pages, credential, pollStartedAt, makeMcpClient);
        const admission = await admitWithinBound(
          runtime,
          agentId,
          polledPage.candidates,
          queue.limit - waiting,
        );
        const mapped = admission.admitted;
        const held = admission.held;
        // Each candidate is seeded on its own: one that fails is named and read
        // again next time, and the rest are not held back behind it.
        const unseeded: ChatPollResult['unread'] = [...(chat?.unread ?? [])];
        let seeded = 0;
        for (const candidate of mapped) {
          try {
            await seedCandidate(runtime, agent, candidate, polledPage.trackers);
            seeded += 1;
          } catch (error) {
            unseeded.push({ what: candidate.externalId, error });
          }
        }
        // A candidate that failed to seed holds no place in the queue.
        waiting = queue.limit - admission.room - (mapped.length - seeded);
        for (const { candidate, leftQueue } of polledPage.withdrawn) {
          await runtime.withdraw({
            ...seedOf(agentId, candidate, polledPage.trackers),
            leftQueue,
          });
        }
        const holdCheckpoint =
          unseeded.length > 0
            ? `intake read in part; read again next time: ${unseeded
                .map(({ what, error }) => `${what} (${safeIntakeError(error, credential)})`)
                .join('; ')}`
            : held > 0
              ? queueFullReason(queue.limit, held)
              : polledPage.holdCheckpoint;
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          ...(holdCheckpoint === undefined
            ? { polledAt: pollStartedAt }
            : { skipReason: holdCheckpoint }),
        });
        candidates += seeded;
        // A poll that read in part holds its checkpoint, so it has not completed.
        if (unseeded.length > 0) skipped += 1;
        else polled += 1;
      } catch (error) {
        const own = safeIntakeError(error, credential);
        // The card says what the failure means; the provider's own line stays in the log.
        log.warn('intake poll failed', { surfaceId: surface._id, reason: own });
        await runtime.recordIntake({
          surfaceId: surface._id,
          waterfallPosition,
          skipReason: `intake failed: ${intakeFailureWords({
            system: surface.displayName,
            error,
            otherwise: () => own,
          })}`,
        });
        skipped += 1;
      } finally {
        credential = '';
      }
    }
  }
  return { candidates, mode, polled, skipped, surfaces: surfaces.filter(inScope).length };
}

/**
 * The fetch every provider read in one sweep goes through: each request with
 * its own timeout, and one bounded backoff that honours Retry-After (Q13).
 */
function providerFetcher(dependencies: IntakeDependencies, now: () => number): IntakeFetcher {
  return fetchWithBackoff(
    dependencies.fetcher ?? fetch,
    PROVIDER_TIMEOUT_MS,
    {
      ...PROVIDER_BACKOFF,
      ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
      deadline: Date.now() + SWEEP_WAIT_BUDGET_MS,
    },
    now,
  );
}

/** Poll only manager decision replies, without touching discovery checkpoints. */
export async function runDecisionSweep(
  runtime: IntakeRuntime,
  dependencies: IntakeDependencies = {},
): Promise<DecisionSweepResult> {
  const mode = dependencies.mode ?? SURFACE_MODE;
  if (mode !== 'real') return { mode, polled: 0, idle: 0, skipped: 0, surfaces: 0 };
  const now = dependencies.now ?? Date.now;
  const fetcher = providerFetcher(dependencies, now);
  const makeMcpClient = dependencies.makeMcpClient ?? createMcpClient;
  const surfaces = await runtime.listChatSurfaces();
  let polled = 0;
  let idle = 0;
  let skipped = 0;
  for (const surface of surfaces) {
    if (
      surface.verdict !== 'connected' ||
      accessEnded(surface, now()) ||
      !surface.credentialId ||
      !surface.managerDmChannelId ||
      !surface.managerUserId
    ) {
      // A row that is no longer polled cannot still be failing to poll, and
      // its disconnection is already reported by the work sweep.
      if (surface.lastDecisionError) {
        await runtime.recordDecisionPoll({ surfaceId: surface._id });
      }
      skipped += 1;
      continue;
    }
    const pollStartedAt = now();
    let credential = '';
    try {
      const open = await runtime.openDecisions(surface._id);
      if (!readsManagerDm(open)) {
        // Nothing asked, nothing just decided: the DM is not read and no
        // credential is touched (Q13). The checkpoint moves on, because a
        // message in this window can answer nothing.
        await runtime.recordDecisionPoll({ surfaceId: surface._id, polledAt: pollStartedAt });
        idle += 1;
        continue;
      }
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
        { decisions: open, work: false },
        rememberBotId(runtime, surface._id),
      );
      // One message at a time, each tied to its request by its code; a reply
      // to a request whose thread could not be read waits for the next poll.
      for (const reply of chat.decisionReplies) {
        await runtime.resolveDecision({ surfaceId: surface._id, ...reply });
      }
      for (const decisionId of chat.missingThreads) {
        await runtime.closeDecisionThread({ surfaceId: surface._id, decisionId });
      }
      for (const message of chat.unreadableReplies) {
        await runtime.noticeUnreadableReply({ surfaceId: surface._id, ...message });
      }
      if (chat.unread.length > 0) {
        // The checkpoint holds, so the unread thread is read again next time;
        // the replies resolved now are recognised by their ts when re-read.
        await runtime.recordDecisionPoll({
          surfaceId: surface._id,
          failure: `decision poll read in part; read again next time: ${chat.unread
            .map(({ what, error }) => `${what} (${safeIntakeError(error, credential)})`)
            .join('; ')}`,
        });
        skipped += 1;
      } else {
        await runtime.recordDecisionPoll({ surfaceId: surface._id, polledAt: pollStartedAt });
        polled += 1;
      }
    } catch (error) {
      // The checkpoint stays where it was, so the window this run could not
      // read is re-read by the next one, and the reason lands on the surface
      // card: the work sweep no longer touches the manager DM, so nothing
      // else would tell the operator that approvals have stopped arriving.
      const reason = `decision poll failed: ${safeIntakeError(error, credential)}`;
      await runtime.recordDecisionPoll({ surfaceId: surface._id, failure: reason });
      skipped += 1;
    } finally {
      credential = '';
    }
  }
  return { mode, polled, idle, skipped, surfaces: surfaces.length };
}

/**
 * Read an employee's documentation as intake needs it, one bounded page read
 * at a time (D D3): every page for the systems order, which keeps of a page
 * only its title and its systems table, and whole only the pages that name
 * one of the systems intake polls.
 *
 * @param agentId - The employee.
 * @param systems - The display names of the systems this poll reads.
 */
export async function readIntakeDocumentation(
  ctx: Pick<ActionCtx, 'runQuery'>,
  agentId: Id<'agents'>,
  systems: readonly string[],
): Promise<IntakeDocumentation> {
  const sources: Doc<'docSources'>[] = await ctx.runQuery(
    internal.docSources.sourcesForAgentInternal,
    { agentId },
  );
  const entries: WaterfallPage[] = [];
  const pages: Doc<'docPages'>[] = [];
  await forEachStoredPage(ctx, sources, (page): void => {
    entries.push(waterfallEntry({ title: page.title, content: page.markdown }));
    const text = `${page.title}\n${page.markdown}`;
    if (systems.some((system): boolean => namesSystem(text, system))) pages.push(page);
  });
  return { order: extractDocumentedSystemOrder(entries), pages };
}

/** Create the Convex runtime boundary used by the scheduled action; exported for its test. */
export function convexRuntime(ctx: ActionCtx): IntakeRuntime {
  return {
    readSweep: async (): Promise<SweepRead> =>
      await ctx.runQuery(internal.intakeSeed.surfacesForSweep, {}),
    listChatSurfaces: async (): Promise<Doc<'surfaces'>[]> =>
      await ctx.runQuery(internal.orientationData.chatSurfacesForIntake, {}),
    getAgent: async (agentId: Id<'agents'>): Promise<Doc<'agents'> | null> =>
      await ctx.runQuery(internal.agents.getInternal, { agentId }),
    intakeDocumentation: async (
      agentId: Id<'agents'>,
      systems: readonly string[],
    ): Promise<IntakeDocumentation> => await readIntakeDocumentation(ctx, agentId, systems),
    waitingWork: async (agentId: Id<'agents'>): Promise<{ waiting: number; limit: number }> =>
      await ctx.runQuery(internal.workLoop.waitingWork, { agentId }),
    seededItems: async (
      agentId: Id<'agents'>,
      sourceSystem: string,
      externalIds: readonly string[],
    ): Promise<string[]> =>
      externalIds.length === 0
        ? []
        : await ctx.runQuery(internal.workLoop.seededItems, {
            agentId,
            sourceSystem,
            externalIds: [...externalIds],
          }),
    grantedScopes: async (agentId: Id<'agents'>): Promise<string[]> =>
      (await ctx.runQuery(internal.agents.grantedScopes, { agentId })).map(
        (grant: Doc<'permissionGrants'>): string => grant.scope,
      ),
    // The runtime's one read (`readSurfaceBearer`, join 5): the shared Linear token from its
    // issuer, every other credential from the token store, refreshed first when due.
    decrypt: async (credentialId: CredentialId): Promise<string> =>
      await readSurfaceBearer(ctx, credentialId),
    recordIntake: async (record: IntakeRecord): Promise<void> => {
      await ctx.runMutation(internal.surfaces.recordIntake, record);
    },
    recordDecisionPoll: async (record): Promise<void> => {
      await ctx.runMutation(internal.work.recordDecisionPoll, record);
    },
    seed: async (candidate: IntakeSeed, startedUnder: string | null): Promise<void> => {
      await ctx.runMutation(internal.intakeSeed.seedListedItem, { ...candidate, startedUnder });
    },
    withdraw: async (candidate: IntakeSeed & { leftQueue: string }): Promise<void> => {
      await ctx.runMutation(internal.work.withdrawListedItem, candidate);
    },
    resolveDecision: async (reply: IntakeDecisionReply): Promise<void> => {
      await ctx.runMutation(internal.work.resolveChannelDecision, reply);
    },
    openDecisions: async (surfaceId: Id<'surfaces'>): Promise<OpenDecisions> =>
      await ctx.runQuery(internal.work.openDecisions, { surfaceId }),
    closeDecisionThread: async (record): Promise<void> => {
      await ctx.runMutation(internal.work.closeDecisionThread, record);
    },
    noticeUnreadableReply: async (record): Promise<void> => {
      await ctx.runMutation(internal.work.noticeUnreadableReply, record);
    },
    recordBotIdentity: async (record): Promise<void> => {
      await ctx.runMutation(internal.intakeIdentity.recordBotIdentity, record);
    },
  };
}

/** Poll all connected real surfaces in evidence-derived waterfall order. */
export const pollAll = internalAction({
  args: {},
  handler: async (ctx): Promise<IntakeSweepResult> =>
    await runIntakeSweep(convexRuntime(ctx), { mode: SURFACE_MODE }),
});

/**
 * Poll one surface as soon as it connects, so the work it already holds does
 * not wait for the next scheduled sweep. The cron remains the steady state.
 */
export const pollSurface = internalAction({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<IntakeSweepResult> =>
    await runIntakeSweep(convexRuntime(ctx), { mode: SURFACE_MODE, surfaceId: args.surfaceId }),
});

/** Poll manager decisions on the latency-sensitive schedule. */
export const pollDecisions = internalAction({
  args: {},
  handler: async (ctx): Promise<DecisionSweepResult> =>
    await runDecisionSweep(convexRuntime(ctx), { mode: SURFACE_MODE }),
});

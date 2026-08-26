import type { MockAction } from '../work/types';
import type { AppliedAction, CredentialKind, SurfaceRecord } from './types';
import { verdictFor } from './verdict';

/**
 * The rules the registry applies to a surface action before an adapter runs.
 *
 * Everything here is pure so the dashboard can show the manager exactly what
 * the server will decide: which actions are malformed, which will be held,
 * and how each will be described on the card. The reasons are constants
 * because the ledger, the tests and the UI all match on them.
 */

export const ACTION_JSON_LIMIT_BYTES = 16 * 1024;

export const MALFORMED_ACTION = 'malformed action';
export const NO_GRANT = 'no grant';
export const UNKNOWN_SURFACE = 'unknown surface';
export const SURFACE_NOT_CONNECTED = 'surface not connected';
export const TOOL_NOT_ALLOWED = 'tool not in the surface allowlist';
export const HELD_PUBLIC_POST = 'public post held for the manager';
export const HELD_NOT_APPROVED = 'not approved by the manager';
export const STATUS_WITHOUT_COMMENT = 'status change without audit comment';
export const TRAILER_REFUSED = 'skill-supplied provenance trailer refused';
export const USERNAME_REFUSED = 'skill-supplied username refused';
export const MOCK_VERB_REFUSED = 'mock verb refused in real mode';

/** Emoji every message through a shared chat credential carries as its avatar. */
export const SHARED_IDENTITY_ICON = ':briefcase:';

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const READ_TOOL_PREFIX = /^(?:list|get|search|read|fetch|retrieve|query|find|describe|show)(?:[_-]|$)/i;
const STATUS_TOOL = /^(?:save|update|set|change|transition|move)[_-]|status|state/i;
const STATUS_KEYS = ['status', 'state', 'stateId', 'state_id', 'statusId', 'status_id', 'workflowState'];
const COMMENT_TOOL = /comment|message|post|reply|note/i;
const CHANNEL_KEYS = ['channel', 'channel_id', 'channelId', 'conversation', 'conversationId'];
const ISSUE_KEYS = ['issueId', 'issue_id', 'id', 'issue', 'ticketId', 'ticket'];
const TRAILER_MARK = /--\s[^\n]*\(Day0\)\s·\srun\s/;

export type JsonObject = Record<string, unknown>;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export type ActionIntent = 'read' | 'write';

export interface ParsedMcpCall {
  kind: 'mcp.call';
  surface: string;
  tool: string;
  toolArgs: JsonObject;
}

export interface ParsedHttpRequest {
  kind: 'http.request';
  surface: string;
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  body?: string;
  /** The body as an object when it is a JSON object; mutated by provenance rules. */
  bodyJson?: JsonObject;
}

export type ParsedSurfaceAction = ParsedMcpCall | ParsedHttpRequest;

export type ParseResult =
  | { ok: true; action: ParsedSurfaceAction }
  | { ok: false; reason: string };

/**
 * Whether a verb targets a discovered real surface rather than the mock.
 *
 * Args:
 *   tool: Action verb.
 *
 * Returns:
 *   True for `mcp.call` and `http.request`.
 */
export function isSurfaceTool(tool: string): tool is 'mcp.call' | 'http.request' {
  return tool === 'mcp.call' || tool === 'http.request';
}

type Malformed = { ok: false; reason: string };

function malformed(detail: string): Malformed {
  return { ok: false, reason: `${MALFORMED_ACTION} (${detail})` };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse one JSON-string argument under the size cap.
 *
 * Args:
 *   raw: The JSON text, or undefined for an omitted optional argument.
 *   name: Argument name for the failure detail.
 *
 * Returns:
 *   The parsed object, or a malformed-action result.
 */
function parseJsonObject(
  raw: string | undefined,
  name: string,
): { ok: true; value: JsonObject } | Malformed {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: {} };
  if (byteLength(raw) > ACTION_JSON_LIMIT_BYTES) {
    return malformed(`${name} exceeds ${ACTION_JSON_LIMIT_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed(`${name} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) return malformed(`${name} is not a JSON object`);
  return { ok: true, value: parsed };
}

/**
 * Turn a parsed action back into the flat shape adapters receive.
 *
 * Args:
 *   parsed: A parsed surface action, possibly changed by the provenance rules.
 *
 * Returns:
 *   The equivalent flat action.
 */
export function serialiseSurfaceAction(parsed: ParsedSurfaceAction): MockAction {
  if (parsed.kind === 'mcp.call') {
    return {
      tool: 'mcp.call',
      args: { surface: parsed.surface, tool: parsed.tool, toolArgsJson: JSON.stringify(parsed.toolArgs) },
    };
  }
  return {
    tool: 'http.request',
    args: {
      surface: parsed.surface,
      method: parsed.method,
      path: parsed.path,
      headersJson: JSON.stringify(parsed.headers),
      body: parsed.bodyJson ? JSON.stringify(parsed.bodyJson) : parsed.body,
    },
  };
}

/**
 * Parse and validate the flat arguments of a surface action.
 *
 * Args:
 *   action: The action as the skill emitted it.
 *
 * Returns:
 *   The typed action, or `ok: false` with a reason starting `malformed action`.
 */
export function parseSurfaceAction(action: MockAction): ParseResult {
  const args = action.args ?? {};
  const surface = typeof args.surface === 'string' ? args.surface.trim() : '';
  if (!surface) return malformed('missing surface');
  if (action.tool === 'mcp.call') {
    const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!tool) return malformed('missing tool');
    const toolArgs = parseJsonObject(args.toolArgsJson, 'toolArgsJson');
    if (!toolArgs.ok) return toolArgs;
    return { ok: true, action: { kind: 'mcp.call', surface, tool, toolArgs: toolArgs.value } };
  }
  if (action.tool === 'http.request') {
    const method = (args.method ?? 'GET').trim().toUpperCase();
    if (!HTTP_METHODS.includes(method as HttpMethod)) return malformed(`unsupported method ${method}`);
    const path = typeof args.path === 'string' ? args.path.trim() : '';
    if (!path) return malformed('missing path');
    const headersParsed = parseJsonObject(args.headersJson, 'headersJson');
    if (!headersParsed.ok) return headersParsed;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(headersParsed.value)) {
      if (typeof value !== 'string') return malformed(`header ${key} is not a string`);
      headers[key] = value;
    }
    const body = typeof args.body === 'string' ? args.body : undefined;
    if (body !== undefined && byteLength(body) > ACTION_JSON_LIMIT_BYTES) {
      return malformed(`body exceeds ${ACTION_JSON_LIMIT_BYTES} bytes`);
    }
    let bodyJson: JsonObject | undefined;
    if (body !== undefined && body.trim().startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (isPlainObject(parsed)) bodyJson = parsed;
      } catch {
        return malformed('body is not valid JSON');
      }
    }
    return {
      ok: true,
      action: { kind: 'http.request', surface, method: method as HttpMethod, path, headers, body, bodyJson },
    };
  }
  return malformed(`unknown surface verb ${action.tool}`);
}

/**
 * Whether an action reads from or writes to its surface.
 *
 * Unknown MCP tool names count as writes, so an unrecognised tool needs the
 * stronger grant rather than slipping through as a read.
 *
 * Args:
 *   parsed: A parsed surface action.
 *
 * Returns:
 *   The intent.
 */
export function actionIntent(parsed: ParsedSurfaceAction): ActionIntent {
  if (parsed.kind === 'http.request') {
    return parsed.method === 'GET' || parsed.method === 'HEAD' ? 'read' : 'write';
  }
  return READ_TOOL_PREFIX.test(parsed.tool) ? 'read' : 'write';
}

/**
 * The permission scope an action needs.
 *
 * Args:
 *   parsed: A parsed surface action.
 *
 * Returns:
 *   `<surface>:read` or `<surface>:write`.
 */
export function requiredScope(parsed: ParsedSurfaceAction): string {
  return `${parsed.surface}:${actionIntent(parsed)}`;
}

function firstString(record: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * The chat channel or conversation an action posts to, when it names one.
 *
 * Args:
 *   parsed: A parsed surface action.
 *
 * Returns:
 *   The channel id, or undefined.
 */
export function targetChannel(parsed: ParsedSurfaceAction): string | undefined {
  const record = parsed.kind === 'mcp.call' ? parsed.toolArgs : parsed.bodyJson;
  return record ? firstString(record, CHANNEL_KEYS) : undefined;
}

/**
 * Why an action is held for the manager instead of executed, if it is.
 *
 * In real mode a chat write to anything but the manager DM, and any write to
 * a social surface, is a public post: it is recorded as held and never sent.
 *
 * Args:
 *   parsed: A parsed surface action.
 *   surface: The surface it targets.
 *
 * Returns:
 *   The held reason, or undefined when the action may execute.
 */
export function heldReason(parsed: ParsedSurfaceAction, surface: SurfaceRecord): string | undefined {
  if (actionIntent(parsed) === 'read') return undefined;
  if (surface.class === 'social') return HELD_PUBLIC_POST;
  if (surface.class === 'chat') {
    const channel = targetChannel(parsed);
    if (!surface.managerDmChannelId || channel !== surface.managerDmChannelId) {
      return HELD_PUBLIC_POST;
    }
  }
  return undefined;
}

/**
 * Whether an action as emitted would be held on its surface.
 *
 * Args:
 *   action: The action as the skill emitted it.
 *   surfaces: The agent's surfaces.
 *
 * Returns:
 *   True when the parsed action targets a known surface and would be held.
 */
export function heldEligible(action: MockAction, surfaces: readonly SurfaceRecord[]): boolean {
  if (!isSurfaceTool(action.tool)) return false;
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok) return false;
  const surface = surfaces.find((row) => row.slug === parsed.action.surface);
  return surface !== undefined && heldReason(parsed.action, surface) !== undefined;
}

/**
 * The trailer every write through a shared credential ends with.
 *
 * Args:
 *   agentName: The employee's display name.
 *   workItemId: The work item the run belongs to.
 *   runId: The run.
 *
 * Returns:
 *   `-- <name> (Day0) · run <workItemId>/<runId>`.
 */
export function provenanceTrailer(agentName: string, workItemId: string, runId: string): string {
  return `-- ${agentName} (Day0) · run ${workItemId}/${runId}`;
}

/**
 * Whether text already carries a provenance trailer.
 *
 * Args:
 *   text: Comment or message body.
 *
 * Returns:
 *   True when a trailer-shaped line is present.
 */
export function containsProvenanceTrailer(text: string): boolean {
  return TRAILER_MARK.test(text);
}

/**
 * Whether an MCP tool writes a comment or message.
 *
 * Args:
 *   parsed: A parsed MCP call.
 *
 * Returns:
 *   True for a comment-like write tool carrying a body.
 */
export function isAuditComment(parsed: ParsedSurfaceAction): boolean {
  if (parsed.kind !== 'mcp.call') return false;
  if (actionIntent(parsed) !== 'write') return false;
  return COMMENT_TOOL.test(parsed.tool) && typeof parsed.toolArgs.body === 'string';
}

/**
 * Whether an MCP tool changes a ticket's status.
 *
 * Args:
 *   parsed: A parsed MCP call.
 *
 * Returns:
 *   True for a write tool whose arguments carry a status field.
 */
export function isStatusChange(parsed: ParsedSurfaceAction): boolean {
  if (parsed.kind !== 'mcp.call') return false;
  if (actionIntent(parsed) !== 'write') return false;
  if (isAuditComment(parsed)) return false;
  if (!STATUS_TOOL.test(parsed.tool)) return false;
  return STATUS_KEYS.some((key) => parsed.toolArgs[key] !== undefined);
}

/**
 * The ticket an MCP call addresses, when its arguments name one.
 *
 * Args:
 *   parsed: A parsed MCP call.
 *
 * Returns:
 *   The issue identifier, or undefined.
 */
export function targetIssue(parsed: ParsedSurfaceAction): string | undefined {
  return parsed.kind === 'mcp.call' ? firstString(parsed.toolArgs, ISSUE_KEYS) : undefined;
}

/**
 * Whether a status change lacks a landed audit comment earlier in the run.
 *
 * The runbook rule is that a status change is never the only trace of who
 * acted. It is enforced against the ledger, not the plan: a comment the
 * manager did not approve, or one the provider refused, does not count.
 *
 * Args:
 *   parsed: The status-change action.
 *   index: Its position in the run.
 *   earlier: Parsed actions before it, by index, undefined where unparsed.
 *   ledger: Ledger rows for the actions before it, by index.
 *
 * Returns:
 *   True when the status change must fail.
 */
export function statusChangeWithoutComment(
  parsed: ParsedSurfaceAction,
  index: number,
  earlier: ReadonlyArray<ParsedSurfaceAction | undefined>,
  ledger: ReadonlyArray<AppliedAction | undefined>,
): boolean {
  if (!isStatusChange(parsed)) return false;
  const issue = targetIssue(parsed);
  for (let position = 0; position < index; position += 1) {
    const candidate = earlier[position];
    const row = ledger[position];
    if (!candidate || !row || !row.ok || row.held) continue;
    if (candidate.surface !== parsed.surface || !isAuditComment(candidate)) continue;
    const commentIssue = targetIssue(candidate);
    if (issue !== undefined && commentIssue !== undefined && issue !== commentIssue) continue;
    return false;
  }
  return true;
}

export interface ProvenanceRun {
  agentName: string;
  workItemId: string;
  runId: string;
}

export type ProvenanceResult =
  | { ok: true; action: ParsedSurfaceAction }
  | { ok: false; reason: string };

/**
 * Whether an HTTP request posts a chat message.
 *
 * Args:
 *   parsed: A parsed HTTP request.
 *   surface: Its surface.
 *
 * Returns:
 *   True for a write to a chat surface that carries message text.
 */
function isChatPost(parsed: ParsedHttpRequest, surface: SurfaceRecord): boolean {
  if (actionIntent(parsed) !== 'write') return false;
  if (/chat\.postMessage$/.test(parsed.path)) return true;
  return surface.class === 'chat' && typeof parsed.bodyJson?.text === 'string';
}

/**
 * Apply the provenance rules to one action.
 *
 * A comment or message written through a shared credential ends with the
 * trailer naming the employee and the run; a message through a shared chat
 * credential also carries the employee's name and icon so it stays
 * attributable. Both are added by the server, never by the skill: a
 * skill-supplied trailer or `username` is refused rather than merged, because
 * either could name another employee. A dedicated `oauth` app posts as itself,
 * so nothing is added for it.
 *
 * Args:
 *   parsed: A parsed surface action.
 *   surface: Its surface.
 *   run: Names for the trailer.
 *   credentialKind: How the surface's credential was landed.
 *
 * Returns:
 *   The action with provenance applied, or a refusal.
 */
export function applyProvenance(
  parsed: ParsedSurfaceAction,
  surface: SurfaceRecord,
  run: ProvenanceRun,
  credentialKind: CredentialKind,
): ProvenanceResult {
  const shared = credentialKind !== 'oauth';
  const trailer = provenanceTrailer(run.agentName, run.workItemId, run.runId);
  if (parsed.kind === 'mcp.call') {
    if (!isAuditComment(parsed)) return { ok: true, action: parsed };
    const body = parsed.toolArgs.body as string;
    if (containsProvenanceTrailer(body)) return { ok: false, reason: TRAILER_REFUSED };
    if (!shared) return { ok: true, action: parsed };
    return {
      ok: true,
      action: { ...parsed, toolArgs: { ...parsed.toolArgs, body: `${body}\n\n${trailer}` } },
    };
  }
  if (parsed.body !== undefined && containsProvenanceTrailer(parsed.body)) {
    return { ok: false, reason: TRAILER_REFUSED };
  }
  if (!isChatPost(parsed, surface)) return { ok: true, action: parsed };
  const bodyJson = parsed.bodyJson;
  if (!bodyJson) return { ok: true, action: parsed };
  if (
    bodyJson.username !== undefined ||
    bodyJson.icon_emoji !== undefined ||
    bodyJson.icon_url !== undefined
  ) {
    return { ok: false, reason: USERNAME_REFUSED };
  }
  if (!shared) return { ok: true, action: parsed };
  const text = typeof bodyJson.text === 'string' ? bodyJson.text : '';
  const next: JsonObject = {
    ...bodyJson,
    text: `${text}\n\n${trailer}`,
    username: `${run.agentName} (Day0)`,
    icon_emoji: SHARED_IDENTITY_ICON,
  };
  return { ok: true, action: { ...parsed, bodyJson: next, body: JSON.stringify(next) } };
}

/**
 * Whether an action's surface may be written to right now.
 *
 * Args:
 *   surface: The surface, or undefined when the slug is unknown.
 *   now: Clock for the liveness verdict.
 *
 * Returns:
 *   A refusal reason, or undefined when the surface is connected.
 */
export function surfaceRefusal(surface: SurfaceRecord | undefined, now: number): string | undefined {
  if (!surface) return UNKNOWN_SURFACE;
  const verdict = verdictFor(surface, now);
  if (verdict !== 'connected') return `${SURFACE_NOT_CONNECTED} (${verdict})`;
  return undefined;
}

/**
 * Why a skill that targets a surface may not be approved yet, if it may not.
 *
 * Shared by `skills.approve` and the proposed-skills panel so the button's
 * grey-out reason is the sentence the mutation would throw.
 *
 * Args:
 *   targetSurface: The slug the skill acts on, or undefined for a mock skill.
 *   surface: The matching surface row, or undefined when none exists.
 *   now: Clock for the liveness verdict.
 *
 * Returns:
 *   The refusal, or undefined when approval may proceed.
 */
export function skillApprovalRefusal(
  targetSurface: string | undefined,
  surface: SurfaceRecord | undefined,
  now: number,
): string | undefined {
  if (!targetSurface) return undefined;
  if (!surface) return `surface ${targetSurface} is not listed for this agent`;
  const verdict = verdictFor(surface, now);
  if (verdict === 'connected') return undefined;
  return `surface ${targetSurface} is ${verdict}; connect it on the Surfaces tab before approving this skill`;
}

/**
 * Render a value the way the card shows it: short, one line, quoted strings.
 *
 * Args:
 *   value: Any JSON value.
 *   max: Maximum length of a rendered string.
 *
 * Returns:
 *   A compact rendering.
 */
function compact(value: unknown, max = 80): string {
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim();
    return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
  }
  if (Array.isArray(value)) return `[${value.map((item) => compact(item, max)).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${key}: ${compact(item, max)}`)
      .join(', ')}}`;
  }
  return String(value);
}

/** The argument names each verb reads; everything else in the flat bag is another verb's default. */
const VERB_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  'mcp.call': ['surface', 'tool', 'toolArgsJson'],
  'http.request': ['surface', 'method', 'path', 'headersJson', 'body'],
  'spreadsheet.appendRow': ['sheetSlug', 'tabName', 'cells'],
  'slack.postMessage': ['channelSlug', 'threadKey', 'body'],
  'twitter.reply': ['tweetSlug', 'body'],
  'ticket.update': ['slug', 'status', 'comment'],
};

/**
 * The action as the manager should read it on the approval card.
 *
 * The executor emits every action through one flat argument bag, so a
 * surface call arrives with a dozen empty mock-verb fields and their
 * defaults. Only the arguments the verb reads are shown, and among those
 * only the ones that carry a value; the JSON strings the server parses
 * (`toolArgsJson`, `headersJson`, `body`) are shown exactly as emitted, so
 * nothing the server will act on is hidden or reshaped.
 *
 * Args:
 *   action: The action as the skill emitted it.
 *
 * Returns:
 *   The same verb with the arguments it reads, non-empty ones only.
 */
export function reviewPayload(action: MockAction): { tool: string; args: JsonObject } {
  const wanted = VERB_ARGUMENTS[action.tool];
  const bag = (action.args ?? {}) as JsonObject;
  const args: JsonObject = {};
  for (const key of wanted ?? Object.keys(bag)) {
    const value = bag[key];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    args[key] = value;
  }
  return { tool: action.tool, args };
}

/**
 * Describe an action verbatim for the manager's approval card.
 *
 * Args:
 *   action: The action as the skill emitted it.
 *
 * Returns:
 *   One line such as `mcp.call linear · save_comment · {issueId: "…", body: "…"}`.
 */
export function describeAction(action: MockAction): string {
  const args = action.args ?? {};
  if (action.tool === 'mcp.call') {
    const parsed = parseSurfaceAction(action);
    const rendered =
      parsed.ok && parsed.action.kind === 'mcp.call'
        ? compact(parsed.action.toolArgs)
        : compact(args.toolArgsJson ?? '');
    return `mcp.call ${args.surface ?? '?'} · ${args.tool ?? '?'} · ${rendered}`;
  }
  if (action.tool === 'http.request') {
    const parsed = parseSurfaceAction(action);
    const headers =
      parsed.ok && parsed.action.kind === 'http.request' ? compact(parsed.action.headers) : compact(args.headersJson ?? '');
    const body = args.body === undefined ? '(no body)' : compact(args.body, 160);
    return `http.request ${args.surface ?? '?'} · ${(args.method ?? 'GET').toUpperCase()} ${args.path ?? '?'} · headers ${headers} · body ${body}`;
  }
  const { cells, ...rest } = args;
  const shown: JsonObject = { ...rest };
  if (cells) shown.cells = cells.map((cell) => `${cell.header}=${cell.value}`);
  return `${action.tool} · ${compact(shown)}`;
}

import type { MockAction, ReplyTarget } from '../work/types';
import { MOCK_TOOLS } from './mock';
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
/** Why a browser read waits with the writes it shares a session with. */
export const HELD_BROWSER_SEQUENCE =
  'held with the rest of this browser session, which runs in one browser';

export const HELD_MUTATION = 'system-of-record mutation held for the manager';
export const HELD_WRITE = 'write held for the manager';
export const HELD_NOT_APPROVED = 'not approved by the manager';
export const AWAITING_APPROVAL = "awaiting the manager's approval";
export const NOT_AUTOMATIC = 'not an automatic action';
export const UNKNOWN_TOOL = 'unknown tool';
export const STATUS_WITHOUT_COMMENT = 'status change without audit comment';
export const TRAILER_REFUSED = 'skill-supplied provenance trailer refused';
export const USERNAME_REFUSED = 'skill-supplied username refused';
export const MOCK_VERB_REFUSED = 'mock verb refused in real mode';
export const SHARED_WRITE_WITHOUT_ATTRIBUTION =
  'shared credential write without attributable content';
export const REPLY_TARGET_REFUSED = 'chat reply does not match the work item reply target';

/** Emoji every message through a shared chat credential carries as its avatar. */
export const SHARED_IDENTITY_ICON = ':briefcase:';

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const READ_TOOL_PREFIX = /^(?:list|get|search|read|fetch|retrieve|query|find|describe|show)(?:[_-]|$)/i;
/**
 * Browser tools that observe the page without changing anything on it.
 *
 * The floor's tool names carry no read verb - opening a page is `navigate`,
 * reading it is `snapshot` - so without naming them the generic rule counts
 * both as writes, and a run that only looked at a dashboard would be held for
 * the manager as though it had edited one.
 */
const BROWSER_READ_TOOLS = new Set(['browser_navigate', 'browser_snapshot', 'browser_hover']);
const HTTP_MUTATION_WORDS = new Set([
  'activate',
  'add',
  'apply',
  'approve',
  'archive',
  'assign',
  'attach',
  'block',
  'cancel',
  'change',
  'clone',
  'close',
  'complete',
  'create',
  'deactivate',
  'delete',
  'demote',
  'deploy',
  'destroy',
  'detach',
  'disable',
  'drop',
  'duplicate',
  'edit',
  'enable',
  'escalate',
  'execute',
  'grant',
  'insert',
  'install',
  'invite',
  'join',
  'kick',
  'leave',
  'lock',
  'mark',
  'merge',
  'modify',
  'move',
  'mute',
  'open',
  'patch',
  'pin',
  'post',
  'promote',
  'provision',
  'publish',
  'purge',
  'push',
  'reassign',
  'reject',
  'remove',
  'rename',
  'replace',
  'reply',
  'reset',
  'resolve',
  'restore',
  'revert',
  'revoke',
  'rotate',
  'save',
  'schedule',
  'send',
  'set',
  'share',
  'submit',
  'subscribe',
  'suspend',
  'sync',
  'transfer',
  'transition',
  'trigger',
  'unarchive',
  'unassign',
  'uninstall',
  'unlock',
  'unpin',
  'unsubscribe',
  'update',
  'upload',
  'upsert',
  'wipe',
  'write',
]);
/**
 * Words that join a second operation onto a read verb.
 *
 * The read prefix decides the intent of a whole name, so a catalogue tool
 * called `list_and_delete_issues` was only held because `delete` happened to be
 * in the mutation vocabulary. Once the server's own catalogue is the allowlist
 * that vocabulary can never be complete - `search_and_replace`,
 * `get_or_edit_page` and `fetch_and_apply_patch` are all somebody's real tool.
 * A name that conjoins operations is therefore a write whatever its second
 * verb is, on the same principle as the unrecognised-name default: Day0 cannot
 * read the part it does not recognise, so it asks the manager.
 */
const COMPOUND_TOOL_WORDS = new Set(['and', 'or', 'then']);
const STATUS_TOOL = /^(?:save|update|set|change|transition|move)[_-]|status|state/i;
const STATUS_KEYS = ['status', 'state', 'stateId', 'state_id', 'statusId', 'status_id', 'workflowState'];
const COMMENT_TOOL = /comment|message|post|reply|note/i;
const MESSAGE_KEYS = ['text', 'body', 'message', 'content'];
const MCP_CHAT_POST_TOOLS = new Set([
  'chat.postmessage',
  'chat_postmessage',
  'chat_post_message',
  'postmessage',
  'post_message',
  'sendmessage',
  'send_message',
  'createmessage',
  'create_message',
  'slack_post_message',
]);
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

function operationTokens(value: string): string[] {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

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
 * stronger grant rather than slipping through as a read. A name that conjoins
 * operations (`list_and_delete_issues`, `search_and_replace`) is a write for
 * the same reason: the read verb in front of it describes only the first half.
 *
 * Args:
 *   parsed: A parsed surface action.
 *
 * Returns:
 *   The intent.
 */
export function actionIntent(parsed: ParsedSurfaceAction): ActionIntent {
  if (parsed.kind === 'http.request') {
    if (parsed.method !== 'GET' && parsed.method !== 'HEAD') return 'write';
    if (parsed.body !== undefined && parsed.body.trim() !== '') return 'write';
    // RPC APIs can accept mutations over GET. Treat an operation carrying an
    // explicit mutation verb as a write even when its transport method lies.
    return operationTokens(parsed.path).some((token) => HTTP_MUTATION_WORDS.has(token))
      ? 'write'
      : 'read';
  }
  if (BROWSER_READ_TOOLS.has(parsed.tool)) return 'read';
  const tokens = operationTokens(parsed.tool);
  if (tokens.some((token) => HTTP_MUTATION_WORDS.has(token))) return 'write';
  if (tokens.some((token) => COMPOUND_TOOL_WORDS.has(token))) return 'write';
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

function semanticKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isDestinationKey(key: string): boolean {
  const normalised = semanticKey(key);
  return (
    normalised.includes('channel') ||
    normalised.includes('conversation') ||
    /^(?:destination|destinationid|recipient|recipientid|to)$/.test(normalised)
  );
}

function isThreadKey(key: string): boolean {
  const normalised = semanticKey(key);
  return (
    normalised.includes('thread') ||
    normalised.includes('reply') ||
    normalised.includes('parent')
  );
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
  if (!record) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (isDestinationKey(key) && typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** Whether every destination alias supplied by an action names one exact channel. */
function targetsOnlyChannel(parsed: ParsedSurfaceAction, expected: string): boolean {
  const record = parsed.kind === 'mcp.call' ? parsed.toolArgs : parsed.bodyJson;
  if (!record) return false;
  const destinations = Object.entries(record).filter(([key]) => isDestinationKey(key));
  return (
    destinations.length > 0 &&
    destinations.every(([, value]) => typeof value === 'string' && value.trim() === expected)
  );
}

/** Whether an action asks the provider to place a message inside an existing thread. */
function hasThreadTarget(parsed: ParsedSurfaceAction): boolean {
  const record = parsed.kind === 'mcp.call' ? parsed.toolArgs : parsed.bodyJson;
  if (!record) return false;
  return Object.entries(record).some(([key, value]) => {
    return isThreadKey(key) && value !== undefined && value !== null && value !== '' && value !== false;
  });
}

/** Whether an MCP call is narrowly a new chat-message operation with content. */
function isMcpChatPost(parsed: ParsedMcpCall): boolean {
  if (!MCP_CHAT_POST_TOOLS.has(parsed.tool.toLowerCase())) return false;
  return MESSAGE_KEYS.some((key) => typeof parsed.toolArgs[key] === 'string');
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
    if (
      !surface.managerDmChannelId ||
      !targetsOnlyChannel(parsed, surface.managerDmChannelId)
    ) {
      return HELD_PUBLIC_POST;
    }
  }
  return undefined;
}

/** The scope every agent holds from deployment; on a surface it authorises the manager DM alone. */
export const BOSS_MESSAGE_SCOPE = 'boss:message';

/**
 * Whether an action is the manager DM.
 *
 * Exactly one real action qualifies: a `chat.postMessage`-class write on a
 * chat surface whose target channel is that surface's manager DM channel, as
 * the connection probe recorded it. A chat write anywhere else is a public
 * post, and a write on any other surface class is never a DM.
 *
 * Args:
 *   parsed: A parsed surface action.
 *   surface: The surface it targets.
 *
 * Returns:
 *   True for the manager DM.
 */
export function isManagerDm(parsed: ParsedSurfaceAction, surface: SurfaceRecord): boolean {
  if (surface.class !== 'chat' || !surface.managerDmChannelId) return false;
  if (actionIntent(parsed) !== 'write') return false;
  if (hasThreadTarget(parsed)) return false;
  const posts = parsed.kind === 'http.request' ? isChatPost(parsed, surface) : isMcpChatPost(parsed);
  return posts && targetsOnlyChannel(parsed, surface.managerDmChannelId);
}

/** Why a public chat reply escapes the source channel or thread, if it does. */
export function replyTargetRefusal(
  parsed: ParsedSurfaceAction,
  surface: SurfaceRecord,
  target: ReplyTarget | undefined,
): string | undefined {
  if (!target || surface.class !== 'chat' || isManagerDm(parsed, surface)) return undefined;
  const isReply = parsed.kind === 'http.request' ? isChatPost(parsed, surface) : isMcpChatPost(parsed);
  if (!isReply) return undefined;
  const record = parsed.kind === 'mcp.call' ? parsed.toolArgs : parsed.bodyJson;
  if (!record || !targetsOnlyChannel(parsed, target.channel)) return REPLY_TARGET_REFUSED;
  const broadcast = Object.entries(record).find(
    ([key]) => semanticKey(key) === 'replybroadcast',
  )?.[1];
  if (broadcast !== undefined && broadcast !== null && broadcast !== false && broadcast !== '') {
    return REPLY_TARGET_REFUSED;
  }
  const threadTargets = Object.entries(record).filter(
    ([key]) => isThreadKey(key) && semanticKey(key) !== 'replybroadcast',
  );
  return threadTargets.length > 0 &&
    threadTargets.every(([, value]) =>
      typeof value === 'string' && value.trim() === target.threadTs,
    )
    ? undefined
    : REPLY_TARGET_REFUSED;
}

/**
 * The scopes any one of which authorises an action.
 *
 * The manager DM is what `boss:message` means on a real chat surface, so the
 * DM is granted by either `boss:message` or the surface's own write scope;
 * every other action needs exactly `requiredScope`. The first entry is the
 * scope a refusal names.
 *
 * Args:
 *   parsed: A parsed surface action.
 *   surface: The surface it targets.
 *
 * Returns:
 *   The granting scopes, most specific first.
 */
export function grantingScopes(parsed: ParsedSurfaceAction, surface: SurfaceRecord): string[] {
  const scope = requiredScope(parsed);
  return isManagerDm(parsed, surface) ? [BOSS_MESSAGE_SCOPE, scope] : [scope];
}

/**
 * Why an action has no standing authority, if it has none.
 *
 * A read and the manager DM need their own scope whatever else is true.
 * Any other write is authorised by `<surface>:write`, or, when autonomous
 * actions are on, by the toggle itself: it is the manager's standing
 * authority for writes on connected surfaces within their probed allowlist,
 * so a write with no scope of its own applies under it.
 *
 * Args:
 *   parsed: A parsed surface action.
 *   surface: The surface it targets.
 *   grants: The agent's live permission scopes.
 *   autonomousActions: Whether the agent's autonomous-actions toggle is on.
 *
 * Returns:
 *   `no grant (<scope>)`, or undefined when the action is authorised.
 */
export function grantRefusal(
  parsed: ParsedSurfaceAction,
  surface: SurfaceRecord,
  grants: ReadonlySet<string>,
  autonomousActions = false,
): string | undefined {
  if (autonomousActions && !needsStandingGrant(parsed, surface)) return undefined;
  const scopes = grantingScopes(parsed, surface);
  if (scopes.some((scope) => grants.has(scope))) return undefined;
  return `${NO_GRANT} (${scopes[0]})`;
}

/**
 * The refusal for a legacy mock verb emitted in real mode.
 *
 * Args:
 *   tool: The verb.
 *
 * Returns:
 *   The reason the ledger records.
 */
export function mockVerbRefusal(tool: string): string {
  return `${MOCK_VERB_REFUSED} (${tool} writes to the mock tables; target a connected surface with mcp.call or http.request)`;
}

/**
 * Why a surface verb may not run on the surface's connection path, if it may not.
 *
 * Args:
 *   parsed: A parsed surface action.
 *   surface: The surface it targets.
 *
 * Returns:
 *   A refusal reason, or undefined when the verb matches the path.
 */
export function pathRefusal(parsed: ParsedSurfaceAction, surface: SurfaceRecord): string | undefined {
  const mismatch =
    parsed.kind === 'mcp.call'
      ? surface.path !== 'mcp' && surface.path !== 'browser-driven'
      : surface.path !== 'documented-api';
  if (!mismatch) return undefined;
  return `${parsed.kind} is not allowed on surface path ${surface.path ?? 'unknown'}`;
}

/**
 * Resolve a documented HTTP operation without allowing the path to leave its endpoint.
 *
 * This lives with the pure gate policy so hold-time review and the HTTP adapter
 * derive the same allowlist name from the same safe URL.
 */
export function resolveRequestUrl(endpoint: string, path: string): URL {
  const base = new URL(endpoint);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('surface endpoint must be an HTTP URL without userinfo');
  }
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  const rawPath = path.trim();
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(rawPath)) {
    throw new Error('path escapes the surface endpoint');
  }
  let decodedPath = rawPath;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const decoded = decodeURIComponent(decodedPath);
      if (decoded === decodedPath) break;
      decodedPath = decoded;
    } catch {
      throw new Error('path has invalid percent encoding');
    }
  }
  if (
    decodedPath.includes('\\') ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(decodedPath.split(/[?#]/, 1)[0])
  ) {
    throw new Error('path escapes the surface endpoint');
  }
  const target = new URL(rawPath.replace(/^\/+/, ''), base);
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    !target.pathname.startsWith(base.pathname)
  ) {
    throw new Error('path escapes the surface endpoint');
  }
  return target;
}

/**
 * Why a surface's stored MCP endpoint may not carry a credential, if it may not.
 *
 * The probe validates the endpoint before it builds a bearer client, and only a
 * validated route ever becomes `connected`. Transport re-derives the rule
 * rather than inheriting that history, so a row written by any other path
 * cannot put the surface's credential on a plaintext or userinfo-bearing URL.
 * The public-address rule stays with the probe, which is the only place that
 * can resolve a name.
 *
 * Args:
 *   surface: The surface the action targets.
 *
 * Returns:
 *   A refusal reason, or undefined when the endpoint may carry the credential.
 */
export function mcpEndpointRefusal(surface: SurfaceRecord): string | undefined {
  // The browser floor's transport is Day0's own driver, not this address; the
  // endpoint is the page the driver is bounded to and `navigationRefusal` owns it.
  if (surface.path !== 'mcp') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(surface.endpoint ?? '');
  } catch {
    return 'surface has no valid endpoint';
  }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password
    ? undefined
    : 'surface endpoint must be an HTTPS URL without userinfo';
}

/** Why an operation is outside the surface's probed allowlist, if it is. */
export function toolRefusal(
  parsed: ParsedSurfaceAction,
  surface: SurfaceRecord,
): string | undefined {
  let operation = parsed.kind === 'mcp.call' ? parsed.tool : '';
  if (parsed.kind === 'http.request') {
    let target: URL;
    try {
      target = resolveRequestUrl(surface.endpoint ?? '', parsed.path);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    const base = new URL(surface.endpoint ?? '');
    if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
    operation = target.pathname.slice(base.pathname.length).replace(/^\/+/, '');
  }
  return surface.toolAllowlist?.includes(operation)
    ? undefined
    : `${TOOL_NOT_ALLOWED} (${operation})`;
}

/** How the gate will treat one row of a run. */
export type ActionDisposition = 'auto' | 'held' | 'refused';

/**
 * What the gate decided about one action when the run was held.
 *
 * `auto` applies without a human step, `held` waits for the manager to
 * approve the literal payload, `refused` can never be applied and says why.
 */
export type ActionVerdict =
  | { disposition: 'auto' }
  | { disposition: 'held'; reason: string }
  | { disposition: 'refused'; reason: string };

/**
 * Read a persisted verdict, including the shape written before dispositions.
 *
 * Rows held before the ladder carried `{ held: boolean }`: `held: true` meant
 * the gate would not apply the row at all, which is `refused` now, and
 * `held: false` meant the manager approves it, which is `held`.
 *
 * Args:
 *   row: The persisted verdict.
 *
 * Returns:
 *   The verdict in the current shape.
 */
export function normaliseActionVerdict(row: {
  held?: boolean;
  disposition?: string;
  reason?: string;
}): ActionVerdict {
  if (row.disposition === 'auto') return { disposition: 'auto' };
  if (row.disposition === 'held') return { disposition: 'held', reason: row.reason ?? HELD_WRITE };
  if (row.disposition === 'refused') return { disposition: 'refused', reason: row.reason ?? 'refused' };
  if (row.held === true) return { disposition: 'refused', reason: row.reason ?? 'refused' };
  return { disposition: 'held', reason: row.reason ?? HELD_WRITE };
}

/** What kind of change an applicable action makes, which decides its disposition and its held reason. */
export type ActionClass = 'read' | 'manager-dm' | 'public-post' | 'mutation' | 'write';

/**
 * Classify an applicable action by what it changes.
 *
 * Args:
 *   parsed: A parsed surface action.
 *   surface: The surface it targets.
 *
 * Returns:
 *   The class.
 */
export function actionClass(parsed: ParsedSurfaceAction, surface: SurfaceRecord): ActionClass {
  if (actionIntent(parsed) === 'read') return 'read';
  if (isManagerDm(parsed, surface)) return 'manager-dm';
  if (heldReason(parsed, surface)) return 'public-post';
  if (parsed.kind === 'mcp.call') return 'mutation';
  return 'write';
}

/**
 * Whether an action needs a standing grant to be applied at all.
 *
 * A read and the manager DM apply without the manager, so they need the
 * scope that authorises them (`<surface>:read`, `boss:message`) and are
 * refused without it. Every other write is authorised either by the manager
 * (their approval of the literal payload, or the autonomous-actions toggle)
 * or by a standing `<surface>:write`; a missing write grant therefore keeps a
 * write out of the auto phase while the toggle is off rather than out of the
 * run.
 *
 * Args:
 *   parsed: A parsed surface action.
 *   surface: The surface it targets.
 *
 * Returns:
 *   True for a read or the manager DM.
 */
export function needsStandingGrant(parsed: ParsedSurfaceAction, surface: SurfaceRecord): boolean {
  return actionIntent(parsed) === 'read' || isManagerDm(parsed, surface);
}

/**
 * Why an action can never be applied, if it cannot.
 *
 * Every registry check that depends on nothing that happens during apply:
 * the verb, its shape, the surface's connection, the verb-to-path match,
 * the probed allowlist, the standing grant of a read or the manager DM, and
 * the provenance fields.
 *
 * Args:
 *   action: The action as the skill emitted it.
 *   surfaces: The agent's surfaces.
 *   grants: The agent's live permission scopes.
 *   now: Clock for the liveness verdict.
 *
 * Returns:
 *   The refusal, or the parsed action and its surface when it may be applied.
 */
export function refusalFor(
  action: MockAction,
  surfaces: readonly SurfaceRecord[],
  grants: ReadonlySet<string>,
  now: number,
): { refused: true; reason: string } | { refused: false; parsed: ParsedSurfaceAction; surface: SurfaceRecord } {
  if (!isSurfaceTool(action.tool)) {
    const mock = (MOCK_TOOLS as readonly string[]).includes(action.tool);
    return { refused: true, reason: mock ? mockVerbRefusal(action.tool) : UNKNOWN_TOOL };
  }
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok) return { refused: true, reason: parsed.reason };
  const surface = surfaces.find((row) => row.slug === parsed.action.surface);
  const refusal = surfaceRefusal(surface, now);
  if (!surface || refusal) return { refused: true, reason: refusal ?? UNKNOWN_SURFACE };
  const reason =
    pathRefusal(parsed.action, surface) ??
    toolRefusal(parsed.action, surface) ??
    (needsStandingGrant(parsed.action, surface)
      ? grantRefusal(parsed.action, surface, grants)
      : undefined) ??
    provenanceRefusal(parsed.action, surface);
  if (reason) return { refused: true, reason };
  return { refused: false, parsed: parsed.action, surface };
}

/** What the hold transaction reads about the agent before deciding a run. */
export interface ReviewScope {
  /** Whether the agent's autonomous-actions toggle is on. */
  autonomousActions: boolean;
  /** Exact source channel and thread for event-stream replies. */
  replyTarget?: ReplyTarget;
}

/**
 * Decide at hold time what the gate will do with one action.
 *
 * Refusals come first and are the same whether the toggle is on or off.
 * With autonomous actions off, an applicable row is `auto` when it is a
 * read or the manager DM and `held` for every other write - a public post
 * or thread reply, a system-of-record mutation, a create or a delete, or any
 * other write - whatever standing grant the agent holds. With autonomous
 * actions on, every applicable row is `auto`.
 *
 * Args:
 *   action: The action as the skill emitted it.
 *   surfaces: The agent's surfaces.
 *   grants: The agent's live permission scopes.
 *   now: Clock for the liveness verdict.
 *   scope: The agent's toggle.
 *
 * Returns:
 *   The verdict.
 */
export function reviewAction(
  action: MockAction,
  surfaces: readonly SurfaceRecord[],
  grants: ReadonlySet<string>,
  now: number,
  scope: ReviewScope,
): ActionVerdict {
  const refusal = refusalFor(action, surfaces, grants, now);
  if (refusal.refused) return { disposition: 'refused', reason: refusal.reason };
  const replyRefusal = replyTargetRefusal(refusal.parsed, refusal.surface, scope.replyTarget);
  if (replyRefusal) return { disposition: 'refused', reason: replyRefusal };
  if (scope.autonomousActions) return { disposition: 'auto' };
  switch (actionClass(refusal.parsed, refusal.surface)) {
    case 'read':
    case 'manager-dm':
      return { disposition: 'auto' };
    case 'public-post':
      return { disposition: 'held', reason: HELD_PUBLIC_POST };
    case 'mutation':
      return { disposition: 'held', reason: HELD_MUTATION };
    default:
      return { disposition: 'held', reason: HELD_WRITE };
  }
}

/** The surface a parsed action targets, when the action parsed at all. */
function targetSurfaceSlug(action: MockAction): string | undefined {
  if (!isSurfaceTool(action.tool)) return undefined;
  const parsed = parseSurfaceAction(action);
  return parsed.ok ? parsed.action.surface : undefined;
}

/**
 * Review every action of a held run.
 *
 * A browser sequence is reviewed as one unit rather than row by row. The auto
 * phase and the approved phase are separate invocations with a human decision
 * between them, and a browser session cannot survive that gap: the reads would
 * sign in and navigate in one browser, the approved writes would look for the
 * Save button in a second browser that is still on a blank page. A person does
 * not half-do a browsing session either. So if any action on a browser-driven
 * surface is held, every action on that surface is held with it, and the whole
 * sequence runs in one browser once the manager has decided. Under the toggle
 * nothing is held and the question does not arise.
 *
 * Args:
 *   actions: The actions as the skill emitted them.
 *   surfaces: The agent's surfaces.
 *   grants: The agent's live permission scopes.
 *   now: Clock for the liveness verdict.
 *   scope: The agent's toggle.
 *
 * Returns:
 *   One verdict per action, in order.
 */
export function reviewActions(
  actions: readonly MockAction[],
  surfaces: readonly SurfaceRecord[],
  grants: ReadonlySet<string>,
  now: number,
  scope: ReviewScope,
): ActionVerdict[] {
  const verdicts = actions.map((action) => reviewAction(action, surfaces, grants, now, scope));
  const browserSlugs = new Set(
    surfaces
      .filter((surface: SurfaceRecord): boolean => surface.path === 'browser-driven')
      .map((surface: SurfaceRecord): string => surface.slug),
  );
  if (browserSlugs.size === 0) return verdicts;
  const parked = new Set<string>();
  for (const [index, verdict] of verdicts.entries()) {
    if (verdict.disposition !== 'held') continue;
    const slug = targetSurfaceSlug(actions[index]);
    if (slug && browserSlugs.has(slug)) parked.add(slug);
  }
  if (parked.size === 0) return verdicts;
  return verdicts.map((verdict, index): ActionVerdict => {
    if (verdict.disposition !== 'auto') return verdict;
    const slug = targetSurfaceSlug(actions[index]);
    if (!slug || !parked.has(slug)) return verdict;
    return { disposition: 'held', reason: HELD_BROWSER_SEQUENCE };
  });
}

/**
 * Whether an action may be applied without a human step right now.
 *
 * The auto phase's backstop: apply re-reads the surfaces, the grants and
 * the toggle and asks this of every row it is about to send, so a verdict
 * written while the toggle was on cannot send a public post or a mutation
 * after the manager has turned it off.
 *
 * Args:
 *   parsed: A parsed surface action that passed every refusal.
 *   surface: Its surface.
 *   autonomousActions: Whether the agent's toggle is on now.
 *
 * Returns:
 *   True for every row under the toggle; otherwise for a read or the manager DM.
 */
export function isAutomatic(
  parsed: ParsedSurfaceAction,
  surface: SurfaceRecord,
  autonomousActions: boolean,
): boolean {
  if (autonomousActions) return true;
  const kind = actionClass(parsed, surface);
  return kind === 'read' || kind === 'manager-dm';
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
  return !hasLandedAuditComment(parsed, index, earlier, ledger);
}

/** Whether an earlier action landed an attributed audit comment on the same target. */
function hasLandedAuditComment(
  parsed: ParsedSurfaceAction,
  index: number,
  earlier: ReadonlyArray<ParsedSurfaceAction | undefined>,
  ledger: ReadonlyArray<AppliedAction | undefined>,
): boolean {
  const issue = targetIssue(parsed);
  if (issue === undefined) return false;
  for (let position = 0; position < index; position += 1) {
    const candidate = earlier[position];
    const row = ledger[position];
    if (!candidate || !row || !row.ok || row.held) continue;
    if (candidate.surface !== parsed.surface || !isAuditComment(candidate)) continue;
    const commentIssue = targetIssue(candidate);
    if (commentIssue !== issue) continue;
    return true;
  }
  return false;
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
  return (
    parsed.method === 'POST' &&
    surface.class === 'chat' &&
    /^\/*chat\.postMessage$/.test(parsed.path) &&
    typeof parsed.bodyJson?.text === 'string'
  );
}

/** A skill-supplied provenance field that the server will refuse at apply. */
export function provenanceRefusal(
  parsed: ParsedSurfaceAction,
  surface: SurfaceRecord,
): string | undefined {
  if (parsed.kind === 'mcp.call') {
    if (isMcpChatPost(parsed)) {
      const message = MESSAGE_KEYS.map((key) => parsed.toolArgs[key]).find(
        (value): value is string => typeof value === 'string',
      );
      return message && containsProvenanceTrailer(message) ? TRAILER_REFUSED : undefined;
    }
    if (!isAuditComment(parsed)) return undefined;
    return containsProvenanceTrailer(parsed.toolArgs.body as string) ? TRAILER_REFUSED : undefined;
  }
  if (parsed.body !== undefined && containsProvenanceTrailer(parsed.body)) {
    return TRAILER_REFUSED;
  }
  if (!isChatPost(parsed, surface) || !parsed.bodyJson) return undefined;
  return parsed.bodyJson.username !== undefined ||
    parsed.bodyJson.icon_emoji !== undefined ||
    parsed.bodyJson.icon_url !== undefined
    ? USERNAME_REFUSED
    : undefined;
}

/**
 * Whether a shared-credential write lacks content that identifies its actor and run.
 *
 * Comments and chat messages receive the server-side trailer directly. An
 * issue mutation may instead rely on a landed, trailer-bearing comment on
 * the same issue earlier in this run (the status-change rule is the common
 * case). Other writes through shared credentials are refused because the
 * provider would otherwise record an action attributable only to the shared
 * account. Dedicated OAuth apps remain attributable through their own bot.
 *
 * The browser floor is the one write with no authored content to attribute:
 * pressing Save carries no body a trailer could be appended to, and the shared
 * dashboard login is what the documentation publishes rather than an accident.
 * Attribution there is the system's own audit line, which the runbook requires
 * the agent to read back as the evidence a change landed - so the rule does not
 * apply, and refusing here would make the floor unusable rather than safer.
 */
export function sharedWriteWithoutAttribution(
  parsed: ParsedSurfaceAction,
  surface: SurfaceRecord,
  credentialKind: CredentialKind,
  index: number,
  earlier: ReadonlyArray<ParsedSurfaceAction | undefined>,
  ledger: ReadonlyArray<AppliedAction | undefined>,
): boolean {
  if (credentialKind === 'oauth' || actionIntent(parsed) === 'read') return false;
  if (surface.path === 'browser-driven') return false;
  if (isAuditComment(parsed)) return false;
  if (parsed.kind === 'mcp.call' && isMcpChatPost(parsed)) return false;
  if (parsed.kind === 'http.request') return !isChatPost(parsed, surface);
  if (targetIssue(parsed) === undefined) return true;
  return !hasLandedAuditComment(parsed, index, earlier, ledger);
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
  const refusal = provenanceRefusal(parsed, surface);
  if (refusal) return { ok: false, reason: refusal };
  const shared = credentialKind !== 'oauth';
  const trailer = provenanceTrailer(run.agentName, run.workItemId, run.runId);
  if (parsed.kind === 'mcp.call') {
    if (isMcpChatPost(parsed)) {
      if (!shared) return { ok: true, action: parsed };
      const messageKey = MESSAGE_KEYS.find((key) => typeof parsed.toolArgs[key] === 'string');
      if (!messageKey) return { ok: true, action: parsed };
      return {
        ok: true,
        action: {
          ...parsed,
          toolArgs: {
            ...parsed.toolArgs,
            [messageKey]: `${String(parsed.toolArgs[messageKey])}\n\n${trailer}`,
          },
        },
      };
    }
    if (!isAuditComment(parsed)) return { ok: true, action: parsed };
    const body = parsed.toolArgs.body as string;
    if (!shared) return { ok: true, action: parsed };
    return {
      ok: true,
      action: { ...parsed, toolArgs: { ...parsed.toolArgs, body: `${body}\n\n${trailer}` } },
    };
  }
  if (!isChatPost(parsed, surface)) return { ok: true, action: parsed };
  const bodyJson = parsed.bodyJson;
  if (!bodyJson) return { ok: true, action: parsed };
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

import type { MockAction } from '../work/types';
import {
  isManagerDm,
  parseSurfaceAction,
  targetChannel,
  type JsonObject,
  type ParsedSurfaceAction,
} from './policy';
import type { SurfaceRecord } from './types';

/**
 * One plain-language line per held action, for the approval card.
 *
 * The literal payload is what the manager approves; this line is how they
 * read it at a glance. It is derived from the verb and its arguments alone,
 * so the card can never say more than the payload does, and an unknown verb
 * falls back to `<tool> on <surface>`.
 */

/** How much of a comment or message body the line quotes. */
export const SUMMARY_TEXT_LIMIT = 120;

const ISSUE_KEYS = ['issueId', 'issue_id', 'id', 'issue', 'ticketId', 'ticket'] as const;
const STATE_KEYS = ['state', 'status', 'stateId', 'state_id', 'statusId', 'status_id', 'workflowState'] as const;
const TEXT_KEYS = ['body', 'text', 'comment', 'message'] as const;
const CHANNEL_KEYS = ['channel', 'channel_id', 'channelId', 'conversation', 'conversationId'] as const;
const THREAD_KEYS = ['thread_ts', 'threadTs', 'thread_id', 'threadId', 'threadKey', 'parentId', 'replyTo', 'reply_to'] as const;
const READ_VERB = /^(?:get|read|fetch|retrieve|show|describe)$/i;
const LIST_VERB = /^(?:list|search|query|find)$/i;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const PLACEHOLDER = /\{\{\s*secret(?:[:.][A-Za-z0-9_-]+)?\s*\}\}/gi;

function firstString(record: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * The first `limit` characters of a body, on one line.
 *
 * Args:
 *   text: The comment or message body.
 *   limit: The cut-off.
 *
 * Returns:
 *   The excerpt, with an ellipsis when cut.
 */
export function excerpt(text: string, limit = SUMMARY_TEXT_LIMIT): string {
  const flat = text
    .replace(BIDI_CONTROLS, '')
    .replace(PLACEHOLDER, '[credential]')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

/** Render an untrusted identifier on one line without bidi controls or unbounded length. */
function label(text: string, limit = 80): string {
  return excerpt(text.replaceAll('<', '‹').replaceAll('>', '›'), limit);
}

/** Quote body text so it cannot visually continue the action grammar. */
function quote(text: string): string {
  return JSON.stringify(excerpt(text));
}

function fieldList(keys: readonly string[]): string {
  const shown = keys.slice(0, 6).map((key) => label(key, 40));
  return `${shown.join(', ')}${keys.length > shown.length ? `, +${keys.length - shown.length} more` : ''}`;
}

function surfaceName(slug: string | undefined, surfaces: readonly SurfaceRecord[]): string {
  if (!slug) return '?';
  return label(surfaces.find((surface) => surface.slug === slug)?.displayName ?? slug);
}

/** Split `save_comment` into its verb and the noun it acts on. */
function verbAndNoun(tool: string): { verb: string; noun: string } {
  const [verb = tool, ...rest] = tool.split(/[_-]/);
  return { verb, noun: rest.join(' ') };
}

function describeMcpCall(
  parsed: Extract<ParsedSurfaceAction, { kind: 'mcp.call' }>,
  surfaces: readonly SurfaceRecord[],
): string {
  const name = surfaceName(parsed.surface, surfaces);
  const args = parsed.toolArgs;
  const { verb, noun } = verbAndNoun(parsed.tool);
  const ref = firstString(args, ISSUE_KEYS);
  const text = firstString(args, TEXT_KEYS);
  if (/^save_comment$/i.test(parsed.tool) || (/comment/i.test(noun) && text !== undefined)) {
    const commentId = firstString(args, ['id']);
    const target = firstString(args, ['issueId', 'issue_id', 'issue', 'ticketId', 'ticket']);
    const quoted = text === undefined ? '' : `: ${quote(text)}`;
    if (commentId) {
      return `Edit comment ${label(commentId)} on ${name}${target ? ` for ${label(target)}` : ''}${quoted}`;
    }
    if (firstString(args, ['parentId'])) return `Reply on ${target ? label(target) : name}${quoted}`;
    return `Comment on ${target ? label(target) : name}${quoted}`;
  }
  if (/^(?:save|update|set|change|transition|move)$/i.test(verb) && noun) {
    const state = firstString(args, STATE_KEYS);
    const extraFields = Object.keys(args).filter(
      (key) =>
        !(ISSUE_KEYS as readonly string[]).includes(key) &&
        !(STATE_KEYS as readonly string[]).includes(key),
    );
    if (ref && state) {
      const extras = extraFields.length ? `; also update ${fieldList(extraFields)}` : '';
      return `Move ${label(ref)} to ${label(state)} on ${name}${extras}`;
    }
    if (ref) {
      const fields = Object.keys(args).filter((key) => !(ISSUE_KEYS as readonly string[]).includes(key));
      return `Update ${label(noun)} ${label(ref)} on ${name}${fields.length ? ` (${fieldList(fields)})` : ''}`;
    }
    const title = firstString(args, ['title', 'name']);
    const createFields = Object.keys(args).filter((key) => key !== 'title' && key !== 'name');
    const extras = createFields.length ? `; also set ${fieldList(createFields)}` : '';
    return `Create ${label(noun)} on ${name}${title ? `: ${quote(title)}` : ''}${extras}`;
  }
  if (READ_VERB.test(verb) && noun) {
    return `Read ${label(noun)}${ref ? ` ${label(ref)}` : ''} on ${name}`;
  }
  if (LIST_VERB.test(verb) && noun) {
    if (ref) return `List ${label(noun)} on ${label(ref)}`;
    const scope = firstString(args, ['project', 'team', 'query']);
    return `List ${label(noun)} on ${name}${scope ? ` (${label(scope)})` : ''}`;
  }
  if (/^(?:create|add|post)$/i.test(verb) && noun) {
    return `Create ${label(noun)} on ${name}${text ? `: ${quote(text)}` : ''}`;
  }
  if (/^(?:delete|remove|archive)$/i.test(verb) && noun) {
    return `${verb[0].toUpperCase()}${verb.slice(1)} ${label(noun)}${ref ? ` ${label(ref)}` : ''} on ${name}`;
  }
  return `${label(parsed.tool)} on ${name}`;
}

function describeHttpRequest(
  parsed: Extract<ParsedSurfaceAction, { kind: 'http.request' }>,
  surfaces: readonly SurfaceRecord[],
): string {
  const surface = surfaces.find((row) => row.slug === parsed.surface);
  const name = surfaceName(parsed.surface, surfaces);
  const body = parsed.bodyJson;
  const text = body ? firstString(body, ['text']) : undefined;
  const isChatPost =
    parsed.method === 'POST' &&
    /^\/*chat\.postMessage$/.test(parsed.path) &&
    surface?.class === 'chat' &&
    text !== undefined;
  if (isChatPost) {
    const channel = targetChannel(parsed);
    const quoted = `: ${quote(text)}`;
    const extraFields = Object.keys(body ?? {}).filter(
      (key) =>
        key !== 'text' &&
        !(CHANNEL_KEYS as readonly string[]).includes(key) &&
        !(THREAD_KEYS as readonly string[]).includes(key),
    );
    const extras = extraFields.length ? `; also send ${fieldList(extraFields)}` : '';
    if (surface && isManagerDm(parsed, surface)) {
      return `Send ${surface.managerName ? label(surface.managerName) : 'the manager'} a ${name} DM${quoted}${extras}`;
    }
    const thread = body && firstString(body, ['thread_ts']) ? ' (in thread)' : '';
    return `Post to ${name} channel ${channel ? label(channel) : '(unknown)'}${thread}${quoted}${extras}`;
  }
  return `${parsed.method} ${label(parsed.path, 120)} on ${name}`;
}

/**
 * Describe one action in plain language.
 *
 * Args:
 *   action: The action as the skill emitted it.
 *   surfaces: The agent's surfaces, for display names and the manager DM.
 *
 * Returns:
 *   One line: what the action does, to what, with the start of any body.
 */
export function summariseAction(action: MockAction, surfaces: readonly SurfaceRecord[]): string {
  const args = (action.args ?? {}) as JsonObject;
  const slug = firstString(args, ['surface', 'channelSlug', 'sheetSlug', 'tweetSlug', 'slug']);
  if (action.tool === 'mcp.call' || action.tool === 'http.request') {
    const parsed = parseSurfaceAction(action);
    if (parsed.ok) {
      return parsed.action.kind === 'mcp.call'
        ? describeMcpCall(parsed.action, surfaces)
        : describeHttpRequest(parsed.action, surfaces);
    }
    const tool = action.tool === 'mcp.call' ? firstString(args, ['tool']) ?? action.tool : action.tool;
    return `${label(tool)} on ${surfaceName(slug, surfaces)}`;
  }
  return slug ? `${label(action.tool)} on ${label(slug)}` : label(action.tool);
}

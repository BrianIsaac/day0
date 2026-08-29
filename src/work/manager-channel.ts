import { summariseAction } from '../surfaces/summary';
import type { SurfaceRecord } from '../surfaces/types';
import type { MockAction } from './types';

export const DECISION_ID_LENGTH = 6;
export const DECISION_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export type DecisionKind = 'plan' | 'actions';
export type DecisionReply =
  | { verb: 'approve'; id: string }
  | { verb: 'reject'; id: string; reason: string };

/**
 * Parse only the bounded command prefix; trailing reject text is inert audit prose.
 *
 * The request shows the command in quotes (Reply “approve ab3xyz”), and a manager
 * who copies it, wraps it in a code span or ends it with a full stop has still
 * given the command. Those wrappers are stripped; prose before the verb or after
 * an approve is not a command.
 */
export function parseDecisionReply(text: string): DecisionReply | undefined {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”‘’`]+/, '')
    .replace(/[\s"'“”‘’`.!]+$/, '')
    .trim();
  const match = /^(approve|reject)\s+([23456789abcdefghjkmnpqrstuvwxyz]{4,6})(?:\s+(.*))?$/i.exec(
    flat,
  );
  if (!match) return undefined;
  const verb = match[1].toLowerCase() as 'approve' | 'reject';
  const id = match[2].toLowerCase();
  if (verb === 'approve') return { verb, id };
  return { verb, id, reason: (match[3] ?? '').slice(0, 200) };
}

/**
 * Turn random bytes into the short, case-insensitive token used in manager replies.
 *
 * 256 is not a multiple of the 31-symbol alphabet, so a plain modulo would draw
 * the first eight symbols more often. Bytes outside the largest multiple are
 * skipped; the caller passes more bytes than characters to absorb the skips.
 */
export function decisionIdFromBytes(bytes: Uint8Array): string {
  const unbiasedLimit = 256 - (256 % DECISION_ID_ALPHABET.length);
  const symbols: string[] = [];
  for (const byte of bytes) {
    if (byte >= unbiasedLimit) continue;
    symbols.push(DECISION_ID_ALPHABET[byte % DECISION_ID_ALPHABET.length]);
    if (symbols.length === DECISION_ID_LENGTH) return symbols.join('');
  }
  throw new Error(`decision id needs ${DECISION_ID_LENGTH} usable random bytes`);
}

/** Find the semantic argument names a generic chat MCP tool advertised at probe time. */
function chatToolArguments(surface: SurfaceRecord, tool: string): { channel: string; text: string } {
  const names = surface.toolArguments?.find((entry) => entry.tool === tool)?.arguments ?? [];
  const channel = names.find((name) => /channel|conversation|recipient|destination|chat/i.test(name));
  const text = names.find((name) => /text|body|message|content/i.test(name));
  return { channel: channel ?? 'channel', text: text ?? 'text' };
}

/** Build one manager-DM action through the connected chat surface's own adapter path. */
export function managerMessageAction(surface: SurfaceRecord, text: string): MockAction {
  if (surface.class !== 'chat' || !surface.managerDmChannelId) {
    throw new Error('surface is not a manager chat channel');
  }
  const postTool = surface.toolAllowlist?.find((tool) =>
    /(?:^|[._-])(?:post|send|create)(?:[._-])?message$|chat\.postmessage$/i.test(tool),
  );
  if (!postTool) throw new Error('manager chat surface exposes no message-send operation');
  const names = chatToolArguments(surface, postTool);
  const body = { [names.channel]: surface.managerDmChannelId, [names.text]: text };
  if (surface.path === 'mcp') {
    return {
      tool: 'mcp.call',
      args: { surface: surface.slug, tool: postTool, toolArgsJson: JSON.stringify(body) },
    };
  }
  if (surface.path === 'documented-api') {
    return {
      tool: 'http.request',
      args: {
        surface: surface.slug,
        method: 'POST',
        path: postTool,
        headersJson: JSON.stringify({
          Authorization: 'Bearer {{secret}}',
          'Content-Type': 'application/json; charset=utf-8',
        }),
        body: JSON.stringify(body),
      },
    };
  }
  throw new Error(`manager chat path ${surface.path ?? 'unknown'} cannot send messages`);
}

function oneLine(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const line = value.replace(/\s+/g, ' ').trim();
  return line || fallback;
}

/**
 * Plain decision request sent when a supervised run parks.
 *
 * A run with a result-dependent phase asks twice: once for the prerequisite
 * writes and once for the closing set authored from their results. The
 * second request says so, or a manager who already approved once reads it
 * as the same ask repeated.
 */
export function decisionRequestText(args: {
  agentName: string;
  title: string;
  id: string;
  kind: DecisionKind;
  plan?: unknown;
  actions?: MockAction[];
  heldIndexes?: number[];
  surfaces?: SurfaceRecord[];
  /** The held actions are the run's closing phase, not its first set. */
  closingPhase?: boolean;
}): string {
  const heading = `${args.agentName} needs your decision on “${oneLine(args.title, 'Untitled work')}”.`;
  let detail: string;
  if (args.kind === 'plan') {
    const plan = (args.plan ?? {}) as { summary?: unknown };
    detail = `Plan: ${oneLine(plan.summary, 'The drafted plan is available in day0.')}`;
  } else {
    const actions = args.actions ?? [];
    const held = args.heldIndexes ?? [];
    const lines = held.map(
      (index, position) =>
        `${position + 1}. ${summariseAction(actions[index], args.surfaces ?? [])}`,
    );
    const heading = args.closingPhase
      ? 'Closing actions, written from the results of the actions already applied in this run:'
      : 'Held actions:';
    detail = `${heading}\n${lines.join('\n') || '1. Review the held actions in day0.'}`;
  }
  return [
    heading,
    '',
    detail,
    '',
    `Reply “approve ${args.id}” or “reject ${args.id} <reason>”.`,
  ].join('\n');
}

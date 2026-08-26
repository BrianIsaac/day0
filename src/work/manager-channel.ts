import { summariseAction } from '../surfaces/summary';
import type { SurfaceRecord } from '../surfaces/types';
import type { MockAction } from './types';

export const DECISION_ID_LENGTH = 6;
export const DECISION_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export type DecisionKind = 'plan' | 'actions';

/** Turn random bytes into the short, case-insensitive token used in manager replies. */
export function decisionIdFromBytes(bytes: Uint8Array): string {
  if (bytes.length < DECISION_ID_LENGTH) throw new Error('decision id needs six random bytes');
  return Array.from(bytes.slice(0, DECISION_ID_LENGTH), (byte) =>
    DECISION_ID_ALPHABET[byte % DECISION_ID_ALPHABET.length],
  ).join('');
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

/** Plain decision request sent when a supervised run parks. */
export function decisionRequestText(args: {
  agentName: string;
  title: string;
  id: string;
  kind: DecisionKind;
  plan?: unknown;
  actions?: MockAction[];
  heldIndexes?: number[];
  surfaces?: SurfaceRecord[];
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
    detail = `Held actions:\n${lines.join('\n') || '1. Review the held actions in day0.'}`;
  }
  return [
    heading,
    '',
    detail,
    '',
    `Reply “approve ${args.id}” or “reject ${args.id} <reason>”.`,
  ].join('\n');
}

import { summariseAction } from '../surfaces/summary';
import type { SurfaceRecord } from '../surfaces/types';
import type { MockAction } from './types';

export const DECISION_ID_LENGTH = 6;
export const DECISION_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export type DecisionKind = 'plan' | 'actions';

/**
 * How long a decision request may sit with neither a provider ts nor a
 * recorded failure before it is treated as undelivered and sent again.
 *
 * The send is one DM through the surface adapter, so anything past a few
 * minutes is a process that died between the claim and the record, not a
 * slow provider. Shared with the dashboard so the card and the timer agree.
 */
export const DECISION_REQUEST_RECOVERY_MS = 3 * 60 * 1000;

export interface DecisionDeliveryFields {
  requestedAt: number;
  ts?: string;
  requestFailedAt?: number;
  requestFailure?: string;
  decidedAt?: number;
}

/**
 * The reason a decision request counts as not delivered, or undefined.
 *
 * A request is undelivered once it recorded a failure, or once the recovery
 * bound passed with no provider ts. A delivered or decided request never is:
 * the manager holds a code that must keep working.
 *
 * Args:
 *   decision: The delivery fields of a work item's decision request.
 *   now: The clock to measure the bound against.
 *
 * Returns:
 *   The recorded failure, `request not delivered` for a silent one, or
 *   undefined while the request is in flight, delivered or decided.
 */
export function undeliveredDecisionReason(
  decision: DecisionDeliveryFields | undefined,
  now: number,
): string | undefined {
  if (!decision || decision.ts || decision.decidedAt) return undefined;
  if (decision.requestFailedAt) return decision.requestFailure ?? 'request not delivered';
  if (now - decision.requestedAt >= DECISION_REQUEST_RECOVERY_MS) return 'request not delivered';
  return undefined;
}
export type DecisionReply =
  | { verb: 'approve'; id: string }
  | { verb: 'reject'; id: string; reason: string };

/**
 * The longest manager reason kept in full, from the card or from chat alike.
 * `convex/work.ts` re-exports it; a chat rejection used to be cut at 200.
 */
export const MANAGER_FEEDBACK_MAX_CHARS = 1000;

/**
 * The longest message a decision request sends. Slack renders about 3,000
 * characters of a text message before it collapses it behind "Show more",
 * which on a phone hides the reply line.
 */
export const MANAGER_MESSAGE_MAX_CHARS = 3_000;

/** What may follow an approve and still leave it an approval: a courtesy, nothing more. */
const APPROVE_COURTESY = /^(?:thanks|thank you|thx|ty|cheers|please|pls|go ahead|ok|okay|sure)$/i;

/**
 * Parse only the bounded command prefix; trailing reject text is the reason.
 *
 * The request shows the command in quotes (Reply “approve ab3xyz”), and a manager
 * who copies it, wraps it in a code span, bold or italics, quotes it, mentions
 * the app first, writes "approved", puts a colon after the verb or ends it with
 * a full stop or a comma has still given the command. Prose before the verb is
 * not a command, and neither is an approve followed by anything but a courtesy:
 * "approve ab3xyz but not the Done" must not approve everything (P5-9).
 */
export function parseDecisionReply(text: string): DecisionReply | undefined {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/^(?:\s|<@[A-Z0-9]+>|>|&gt;)+/i, '')
    .replace(/^[\s"'“”‘’`*_]+/, '')
    .replace(/[\s"'“”‘’`*_.!,;:)]+$/, '')
    .trim();
  const match =
    /^(approve|reject)(?:e?d)?\s*:?\s+([23456789abcdefghjkmnpqrstuvwxyz]{4,6})(?:[\s,;:]+(.*))?$/i.exec(
      flat,
    );
  if (!match) return undefined;
  const verb = match[1].toLowerCase() as 'approve' | 'reject';
  const id = match[2].toLowerCase();
  const rest = (match[3] ?? '').replace(/[\s.!,;:]+$/, '').trim();
  if (verb === 'approve')
    return rest === '' || APPROVE_COURTESY.test(rest) ? { verb, id } : undefined;
  return { verb, id, reason: rest.slice(0, MANAGER_FEEDBACK_MAX_CHARS) };
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
function chatToolArguments(
  surface: SurfaceRecord,
  tool: string,
): { channel: string; text: string } {
  const names = surface.toolArguments?.find((entry) => entry.tool === tool)?.arguments ?? [];
  const channel = names.find((name) =>
    /channel|conversation|recipient|destination|chat/i.test(name),
  );
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
  const reply = `Reply “approve ${args.id}” or “reject ${args.id} <reason>”.`;
  let listHeading: string;
  let lines: string[];
  let noun: string;
  let scope: string | undefined;
  if (args.kind === 'plan') {
    listHeading = planHeading(args.plan);
    lines = planLines(args.plan);
    noun = 'plan steps';
  } else {
    const actions = args.actions ?? [];
    const held = args.heldIndexes ?? [];
    listHeading = args.closingPhase
      ? 'Closing actions, written from the results of the actions already applied in this run:'
      : 'Held actions:';
    lines = held.map(
      (index, position) =>
        `${position + 1}. ${summariseAction(actions[index], args.surfaces ?? [])}`,
    );
    if (lines.length === 0) lines = ['1. Review the held actions in day0.'];
    noun = 'held actions';
    // A Slack approval approves every held index; the card can approve some.
    if (held.length > 1) {
      const covers = held.length === 2 ? 'both actions' : `all ${held.length} actions`;
      scope = `“approve ${args.id}” applies ${covers} listed; to approve only some, decide in day0.`;
    }
  }
  const frame = (shown: readonly string[], omitted: number): string =>
    [
      heading,
      '',
      listHeading,
      ...shown,
      ...(omitted > 0 ? [`…and ${omitted} more ${noun}; the full list is in day0.`] : []),
      '',
      reply,
      ...(scope ? [scope] : []),
    ].join('\n');
  let shown = lines.length;
  while (
    shown > 1 &&
    frame(lines.slice(0, shown), lines.length - shown).length > MANAGER_MESSAGE_MAX_CHARS
  ) {
    shown -= 1;
  }
  return frame(lines.slice(0, shown), lines.length - shown);
}

/** The first line of a plan request: its summary, or where to read the plan. */
function planHeading(plan: unknown): string {
  const summary = (plan ?? {}) as { summary?: unknown };
  return `Plan: ${oneLine(summary.summary, 'The drafted plan is available in day0.')}`;
}

/** The longest plan step or note a request quotes before it clips. */
const PLAN_LINE_MAX_CHARS = 300;

/**
 * What a plan request says beyond the summary: the steps, the risk and the
 * reversibility, each only when the plan has it (P5-8).
 */
function planLines(plan: unknown): string[] {
  const body = (plan ?? {}) as { steps?: unknown; riskNotes?: unknown; reversibility?: unknown };
  const clip = (line: string): string =>
    line.length > PLAN_LINE_MAX_CHARS ? `${line.slice(0, PLAN_LINE_MAX_CHARS - 1)}…` : line;
  const steps = Array.isArray(body.steps)
    ? body.steps.flatMap((step): string[] => {
        const line = oneLine(step, '');
        return line ? [line] : [];
      })
    : [];
  const risk = oneLine(body.riskNotes, '');
  const reversibility = oneLine(body.reversibility, '');
  return [
    ...(steps.length > 0
      ? ['Steps:', ...steps.map((step, index) => clip(`${index + 1}. ${step}`))]
      : []),
    ...(risk ? [clip(`Risk: ${risk}`)] : []),
    ...(reversibility ? [clip(`Reversibility: ${reversibility}`)] : []),
  ];
}

/**
 * The lines a decision request adds when other held action sets are open:
 * one code that decides them all, with every member named so the manager
 * knows exactly which requests the batch covers.
 *
 * Args:
 *   args: The batch code and its members with their own codes.
 *
 * Returns:
 *   Prompt lines to append after the single-item command.
 */
export function batchRequestLines(args: {
  id: string;
  members: ReadonlyArray<{ title: string; decisionId: string }>;
}): string[] {
  const count = args.members.length;
  return [
    '',
    `${count} held action sets are waiting, each shown in its own request:`,
    ...args.members.map(
      (member, index) =>
        `${index + 1}. ${oneLine(member.title, 'Untitled work')} (${member.decisionId})`,
    ),
    `Reply “approve ${args.id}” to approve every held action in all ${count}, or “reject ${args.id} <reason>” to reject them all. A request decided since is left as decided.`,
  ];
}

/**
 * The acknowledgement for a batch reply.
 *
 * Args:
 *   args: The batch code, the verb, and which members were decided or left.
 *
 * Returns:
 *   One message naming what the reply did.
 */
export function batchDecisionNoticeText(args: {
  id: string;
  verb: 'approve' | 'reject';
  decided: readonly string[];
  skipped: ReadonlyArray<{ decisionId: string; reason: string }>;
}): string {
  const noun = args.verb === 'approve' ? 'Approval' : 'Rejection';
  const total = args.decided.length + args.skipped.length;
  const head =
    args.decided.length === 0
      ? `${noun} ${args.id} received, but nothing in it was still open.`
      : `${noun} ${args.id} received for ${args.decided.length} of ${total} decisions (${args.decided.join(', ')}). ${
          args.verb === 'approve' ? 'I’m applying the approved actions now.' : 'I won’t apply them.'
        }`;
  const left = args.skipped.map((member) => `${member.decisionId}: ${member.reason}`);
  return left.length > 0 ? `${head} Left as they were: ${left.join('; ')}.` : head;
}

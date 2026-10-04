import { summariseAction, type SummaryContext } from '../surfaces/summary';
import type { SurfaceRecord } from '../surfaces/types';
import type { SlackBlock } from './slack-blocks';
import type { MockAction } from './types';

/** How many characters a decision code has. */
export const DECISION_ID_LENGTH = 6;
/** The characters a decision code is drawn from: no look-alikes. */
export const DECISION_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** What a decision request asks the manager to decide: a plan or a set of actions. */
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

/** How a decision request was delivered: when, and the message it became. */
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
/**
 * Whether a parked row's decision is the request for the decision it waits
 * on now: of the parked kind and undecided.
 *
 * A decided plan request left on a row that then parked an action set, or a
 * decided phase-one request on a closing set, answered an earlier park; the
 * set now waiting was never asked about, and every place that asks must see
 * that (wave 3 review M5).
 *
 * @param decision - The row's decision fields, if any.
 * @param state - The row's state.
 * @returns True when the decision belongs to the state the row is parked in.
 */
export function askedFor(
  decision: { readonly kind: DecisionKind; readonly decidedAt?: number } | undefined,
  state: string,
): boolean {
  if (!decision || decision.decidedAt !== undefined) return false;
  return (
    (state === 'plan-pending' && decision.kind === 'plan') ||
    (state === 'actions-pending' && decision.kind === 'actions')
  );
}

/** A decision request intake reads replies against: sent, or on its way. */
export interface OpenDecisionRequest {
  readonly decisionId: string;
  /** The request message's provider ts; absent while the send is in flight. */
  readonly ts?: string;
}

/** A batch code whose members include open requests, with those members' codes. */
export interface OpenDecisionBatch {
  readonly batchId: string;
  readonly decisionIds: readonly string[];
}

/**
 * What a manager chat channel has open, which decides whether the decision
 * poll reads its DM at all (Q13's back-off when nothing is open).
 */
export interface OpenDecisions {
  readonly requests: readonly OpenDecisionRequest[];
  readonly batches: readonly OpenDecisionBatch[];
  /**
   * A decision on the channel is recent enough that a late reply to it, or a
   * mistyped code, should still be answered (`DECISION_NOTICE_WINDOW_MS`).
   */
  readonly noticeOwed: boolean;
  /**
   * The provider timestamps of Day0's other messages in the DM within the notice window (a decided
   * or replaced request, a note), whose threads are read as an open request's is (M10): a reply
   * left under any of them is the manager's all the same. Absent when there are none.
   */
  readonly threads?: readonly string[];
}

/** Nothing open and no notice owed: the decision poll leaves the DM unread. */
export const NOTHING_OPEN: OpenDecisions = { requests: [], batches: [], noticeOwed: false };

/**
 * How long after a decision is made on a channel its DM is still read, so a
 * reply sent late, to a code already decided, is told so.
 */
export const DECISION_NOTICE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Whether the decision poll reads the manager DM.
 *
 * @param open - What the channel has open.
 * @returns True when a request or a batch is open, a notice may be owed, or a recent message's
 *   thread is to be read.
 */
export function readsManagerDm(open: OpenDecisions): boolean {
  return (
    open.requests.length > 0 ||
    open.batches.length > 0 ||
    open.noticeOwed ||
    (open.threads?.length ?? 0) > 0
  );
}

/**
 * The codes whose replies wait for the next poll because a read they depend
 * on failed: each request whose thread could not be read, and every batch
 * that decides one of them. An answer in the unread thread may have come
 * first and said otherwise, so no reply to those codes is taken until the
 * thread has been read (Q13, per-message resolution).
 *
 * @param open - What the channel has open.
 * @param unreadThreads - The codes of the requests whose thread read failed.
 * @returns The codes held.
 */
export function heldReplyCodes(
  open: OpenDecisions,
  unreadThreads: readonly string[],
): ReadonlySet<string> {
  const unread = new Set(unreadThreads);
  return new Set([
    ...unread,
    ...open.batches
      .filter((batch) => batch.decisionIds.some((id) => unread.has(id)))
      .map((batch) => batch.batchId),
  ]);
}

/** A manager's reply as the channel parses it: approve or reject, with the code and any reason. */
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
): { channel: string; text: string; thread?: string } {
  const names = surface.toolArguments?.find((entry) => entry.tool === tool)?.arguments ?? [];
  const channel = names.find((name) =>
    /channel|conversation|recipient|destination|chat/i.test(name),
  );
  const text = names.find((name) => /text|body|message|content/i.test(name));
  const thread = names.find((name) => /thread/i.test(name));
  return {
    channel: channel ?? 'channel',
    text: text ?? 'text',
    ...(thread ? { thread } : {}),
  };
}

/** The documented Slack headers every manager-DM request carries; the secret is placed by the gate. */
const SLACK_JSON_HEADERS = JSON.stringify({
  Authorization: 'Bearer {{secret}}',
  'Content-Type': 'application/json; charset=utf-8',
});

/** Where in the manager DM a message goes, and what it carries beside its text. */
export interface ManagerMessagePlacement {
  /** The provider timestamp of the message to thread under. */
  readonly threadTs?: string;
  /**
   * Block Kit blocks the message renders with (a decision request's text and buttons), its text
   * kept as the notification fallback. Only the documented API sends them; an MCP chat tool takes
   * text alone, so the caller never offers it blocks.
   */
  readonly blocks?: readonly SlackBlock[];
}

/**
 * Build one manager-DM action through the connected chat surface's own adapter path.
 *
 * A message that answers Day0's own request (an acknowledgement) is threaded
 * under it (M finding 3): on the documented API by `thread_ts`, over MCP by
 * the thread argument the tool advertised at probe time, and at the top of
 * the DM when the tool advertised none.
 */
export function managerMessageAction(
  surface: SurfaceRecord,
  text: string,
  placement: ManagerMessagePlacement = {},
): MockAction {
  if (surface.class !== 'chat' || !surface.managerDmChannelId) {
    throw new Error('surface is not a manager chat channel');
  }
  const postTool = surface.toolAllowlist?.find((tool) =>
    /(?:^|[._-])(?:post|send|create)(?:[._-])?message$|chat\.postmessage$/i.test(tool),
  );
  if (!postTool) throw new Error('manager chat surface exposes no message-send operation');
  const names = chatToolArguments(surface, postTool);
  const thread = placement.threadTs
    ? surface.path === 'mcp'
      ? names.thread
      : 'thread_ts'
    : undefined;
  const body = {
    [names.channel]: surface.managerDmChannelId,
    [names.text]: text,
    ...(thread && placement.threadTs ? { [thread]: placement.threadTs } : {}),
  };
  if (surface.path === 'mcp') {
    if (placement.blocks !== undefined) {
      throw new Error('an MCP chat tool takes no blocks; the request goes as text alone');
    }
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
        headersJson: SLACK_JSON_HEADERS,
        body: JSON.stringify(
          placement.blocks === undefined ? body : { ...body, blocks: placement.blocks },
        ),
      },
    };
  }
  throw new Error(`manager chat path ${surface.path ?? 'unknown'} cannot send messages`);
}

/** The Slack method that edits a message; the gate matches it by this exact name. */
const MESSAGE_EDIT_METHOD = 'chat.update';

/**
 * Whether a surface can edit one of Day0's messages in the manager DM: a
 * documented-API chat card with a manager DM whose allowlist names
 * `chat.update` exactly, as the gate's allowlist check reads it.
 */
export function canEditManagerMessage(
  surface: Pick<SurfaceRecord, 'class' | 'managerDmChannelId' | 'path' | 'toolAllowlist'>,
): boolean {
  return (
    surface.class === 'chat' &&
    surface.managerDmChannelId !== undefined &&
    surface.managerDmChannelId !== '' &&
    surface.path === 'documented-api' &&
    (surface.toolAllowlist ?? []).includes(MESSAGE_EDIT_METHOD)
  );
}

/**
 * Build the edit of one of Day0's own messages in the manager DM, when the
 * surface can make one: a documented API whose card allowlisted
 * `chat.update`. MCP chat tools advertise no edit, so there is none there.
 *
 * @param ts - The provider timestamp of the message to edit.
 * @param blocks - The blocks the edited message renders with, for a message that carried blocks:
 *   Slack's `chat.update` given text and no blocks removes them, so a request that had buttons is
 *   edited with its blocks stated (its text, no buttons) rather than left to that rule.
 * @returns The action, or undefined when the surface cannot edit a message.
 */
export function managerMessageUpdateAction(
  surface: SurfaceRecord,
  ts: string,
  text: string,
  blocks?: readonly SlackBlock[],
): MockAction | undefined {
  if (!canEditManagerMessage(surface) || !surface.managerDmChannelId) return undefined;
  const body = { channel: surface.managerDmChannelId, ts, text };
  return {
    tool: 'http.request',
    args: {
      surface: surface.slug,
      method: 'POST',
      path: MESSAGE_EDIT_METHOD,
      headersJson: SLACK_JSON_HEADERS,
      body: JSON.stringify(blocks === undefined ? body : { ...body, blocks }),
    },
  };
}

function oneLine(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const line = value.replace(/\s+/g, ' ').trim();
  return line || fallback;
}

/** How a request with buttons opens its reply line; the line without them opens "Reply ". */
export const BUTTONS_REPLY_LEAD = 'Press Approve or Reject below, or reply ';

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
  /** The work item the request is about: its ticket and link, or the ask and its thread. */
  item?: DecisionRequestItem;
  /** The set's rows the gate refused, which no decision sends. */
  refused?: ReadonlyArray<{ readonly index: number; readonly reason: string }>;
  /** Whether Slack renders the request, so another channel reads by its Slack mention. */
  slackMarkup?: boolean;
  /** For a plan drafted without its ticket or thread: the system and why (P7-18). */
  draftedWithout?: DraftedWithoutLine;
  /** The request carries Approve and Reject buttons (RM3 (a)); the typed code works beside them. */
  buttons?: boolean;
}): string {
  const heading = `${args.agentName} needs your decision on “${oneLine(args.title, 'Untitled work')}”.`;
  const about = args.item ? itemLines(args.item) : [];
  const typed = `“approve ${args.id}” or “reject ${args.id} <reason>”`;
  const reply = args.buttons ? `${BUTTONS_REPLY_LEAD}${typed}.` : `Reply ${typed}.`;
  // A request is read on its own, so its action lines name the ask's channel
  // and quote a body as far as a plan line does (U9 step 24).
  const summary: SummaryContext = {
    ...(args.item?.replyTarget ? { replyTarget: args.item.replyTarget } : {}),
    textLimit: PLAN_LINE_MAX_CHARS,
    ...(args.slackMarkup ? { slackMarkup: true } : {}),
  };
  const refused =
    args.kind === 'actions'
      ? refusedLines(args.refused ?? [], args.actions ?? [], args.surfaces ?? [], summary)
      : [];
  let listHeading: string;
  let lines: string[];
  let noun: string;
  let scope: string | undefined;
  if (args.kind === 'plan') {
    listHeading = planHeading(args.plan);
    lines = [
      ...(args.draftedWithout ? [draftedWithoutLine(args.draftedWithout)] : []),
      ...planLines(args.plan),
    ];
    noun = 'plan steps';
  } else {
    const actions = args.actions ?? [];
    const held = args.heldIndexes ?? [];
    listHeading = args.closingPhase
      ? 'Closing actions, written from the results of the actions already applied in this run:'
      : 'Held actions:';
    lines = held.map(
      (index, position) =>
        `${position + 1}. ${summariseAction(actions[index], args.surfaces ?? [], summary)}`,
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
      ...about,
      '',
      listHeading,
      ...shown,
      ...(omitted > 0 ? [`…and ${omitted} more ${noun}; the full list is in day0.`] : []),
      ...(refused.length > 0 ? ['', ...refused] : []),
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

/** What a decision request says about the work item it asks about. */
export interface DecisionRequestItem {
  readonly sourceCategory: string;
  readonly externalId: string;
  /** The provider's link to the item: the ticket, or the ask's message. */
  readonly link?: string;
  /** Where the answer to a chat ask goes: the ask's channel and thread. */
  readonly replyTarget?: {
    readonly channel: string;
    readonly channelName?: string;
    readonly threadTs?: string;
  };
}

/**
 * The lines under the heading that say which item this is: a ticket's id
 * and link, or where a chat ask was made and that its answer goes back to
 * that thread (P8-6), so two requests with the same title can be told apart
 * and opened from a phone.
 */
function itemLines(item: DecisionRequestItem): string[] {
  const link = item.link === undefined ? '' : oneLine(item.link, '');
  if (item.replyTarget) {
    const channel = `#${oneLine(item.replyTarget.channelName ?? item.replyTarget.channel, 'the channel')}`;
    return [
      `Asked in ${channel}${link ? `: ${link}` : ''}`,
      `The answer to the ask goes to its thread in ${channel}.`,
    ];
  }
  if (item.sourceCategory === 'ticket-queue') {
    return [`Ticket: ${oneLine(item.externalId, 'unnamed')}${link ? ` ${link}` : ''}`];
  }
  return link ? [`Source: ${link}`] : [];
}

/** The most refused rows a request lists by name. */
const REFUSED_LINES_SHOWN = 5;

/** The most of a refusal's reason a request quotes; the gate's own reasons are far shorter. */
const REFUSED_REASON_MAX_CHARS = 120;

/**
 * The rows of a held set the gate refused, each with its reason: no decision
 * sends them, and a manager approving the set should know what it leaves out.
 */
function refusedLines(
  refused: ReadonlyArray<{ readonly index: number; readonly reason: string }>,
  actions: readonly MockAction[],
  surfaces: readonly SurfaceRecord[],
  context: SummaryContext,
): string[] {
  if (refused.length === 0) return [];
  const clip = (text: string, limit: number): string =>
    text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  // The reason is what the manager needs from the line, so the action gives
  // way to it within the line's length, never the other way round.
  const shown = refused.slice(0, REFUSED_LINES_SHOWN).map(({ index, reason }) => {
    const action = actions[index];
    const what = action ? summariseAction(action, surfaces, context) : `action ${index + 1}`;
    const why = ` (${clip(oneLine(reason, 'refused'), REFUSED_REASON_MAX_CHARS)})`;
    return `- ${clip(what, PLAN_LINE_MAX_CHARS - '- '.length - why.length)}${why}`;
  });
  const more = refused.length - shown.length;
  return [
    'Refused by Day0’s gate, so not sent whatever you decide:',
    ...shown,
    ...(more > 0 ? [`…and ${more} more refused; the full list is in day0.`] : []),
  ];
}

/** What a plan request says of a plan drafted without its ticket or thread (P7-18). */
export interface DraftedWithoutLine {
  /** The source system's display name. */
  readonly system: string;
  readonly subject: 'record' | 'thread';
  readonly cause: 'not-connected' | 'read-failed';
}

/**
 * The line that tells the manager a plan was drafted without what it acts
 * on, and what approving it now means: in the request and on the card.
 */
export function draftedWithoutLine(without: DraftedWithoutLine): string {
  const noun = without.subject === 'record' ? 'ticket' : 'thread';
  const system = oneLine(without.system, 'its system');
  return without.cause === 'not-connected'
    ? `Drafted without reading the ${noun}: ${system} was not connected. Day0 drafts the plan again when ${system} is back; approving now runs it as drafted.`
    : `Drafted without reading the ${noun}: the read on ${system} did not land. Approving runs it as drafted.`;
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

import { actionIntent, isAuditComment, isSurfaceTool, messageTarget, parseSurfaceAction } from '../surfaces/policy';
import { messageTexts } from './evidence-claims';
import type { MockAction, ReplyTarget } from './types';

/** A Slack mention's external id: `<channel id>:<message ts>`. */
const SLACK_EXTERNAL_ID = /^([CDG][A-Z0-9]+):(\d+\.\d+)$/;
const MENTION_TITLE = /#([^\s#]+)/;

/**
 * The reply target of a work item row, deriving one for rows seeded before it was stored.
 *
 * A Slack mention seeded before `replyTarget` existed still carries the
 * channel and message timestamp in its external id, and the channel name in
 * its title (`Slack mention in #team-asks`), so the reply can be addressed
 * without re-polling the provider.
 *
 * Args:
 *   row: The work item's stored target, category, external id and title.
 *
 * Returns:
 *   The stored target, a derived one for a legacy Slack mention, or undefined.
 */
export function replyTargetFor(row: {
  replyTarget?: ReplyTarget;
  sourceCategory: string;
  externalId: string;
  title: string;
}): ReplyTarget | undefined {
  const match =
    row.sourceCategory === 'event-stream'
      ? SLACK_EXTERNAL_ID.exec(row.externalId)
      : null;
  if (row.replyTarget) {
    return match
      ? { ...row.replyTarget, channel: match[1], threadTs: match[2] }
      : row.replyTarget;
  }
  if (!match) return undefined;
  const channelName = MENTION_TITLE.exec(row.title)?.[1];
  return { channel: match[1], threadTs: match[2], ...(channelName ? { channelName } : {}) };
}

/**
 * The prompt line that tells the planner and the skill where a public reply belongs.
 *
 * Args:
 *   target: The work item's reply target.
 *
 * Returns:
 *   `Reply target: channel C0… (#team-asks), thread_ts 1787…`.
 */
export function replyTargetLine(target: ReplyTarget): string {
  const name = target.channelName ? ` (#${target.channelName})` : '';
  const thread = target.threadTs ? `, thread_ts ${target.threadTs}` : ', top-level post';
  return `Reply target: channel ${target.channel}${name}${thread}`;
}

/** Where a message is read, relative to the thread the work item answers. */
export type ThreadReferencePlace = 'in-thread' | 'elsewhere';

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
/** A label a model puts before the pair: `Ref:`, `Reference:`, `Thread:`, `Record id:`. */
const REFERENCE_LABEL = String.raw`\b(?:thread\s+)?(?:ref(?:erence)?|thread|record(?:\s+id)?|id)\b\s*[:#-]?\s*`;

/** The thread's raw identity as a model writes it: the channel and timestamp pair, or the timestamp alone. */
function rawThreadReference(target: ReplyTarget & { threadTs: string }): string {
  const channel = target.channel.replace(REGEX_META, '\\$&');
  const ts = target.threadTs.replace(REGEX_META, '\\$&');
  return String.raw`(?:(?:channel\s+)?${channel}\s*[:/,]?\s*(?:thread(?:_ts)?\s*[:=]?\s*)?)?${ts}`;
}

/**
 * Take the raw channel id and thread timestamp of the thread a work item
 * answers out of a message a person reads.
 *
 * A Slack mention's record id is `<channel>:<ts>`, and a skill that cites its
 * record id writes that into the reply. Where a message goes is carried by
 * the action's `channel` and `thread_ts`, which is what the ledger, the
 * reuse on retry and the reply checks read, so the text never needs it. In
 * the thread itself the reference is dropped with its label (or, inside a
 * sentence, said as "this thread"); anywhere else
 * (the manager DM, a ticket comment) it is said in words.
 *
 * Args:
 *   text: The visible text.
 *   target: The thread the work item answers.
 *   place: Whether the message is posted in that thread.
 *
 * Returns:
 *   The text without the raw reference; the same text when it has none, when
 *   the target has no thread, or when nothing else would be left.
 */
export function withoutThreadReference(text: string, target: ReplyTarget | undefined, place: ThreadReferencePlace): string {
  if (!target?.threadTs) return text;
  const raw = rawThreadReference({ ...target, threadTs: target.threadTs });
  if (!new RegExp(raw, 'i').test(text)) return text;
  if (place === 'elsewhere') {
    const words = target.channelName ? `the ask in #${target.channelName}` : 'the Slack thread';
    return text.replace(new RegExp(raw, 'gi'), words);
  }
  // At the end of a line the labelled reference goes whole; inside a sentence it is said as "this thread".
  const tail = new RegExp(String.raw`[ \t]*[([]?\s*(?:${REFERENCE_LABEL})?${raw}\s*[)\]]?\.?(?=[ \t]*(?:\n|$))`, 'gi');
  const inline = new RegExp(String.raw`(?:${REFERENCE_LABEL})?${raw}`, 'gi');
  const next = text
    .replace(tail, '')
    .replace(inline, 'this thread')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return next === '' ? text : next;
}

/**
 * Apply `withoutThreadReference` to every message an action set would send.
 *
 * Args:
 *   actions: The authored set, before the gate.
 *   surfaces: The agent's surfaces.
 *   target: The thread the work item answers, when it came from chat.
 *
 * Returns:
 *   The set and the indexes whose text changed; the same array when none did.
 *   Only the text field changes: `channel`, `thread_ts` and every other
 *   argument stay as authored.
 */
export function withoutOwnThreadReferences<T extends MockAction>(
  actions: readonly T[],
  surfaces: ReadonlyArray<{ slug: string; class: string }>,
  target: ReplyTarget | undefined,
): { actions: readonly T[]; changed: number[] } {
  if (!target?.threadTs) return { actions, changed: [] };
  const thread = `${target.channel}/${target.threadTs}`;
  const changed: number[] = [];
  const next = actions.map((action, index): T => {
    if (!isSurfaceTool(action.tool)) return action;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || actionIntent(parsed.action) !== 'write') return action;
    const payload = action.tool === 'http.request' ? action.args?.body : action.args?.toolArgsJson;
    if (typeof payload !== 'string') return action;
    const surface = surfaces.find((row) => row.slug === parsed.action.surface);
    // A message or a comment is read by a person; a value typed into a system is data and stays as written.
    if (surface?.class !== 'chat' && !isAuditComment(parsed.action)) return action;
    const place: ThreadReferencePlace =
      surface?.class === 'chat' && messageTarget(parsed.action) === thread ? 'in-thread' : 'elsewhere';
    let record: unknown;
    try {
      record = JSON.parse(payload);
    } catch {
      return action;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return action;
    const texts = new Set(messageTexts(action));
    let touched = false;
    const rewritten = Object.fromEntries(
      Object.entries(record).map(([key, value]): [string, unknown] => {
        if (typeof value !== 'string' || !texts.has(value)) return [key, value];
        const clean = withoutThreadReference(value, target, place);
        touched ||= clean !== value;
        return [key, clean];
      }),
    );
    if (!touched) return action;
    changed.push(index);
    const body = JSON.stringify(rewritten);
    return { ...action, args: { ...action.args, ...(action.tool === 'http.request' ? { body } : { toolArgsJson: body }) } };
  });
  return changed.length === 0 ? { actions, changed } : { actions: next, changed };
}

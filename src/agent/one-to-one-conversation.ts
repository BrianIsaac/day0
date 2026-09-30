import type { UIMessage } from 'ai';
import { DAY_ONE_TOPIC_COUNT } from './day-one-progress';

/**
 * The most characters one reply in the one-to-one may carry. The route bounds only the output,
 * so without this one pasted document is sent whole on every later turn of the conversation.
 */
export const REPLY_MAX_CHARS = 4000;

/**
 * One turn of the chat one-to-one as the session keeps it: who said it, what they said and, for
 * the employee, the question the turn was on and the closing line when the turn ended the
 * one-to-one. The session keeps every turn as it is given, so a room that closes at any point
 * reopens on the same conversation.
 */
export interface OneToOneTurn {
  /** The id the room drew the turn under, so a reopened room draws the same turn. */
  readonly id: string;
  readonly speaker: 'manager' | 'employee';
  readonly text: string;
  /** The question an employee turn put, from 0 (`topicIndexOf`). */
  readonly topicIndex?: number;
  /** The line an employee turn closed the one-to-one with, when the close was earned. */
  readonly closingLine?: string;
  /** When the turn was kept, in milliseconds. */
  readonly at: number;
}

/**
 * How many questions the manager has answered: each manager turn directly after an employee turn
 * that said something. The close gate's own count (`managerReplies`), read off the kept turns.
 */
export function repliesIn(turns: readonly OneToOneTurn[]): number {
  return turns.filter(
    (turn: OneToOneTurn, index: number): boolean =>
      turn.speaker === 'manager' &&
      turn.text.trim() !== '' &&
      turns[index - 1]?.speaker === 'employee' &&
      turns[index - 1].text.trim() !== '',
  ).length;
}

/** Whether the manager has the last word: a reply the employee has not answered yet. */
export function owesAnswer(turns: readonly OneToOneTurn[]): boolean {
  return turns.at(-1)?.speaker === 'manager';
}

/** Whether the employee closed the one-to-one: its last turn carries the closing line. */
export function isClosed(turns: readonly OneToOneTurn[]): boolean {
  const last = turns.at(-1);
  return last?.speaker === 'employee' && last.closingLine !== undefined;
}

/**
 * Whether a close is earned after these turns: every question has had a reply. The route's gate
 * (`withEarnedClose`) decides the same on the history it answers; the session holds it again on
 * what it keeps.
 */
export function closeEarned(turns: readonly OneToOneTurn[]): boolean {
  return repliesIn(turns) >= DAY_ONE_TOPIC_COUNT;
}

/**
 * The conversation as the charter is drafted from it: one paragraph per turn, the speaker's label
 * first (USER for the manager, ASSISTANT for the employee), the closing line kept on the turn that
 * said it. The labels are the ones the transcript attribution reads (`parseTranscript`).
 *
 * @returns The turns joined by blank lines; an empty turn is left out.
 */
export function conversationTranscript(turns: readonly OneToOneTurn[]): string {
  return turns
    .map((turn: OneToOneTurn): string => {
      const body = [turn.text, turn.closingLine ?? ''].filter(Boolean).join(' ');
      return body ? `${turn.speaker === 'manager' ? 'USER' : 'ASSISTANT'}: ${body}` : '';
    })
    .filter((line: string): boolean => line !== '')
    .join('\n\n');
}

/** The mark an employee turn carries in the room once the session holds it. */
interface KeptMark {
  readonly kept: true;
}

/**
 * A turn's message metadata with the kept mark added, whatever else it carried (the question
 * number): what the route puts on a kept answer's `finish`, which the chat hook merges into the
 * turn it drew.
 */
export function withKeptMark(metadata: unknown): Record<string, unknown> & KeptMark {
  return typeof metadata === 'object' && metadata !== null
    ? { ...metadata, kept: true }
    : { kept: true };
}

/**
 * Whether the room's message is an employee turn the session holds: one drawn from the kept
 * turns, or one whose stream finished after the session kept it (`keptAnswer`). A turn that
 * failed, was cut off or was refused carries no mark.
 */
export function isKeptAnswer(message: Pick<UIMessage, 'role' | 'metadata'>): boolean {
  const metadata = message.metadata;
  return (
    message.role === 'assistant' &&
    typeof metadata === 'object' &&
    metadata !== null &&
    'kept' in metadata &&
    metadata.kept === true
  );
}

/**
 * The kept turns as the chat hook holds messages, so a reopened room draws them as the live
 * conversation drew them: the question number on an employee turn and its closing line as the
 * close's tool part, and the kept mark.
 */
export function uiMessagesOf(turns: readonly OneToOneTurn[]): UIMessage[] {
  return turns.map((turn: OneToOneTurn): UIMessage => {
    if (turn.speaker === 'manager') {
      return { id: turn.id, role: 'user', parts: [{ type: 'text', text: turn.text }] };
    }
    const parts: UIMessage['parts'] = [
      ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
      ...(turn.closingLine === undefined
        ? []
        : [
            {
              type: 'tool-dayOneComplete' as const,
              toolCallId: `${turn.id}-close`,
              state: 'input-available' as const,
              input: { closingLine: turn.closingLine },
            },
          ]),
    ];
    return {
      id: turn.id,
      role: 'assistant',
      parts,
      metadata: withKeptMark(turn.topicIndex === undefined ? {} : { topicIndex: turn.topicIndex }),
    };
  });
}

/** What an employee turn came to, as the stream that carried it ended. */
export interface AnswerEnding {
  /** Everything the turn said, its text parts joined. */
  readonly text: string;
  /** Whether the turn called `dayOneComplete`. */
  readonly closed: boolean;
  /** The stream's finish reason, or undefined for a stream that stopped without one. */
  readonly finishReason?: string;
}

/**
 * Name what went wrong with a turn that ended without an error, if anything did.
 *
 * A provider stall reaches the room as a stream that finished having said nothing and called
 * nothing; the route's 60-second deadline reaches it as a stream that stopped without its
 * `finish` chunk, and a spent output budget as a finish of `length`. The SDK reports both as an
 * ordinary `ready`, so on 19 Sep the first left the composer waiting for good and the second left
 * half a sentence standing as the answer. The room says the failure; the route keeps only a turn
 * with none, so the session and the room agree on which answers stand.
 *
 * @returns The line to show above Ask again, or null for a turn that stands.
 */
export function answerFailure(ending: AnswerEnding): string | null {
  // A moderation stop is the provider's refusal, whatever text preceded it.
  if (ending.finishReason === 'content-filter') return "Day0's model provider refused to answer";
  if (!ending.closed && !ending.text.trim()) return 'Day0 returned nothing';
  if (ending.finishReason === undefined || ending.finishReason === 'length') {
    return 'Day0 was cut off mid-reply';
  }
  return null;
}

/**
 * The most turns one conversation keeps, the employee's answer to the last reply included:
 * twenty exchanges, three times the seven questions. A reply is kept only while there is room for
 * the answer it is owed. With the bounds below, the turns, the transcript drafted from them and
 * the drafted answers stay well inside a session row's size. A one-to-one that reaches it is
 * finished from what was said.
 */
export const MAX_KEPT_TURNS = 40;

/** The longest id a kept turn may carry: the room's and the route's ids are 36 characters. */
export const TURN_ID_MAX_CHARS = 128;

/** The most characters an employee turn may keep: its 2,000-token output budget and some. */
export const ANSWER_MAX_CHARS = 8000;

/** A reply the room sent: the id it drew it under and the words. */
export interface SentReply {
  readonly id: string;
  readonly text: string;
}

/**
 * What a room asks of the session before its turn is put to the employee.
 *
 * A reply names the question it answers (`question`, the last employee turn the room drew that
 * the session kept) and carries every reply the room drew since, oldest first: a reply whose send
 * never reached the session is delivered with the next one, in the order the manager wrote them.
 */
export type TurnRequest =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'reply';
      readonly question: string | null;
      readonly replies: readonly SentReply[];
    }
  | {
      readonly kind: 'ask-again';
      /** The question the replies answer; null for the opening. */
      readonly question: string | null;
      /** The room's replies since that question, which the employee answers again; none for the opening. */
      readonly replies: readonly SentReply[];
      /** The employee turn the room set aside to ask again, when it had one. */
      readonly discarding: string | null;
    };

/** The conversation a turn is answered from, or why the session will not take the turn. */
export type TurnDecision =
  | {
      readonly ok: true;
      readonly turns: readonly OneToOneTurn[];
      /** The manager turn the employee answers, or null for the opening. */
      readonly answering: string | null;
      /** Whether the turn kept a reply the session did not hold before it. */
      readonly replied: boolean;
    }
  | { readonly ok: false; readonly refusal: string };

/** The refusal for a room whose copy the kept conversation has moved past. */
export const MOVED_ON_REFUSAL = 'The one-to-one moved on in another window. Reload to carry on.';

const MOVED_ON: TurnDecision = { ok: false, refusal: MOVED_ON_REFUSAL };

/** The refusal for a turn past `MAX_KEPT_TURNS`, or a reply that would leave no room for its answer. */
const TURN_BOUND_REFUSAL =
  'The one-to-one is as long as it can be. Finish it to draft the charter.';

/** Why a reply the session has not kept cannot be, or null for one it can keep. */
function replyRefusal(reply: SentReply): string | null {
  const text = reply.text.trim();
  if (!text) return 'A reply needs some words.';
  if (text.length > REPLY_MAX_CHARS) return `A reply is at most ${REPLY_MAX_CHARS} characters.`;
  if (!reply.id || reply.id.length > TURN_ID_MAX_CHARS) return 'The reply carries no usable id.';
  return null;
}

/**
 * Keep the manager's replies to `question` at the end of the conversation.
 *
 * The question must be the conversation's last employee turn, so a room that drew an earlier one
 * (a second window, a window from before the one-to-one started again) never has its reply filed
 * under a question it did not see. The replies the session already holds after that question
 * must be the first of the room's, in order; the rest are kept after them, so a reply whose send
 * failed is kept before the one sent after it, and a send repeated after a lost connection is
 * taken as it stands. Several replies in a row answer one question, as the close gate counts
 * them: once.
 */
function withReplies(
  turns: readonly OneToOneTurn[],
  question: string | null,
  replies: readonly SentReply[],
  now: number,
): TurnDecision {
  const asked = turns.findLastIndex((turn: OneToOneTurn): boolean => turn.speaker === 'employee');
  if (asked === -1) return { ok: false, refusal: 'The one-to-one has not opened yet.' };
  if (turns[asked].id !== question) return MOVED_ON;
  const held = turns.slice(asked + 1);
  if (held.length > replies.length || held.some((turn, index) => turn.id !== replies[index].id)) {
    return MOVED_ON;
  }
  const fresh = replies.slice(held.length);
  if (fresh.length === 0) {
    return { ok: true, turns, answering: held.at(-1)?.id ?? null, replied: false };
  }
  const kept: OneToOneTurn[] = [...turns];
  for (const reply of fresh) {
    const refusal = replyRefusal(reply);
    if (refusal !== null) return { ok: false, refusal };
    if (kept.some((turn: OneToOneTurn): boolean => turn.id === reply.id)) return MOVED_ON;
    kept.push({ id: reply.id, speaker: 'manager', text: reply.text.trim(), at: now });
  }
  // The answer these replies are owed is a turn too.
  if (kept.length + 1 > MAX_KEPT_TURNS) return { ok: false, refusal: TURN_BOUND_REFUSAL };
  return { ok: true, turns: kept, answering: kept[kept.length - 1].id, replied: true };
}

/**
 * Decide a turn against the kept conversation, which the session's own copy decides and never
 * the room's: a reopened or second room with a stale copy cannot fork it, and its replies are
 * refused rather than filed under a question it never drew.
 *
 * - `open`: the employee's opening, only on a conversation with nothing kept yet.
 * - `reply`: the manager's replies, kept before the employee is asked (`withReplies`).
 * - `ask-again`: the room's replies are answered again. The employee turn the room set aside is
 *   set aside here too, and only that one: an answer the room never saw is never dropped. A reply
 *   the session never received (the send failed on the way) is kept first, so asking again after
 *   a failed send loses neither it nor the answer before it.
 *
 * @param now - When the turn is kept, in milliseconds.
 */
export function decideTurn(
  turns: readonly OneToOneTurn[],
  request: TurnRequest,
  now: number,
): TurnDecision {
  if (isClosed(turns)) return { ok: false, refusal: 'The one-to-one is already over.' };
  switch (request.kind) {
    case 'open':
      return turns.length === 0
        ? { ok: true, turns, answering: null, replied: false }
        : { ok: false, refusal: 'The one-to-one has already begun. Reload to carry on.' };
    case 'reply':
      return request.replies.length === 0
        ? { ok: false, refusal: 'A reply needs some words.' }
        : withReplies(turns, request.question, request.replies, now);
    case 'ask-again': {
      const last = turns.at(-1);
      const kept =
        last?.speaker === 'employee' && last.id === request.discarding ? turns.slice(0, -1) : turns;
      if (request.replies.length === 0) {
        return kept.length === 0 && request.question === null
          ? { ok: true, turns: kept, answering: null, replied: false }
          : MOVED_ON;
      }
      return withReplies(kept, request.question, request.replies, now);
    }
    default: {
      const unknown: never = request;
      throw new Error(`unhandled turn request ${String(unknown)}`);
    }
  }
}

/** The manager's last turn, which the employee's next answer answers. */
function answeringOf(turns: readonly OneToOneTurn[]): string | null {
  const last = turns.at(-1);
  return last?.speaker === 'manager' ? last.id : null;
}

/** An employee answer offered to the session, and the manager turn it answers. */
export interface OfferedAnswer {
  /** The manager turn the answer answers, or null for the opening. */
  readonly answering: string | null;
  readonly id: string;
  readonly text: string;
  readonly topicIndex: number;
  readonly closingLine?: string;
}

/** The conversation with an answer kept, or why the answer was not. */
export type AnswerDecision =
  | {
      readonly ok: true;
      readonly turns: readonly OneToOneTurn[];
      /** Whether this answer closed the one-to-one: the draft starts from `turns`. */
      readonly closed: boolean;
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * Keep an employee answer, when the conversation still ends where the answer began: an answer
 * to a reply the conversation has moved past (a second room, a room that asked again) is not
 * kept over the one that stands. The same answer offered twice is kept once; an answer under the
 * id of another kept turn, or past `MAX_KEPT_TURNS`, is not kept. A closing line is kept only on
 * an earned close (`closeEarned`), whatever the route decided.
 *
 * @param now - When the answer is kept, in milliseconds.
 */
export function decideAnswer(
  turns: readonly OneToOneTurn[],
  answer: OfferedAnswer,
  now: number,
): AnswerDecision {
  const last = turns.at(-1);
  if (last?.speaker === 'employee' && last.id === answer.id) {
    return { ok: true, turns, closed: false };
  }
  if (isClosed(turns)) return { ok: false, refusal: 'The one-to-one is already over.' };
  if (answeringOf(turns) !== answer.answering || (answer.answering === null && last)) {
    return { ok: false, refusal: MOVED_ON_REFUSAL };
  }
  // An id a kept turn carries would draw two turns under one key and answer as either.
  if (turns.some((turn: OneToOneTurn): boolean => turn.id === answer.id)) {
    return { ok: false, refusal: "Day0's answer came back under an id already in use. Ask again." };
  }
  if (turns.length >= MAX_KEPT_TURNS) return { ok: false, refusal: TURN_BOUND_REFUSAL };
  if (
    !answer.id ||
    answer.id.length > TURN_ID_MAX_CHARS ||
    answer.text.length > ANSWER_MAX_CHARS ||
    (answer.closingLine?.length ?? 0) > ANSWER_MAX_CHARS
  ) {
    return { ok: false, refusal: "Day0's answer was too long to keep. Ask again." };
  }
  const topicIndex =
    Number.isInteger(answer.topicIndex) &&
    answer.topicIndex >= 0 &&
    answer.topicIndex < DAY_ONE_TOPIC_COUNT
      ? answer.topicIndex
      : undefined;
  const closes = answer.closingLine !== undefined && closeEarned(turns);
  const kept: OneToOneTurn = {
    id: answer.id,
    speaker: 'employee',
    text: answer.text,
    at: now,
    ...(topicIndex === undefined ? {} : { topicIndex }),
    ...(closes ? { closingLine: answer.closingLine } : {}),
  };
  return { ok: true, turns: [...turns, kept], closed: closes };
}

/**
 * Which conversation a session holds: a stamp the session moves on each time it sets one aside
 * (`voice.restart`, and a switch away from chat), so a write composed against the conversation
 * before it (an answer in flight, a Finish or a kept draft from a room still drawing the old one)
 * is refused rather than kept on the new one. A session from before the stamp holds its first.
 */
export function conversationOf(session: { readonly conversation?: number }): number {
  return session.conversation ?? 0;
}

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

/**
 * The kept turns as the chat hook holds messages, so a reopened room draws them as the live
 * conversation drew them: the question number on an employee turn and its closing line as the
 * close's tool part.
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
      ...(turn.topicIndex === undefined ? {} : { metadata: { topicIndex: turn.topicIndex } }),
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
 * The most turns one conversation keeps: thirty exchanges, four times the seven questions, well
 * inside a session row's size. A one-to-one that reaches it is finished from what was said.
 */
export const MAX_KEPT_TURNS = 60;

/** What a room asks of the session before its turn is put to the employee. */
export type TurnRequest =
  | { readonly kind: 'open' }
  | { readonly kind: 'reply'; readonly id: string; readonly text: string }
  | { readonly kind: 'ask-again' };

/** The conversation a turn is answered from, or why the session will not take the turn. */
export type TurnDecision =
  | {
      readonly ok: true;
      readonly turns: readonly OneToOneTurn[];
      /** The manager turn the employee answers, or null for the opening. */
      readonly answering: string | null;
    }
  | { readonly ok: false; readonly refusal: string };

/** The manager's last turn, which the employee's next answer answers. */
function answeringOf(turns: readonly OneToOneTurn[]): string | null {
  const last = turns.at(-1);
  return last?.speaker === 'manager' ? last.id : null;
}

/**
 * Decide a turn against the kept conversation, which the session's own copy decides and never
 * the room's: a reopened or second room with a stale copy cannot fork it.
 *
 * - `open`: the employee's opening, only on a conversation with nothing kept yet.
 * - `reply`: the manager's reply, kept before the employee is asked; one the session already
 *   holds as its last turn (a send repeated after a lost connection) is taken as it stands.
 * - `ask-again`: the employee's last turn is asked for again; an answer the session kept after the
 *   manager's last reply is set aside first, as the room sets it aside.
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
        ? { ok: true, turns, answering: null }
        : { ok: false, refusal: 'The one-to-one has already begun. Reload to carry on.' };
    case 'reply': {
      const last = turns.at(-1);
      if (last?.speaker === 'manager' && last.id === request.id) {
        return { ok: true, turns, answering: last.id };
      }
      const text = request.text.trim();
      if (!text) return { ok: false, refusal: 'A reply needs some words.' };
      if (text.length > REPLY_MAX_CHARS) {
        return { ok: false, refusal: `A reply is at most ${REPLY_MAX_CHARS} characters.` };
      }
      if (last === undefined) {
        return { ok: false, refusal: 'The one-to-one has not opened yet.' };
      }
      if (last.speaker === 'manager') {
        return { ok: false, refusal: 'Day0 has not answered your last reply yet.' };
      }
      if (turns.length >= MAX_KEPT_TURNS) {
        return {
          ok: false,
          refusal: 'The one-to-one is as long as it can be. Finish it to draft the charter.',
        };
      }
      const reply: OneToOneTurn = { id: request.id, speaker: 'manager', text, at: now };
      return { ok: true, turns: [...turns, reply], answering: reply.id };
    }
    case 'ask-again': {
      const kept = turns.at(-1)?.speaker === 'employee' ? turns.slice(0, -1) : turns;
      return { ok: true, turns: kept, answering: answeringOf(kept) };
    }
    default: {
      const unknown: never = request;
      throw new Error(`unhandled turn request ${String(unknown)}`);
    }
  }
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
 * kept over the one that stands. The same answer offered twice is kept once. A closing line is
 * kept only on an earned close (`closeEarned`), whatever the route decided.
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
    return {
      ok: false,
      refusal: 'The one-to-one moved on in another window. Reload to carry on.',
    };
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

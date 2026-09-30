import type { UIMessage } from 'ai';
import { INIT_PROMPT } from './day-one-turn';
import {
  isKeptAnswer,
  uiMessagesOf,
  type OneToOneTurn,
  type SentReply,
} from './one-to-one-conversation';

/**
 * The chat room's side of the kept conversation: which of the turns it drew the session holds,
 * what it would ask the session for next, and when it has fallen behind the session.
 *
 * The room draws every turn it sends and every turn it is streamed, including a reply whose send
 * never reached the session and an answer that failed or was cut off. The session holds only what
 * it kept. These read the one against the other, so a reply is filed under the question the room
 * drew, a reply the session never received is delivered before anything else is, and a room that
 * another window has moved on is drawn again from the session.
 */

/** The words of a message's text parts, joined. */
export function textOf(message: Pick<UIMessage, 'parts'>): string {
  return message.parts.map((part): string => (part.type === 'text' ? part.text : '')).join('');
}

/** Whether the message is a reply the manager wrote: a user turn other than the priming turn. */
function isReply(message: UIMessage): boolean {
  return message.role === 'user' && textOf(message).trim() !== INIT_PROMPT;
}

/** Where the room stands: the question it last drew that the session kept, and its replies since. */
export interface RoomPosition {
  /** The last employee turn the room drew that the session holds; null before the opening. */
  readonly question: string | null;
  /** The manager's replies the room drew after that question, oldest first. */
  readonly replies: readonly SentReply[];
}

/**
 * Read where the room stands off its messages. An answer that failed, was cut off or was refused
 * is not a question the room can answer: the replies drawn either side of it answer the question
 * before it, as the session holds them.
 */
export function roomPosition(messages: readonly UIMessage[]): RoomPosition {
  const asked = messages.findLastIndex(isKeptAnswer);
  return {
    question: asked === -1 ? null : messages[asked].id,
    replies: messages
      .slice(asked + 1)
      .filter(isReply)
      .map((message): SentReply => ({ id: message.id, text: textOf(message) })),
  };
}

/**
 * The replies the room shows that the session does not hold: sends that never reached it. They
 * are always the room's last replies, since a reply the session kept is answered after it.
 */
export function unkeptReplies(
  messages: readonly UIMessage[],
  turns: readonly OneToOneTurn[],
): readonly SentReply[] {
  const held = new Set(turns.map((turn: OneToOneTurn): string => turn.id));
  return roomPosition(messages).replies.filter((reply: SentReply): boolean => !held.has(reply.id));
}

/**
 * Whether the session has moved past the room's copy: it holds a turn the room has not drawn as
 * kept, another window's reply or answer, or an answer whose stream the room lost after the
 * session kept it. A room ahead only by what it sent and the session never received is not
 * behind; nor is a room whose kept answer the session has not reported yet, so a subscription a
 * moment behind the stream never draws a turn away and back.
 */
export function roomBehind(
  messages: readonly UIMessage[],
  turns: readonly OneToOneTurn[],
): boolean {
  const drawn = new Map(messages.map((message): [string, UIMessage] => [message.id, message]));
  return turns.some((turn: OneToOneTurn): boolean => {
    const message = drawn.get(turn.id);
    if (!message) return true;
    return turn.speaker === 'employee' && !isKeptAnswer(message);
  });
}

/**
 * Whether the session set aside an answer this room drew as kept: the room's own subscription once
 * reported it (`seen`), the session holds it no longer, and every turn the session holds is one the
 * room drew, in the same order. A query's results never go backwards, so an answer seen and then
 * gone was discarded (another window asked again, and its new answer never came), never merely
 * not reported yet: the room may draw the session again without drawing a turn away and back (the
 * pre-tag pass's minor 7). An answer discarded before the subscription ever reported it is not
 * seen here, and that room is still refused until it reloads or the conversation moves on.
 *
 * @param messages - The room's conversation.
 * @param turns - What the session keeps.
 * @param seen - Every turn id the room's subscription has reported for this conversation.
 */
export function answerSetAside(
  messages: readonly UIMessage[],
  turns: readonly OneToOneTurn[],
  seen: ReadonlySet<string>,
): boolean {
  const answer = messages.findLast(
    (message: UIMessage): boolean => message.role === 'assistant' && isKeptAnswer(message),
  );
  if (!answer || !seen.has(answer.id) || turns.some((turn) => turn.id === answer.id)) return false;
  const drawnAt = new Map(messages.map((message, index): [string, number] => [message.id, index]));
  let previous = -1;
  for (const turn of turns) {
    const at = drawnAt.get(turn.id);
    if (at === undefined || at <= previous) return false;
    previous = at;
  }
  return true;
}

/** The room drawn again from the session, and what it had not sent, for the composer. */
export interface Redrawn {
  readonly messages: UIMessage[];
  /** The words of the replies the room showed that the session never received, oldest first. */
  readonly unsent: readonly string[];
}

/**
 * Draw the room again from the kept conversation. A reply the room showed that never reached the
 * session is not filed under a question the manager has not seen yet; its words go back to the
 * composer instead, so nothing the manager wrote is dropped.
 */
export function redrawn(messages: readonly UIMessage[], turns: readonly OneToOneTurn[]): Redrawn {
  return {
    messages: uiMessagesOf(turns),
    unsent: unkeptReplies(messages, turns).map((reply: SentReply): string => reply.text),
  };
}

/**
 * The text the room keeps as the reply being typed: the replies it shows that the session never
 * received, then the composer's field. A room closed before they are delivered reopens with them
 * all in the composer, so the draft keeper never drops one.
 */
export function replyInProgress(unsent: readonly SentReply[], field: string): string {
  return [...unsent.map((reply: SentReply): string => reply.text), field]
    .filter((text: string): boolean => text.trim() !== '')
    .join('\n\n');
}

/** The id of the session's last kept reply, which a kept draft follows; null before the first. */
export function lastKeptReply(turns: readonly OneToOneTurn[]): string | null {
  return turns.findLast((turn: OneToOneTurn): boolean => turn.speaker === 'manager')?.id ?? null;
}

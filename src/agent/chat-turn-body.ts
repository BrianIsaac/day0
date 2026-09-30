import { MAX_KEPT_TURNS, type SentReply, type TurnRequest } from './one-to-one-conversation';

/** A reply's id and words, when the value carries both. */
function sentReplyOf(value: unknown): SentReply | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = 'id' in value ? value.id : undefined;
  const text = 'text' in value ? value.text : undefined;
  return typeof id === 'string' && id !== '' && typeof text === 'string' ? { id, text } : undefined;
}

/**
 * The replies a turn carries, oldest first, when every one is a reply. More than a conversation
 * can keep reads as none: the session would refuse them, and the body is not read further.
 */
function sentRepliesOf(value: unknown): readonly SentReply[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_KEPT_TURNS) return undefined;
  const replies = value.map(sentReplyOf);
  return replies.every((reply): reply is SentReply => reply !== undefined) ? replies : undefined;
}

/** A string or null, the shape of a turn id a request may leave out; anything else is undefined. */
function turnIdOrNull(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

/**
 * What the chat room posts for one turn of the one-to-one: the employee whose one-to-one it is,
 * who the manager is, and the turn itself. The room sends no history and names no session; the
 * employee's held session keeps the conversation.
 */
export interface ChatTurnBody {
  readonly agentId: string;
  readonly bossLabel: string;
  readonly request: TurnRequest;
}

/** The turn a body asks for, when it is one of the three shapes; anything else reads as none. */
function turnRequestOf(value: unknown): TurnRequest | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  const question = turnIdOrNull('question' in value ? value.question : undefined);
  const replies = sentRepliesOf('replies' in value ? value.replies : undefined);
  switch (value.kind) {
    case 'open':
      return { kind: 'open' };
    case 'ask-again': {
      const discarding = turnIdOrNull('discarding' in value ? value.discarding : undefined);
      if (question === undefined || replies === undefined || discarding === undefined) {
        return undefined;
      }
      return { kind: 'ask-again', question, replies, discarding };
    }
    case 'reply':
      return question === undefined || replies === undefined || replies.length === 0
        ? undefined
        : { kind: 'reply', question, replies };
    default:
      return undefined;
  }
}

/**
 * Read a chat turn's body, or nothing when it is not one. The manager's label defaults to the
 * one the route has always used.
 */
export function chatTurnBodyOf(value: unknown): ChatTurnBody | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const agentId = 'agentId' in value ? value.agentId : undefined;
  const request = turnRequestOf('request' in value ? value.request : undefined);
  if (typeof agentId !== 'string' || agentId === '' || !request) return undefined;
  const bossLabel = 'bossLabel' in value ? value.bossLabel : undefined;
  return {
    agentId,
    bossLabel: typeof bossLabel === 'string' && bossLabel.trim() ? bossLabel : 'there',
    request,
  };
}

/**
 * Whether a body that is not a chat turn was posted by a room older than the route: one that
 * sent its whole history (`messages`, before the session kept the conversation), or a turn in the
 * shape before a reply named its question (a `reply` with an `id` and no `replies`, an ask-again
 * with a `reply`). Such a room can never be answered, so it is told to reload rather than offered
 * an Ask again that cannot succeed; any other body that is not a turn is simply malformed.
 */
export function isOutdatedTurnBody(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if ('messages' in value && Array.isArray(value.messages)) return true;
  const request = 'request' in value ? value.request : undefined;
  if (typeof request !== 'object' || request === null || 'replies' in request) return false;
  const kind = 'kind' in request ? request.kind : undefined;
  return (kind === 'reply' && 'id' in request) || (kind === 'ask-again' && 'reply' in request);
}

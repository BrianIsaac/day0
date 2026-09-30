import type { SentReply, TurnRequest } from './one-to-one-conversation';

/** A reply's id and words, when the value carries both. */
function sentReplyOf(value: unknown): SentReply | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id = 'id' in value ? value.id : undefined;
  const text = 'text' in value ? value.text : undefined;
  return typeof id === 'string' && id !== '' && typeof text === 'string' ? { id, text } : undefined;
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
  switch (value.kind) {
    case 'open':
      return { kind: 'open' };
    case 'ask-again': {
      const reply = 'reply' in value ? value.reply : undefined;
      const discarding = 'discarding' in value ? value.discarding : undefined;
      const sent = reply === null ? null : sentReplyOf(reply);
      if (sent === undefined || (discarding !== null && typeof discarding !== 'string')) {
        return undefined;
      }
      return { kind: 'ask-again', reply: sent, discarding };
    }
    case 'reply': {
      const sent = sentReplyOf(value);
      return sent ? { kind: 'reply', ...sent } : undefined;
    }
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

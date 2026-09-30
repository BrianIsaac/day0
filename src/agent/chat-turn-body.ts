import type { TurnRequest } from './one-to-one-conversation';

/**
 * What the chat room posts for one turn of the one-to-one: the session the turn belongs to, who
 * the manager is, and the turn itself. The room sends no history; the session holds it.
 */
export interface ChatTurnBody {
  readonly sessionId: string;
  readonly bossLabel: string;
  readonly request: TurnRequest;
}

/** The turn a body asks for, when it is one of the three shapes; anything else reads as none. */
function turnRequestOf(value: unknown): TurnRequest | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  switch (value.kind) {
    case 'open':
      return { kind: 'open' };
    case 'ask-again':
      return { kind: 'ask-again' };
    case 'reply':
      return 'id' in value &&
        typeof value.id === 'string' &&
        value.id !== '' &&
        'text' in value &&
        typeof value.text === 'string'
        ? { kind: 'reply', id: value.id, text: value.text }
        : undefined;
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
  const sessionId = 'sessionId' in value ? value.sessionId : undefined;
  const request = turnRequestOf('request' in value ? value.request : undefined);
  if (typeof sessionId !== 'string' || sessionId === '' || !request) return undefined;
  const bossLabel = 'bossLabel' in value ? value.bossLabel : undefined;
  return {
    sessionId,
    bossLabel: typeof bossLabel === 'string' && bossLabel.trim() ? bossLabel : 'there',
    request,
  };
}

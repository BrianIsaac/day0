import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import * as room from '../../../../../app/agent/[agentId]/ChatRoom';
import {
  REPLY_DRAFT_KEEP_MS,
  askAgain,
  chatTurnTransport,
  composerLocked,
  errorLine,
  turnFailure,
  turnRequestFor,
} from '../../../../../app/agent/[agentId]/one-to-one/use-one-to-one-session';

/**
 * The one-to-one's session wiring moved out of `ChatRoom` (the second review's m11), behaviour
 * unchanged: the room's own tests drive it through the room, and read its helpers where they were.
 * This mirror holds the move itself and the request a turn names.
 */

function said(id: string, role: 'user' | 'assistant', text: string, kept = true): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    ...(kept && role === 'assistant' ? { metadata: { kept: true } } : {}),
  } as UIMessage;
}

describe('the one-to-one session wiring (second review m11)', (): void => {
  it('is what the room still exports, the same functions and the same keeper rest', (): void => {
    expect(room.turnRequestFor).toBe(turnRequestFor);
    expect(room.askAgain).toBe(askAgain);
    expect(room.chatTurnTransport).toBe(chatTurnTransport);
    expect(room.composerLocked).toBe(composerLocked);
    expect(room.errorLine).toBe(errorLine);
    expect(room.turnFailure).toBe(turnFailure);
    expect(room.REPLY_DRAFT_KEEP_MS).toBe(REPLY_DRAFT_KEEP_MS);
  });

  it('opens the one-to-one on a room with nothing said, and asks again for the answer it set aside', (): void => {
    expect(turnRequestFor([], 'submit-message', null)).toEqual({ kind: 'open' });
    const messages = [said('e0', 'assistant', 'Why this hire?'), said('m0', 'user', 'The close.')];
    expect(turnRequestFor(messages, 'regenerate-message', null)).toMatchObject({
      kind: 'ask-again',
      discarding: null,
    });
  });
});

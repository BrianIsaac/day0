import { describe, expect, it } from 'vitest';
import { chatTurnBodyOf } from '../../../src/agent/chat-turn-body';

describe('a chat turn body', (): void => {
  it('reads the session, the manager and each of the three turns', (): void => {
    expect(
      chatTurnBodyOf({ sessionId: 's1', bossLabel: 'Sam', request: { kind: 'open' } }),
    ).toEqual({ sessionId: 's1', bossLabel: 'Sam', request: { kind: 'open' } });
    expect(
      chatTurnBodyOf({ sessionId: 's1', request: { kind: 'reply', id: 'm1', text: 'Yes.' } }),
    ).toEqual({
      sessionId: 's1',
      bossLabel: 'there',
      request: { kind: 'reply', id: 'm1', text: 'Yes.' },
    });
    expect(chatTurnBodyOf({ sessionId: 's1', request: { kind: 'ask-again', extra: 1 } })).toEqual({
      sessionId: 's1',
      bossLabel: 'there',
      request: { kind: 'ask-again' },
    });
  });

  it('reads nothing from a body without a session, a known turn, or a reply id', (): void => {
    for (const value of [
      null,
      'open',
      { request: { kind: 'open' } },
      { sessionId: '', request: { kind: 'open' } },
      { sessionId: 's1', request: { kind: 'close' } },
      { sessionId: 's1', request: { kind: 'reply', text: 'Yes.' } },
      { sessionId: 's1', request: { kind: 'reply', id: 'm1', text: 3 } },
      { sessionId: 's1', messages: [] },
    ]) {
      expect(chatTurnBodyOf(value)).toBeUndefined();
    }
  });
});

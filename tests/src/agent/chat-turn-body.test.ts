import { describe, expect, it } from 'vitest';
import { chatTurnBodyOf } from '../../../src/agent/chat-turn-body';

describe('a chat turn body', (): void => {
  it('reads the employee, the manager and each of the three turns', (): void => {
    expect(chatTurnBodyOf({ agentId: 'a1', bossLabel: 'Sam', request: { kind: 'open' } })).toEqual({
      agentId: 'a1',
      bossLabel: 'Sam',
      request: { kind: 'open' },
    });
    expect(
      chatTurnBodyOf({ agentId: 'a1', request: { kind: 'reply', id: 'm1', text: 'Yes.' } }),
    ).toEqual({
      agentId: 'a1',
      bossLabel: 'there',
      request: { kind: 'reply', id: 'm1', text: 'Yes.' },
    });
    expect(chatTurnBodyOf({ agentId: 'a1', request: { kind: 'ask-again', extra: 1 } })).toEqual({
      agentId: 'a1',
      bossLabel: 'there',
      request: { kind: 'ask-again' },
    });
  });

  it('reads nothing from a body without an employee, a known turn, or a reply id', (): void => {
    for (const value of [
      null,
      'open',
      { request: { kind: 'open' } },
      { agentId: '', request: { kind: 'open' } },
      { agentId: 'a1', request: { kind: 'close' } },
      { agentId: 'a1', request: { kind: 'reply', text: 'Yes.' } },
      { agentId: 'a1', request: { kind: 'reply', id: 'm1', text: 3 } },
      { agentId: 'a1', messages: [] },
    ]) {
      expect(chatTurnBodyOf(value)).toBeUndefined();
    }
  });
});

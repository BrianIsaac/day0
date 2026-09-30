import { describe, expect, it } from 'vitest';
import { MAX_KEPT_TURNS } from '../../../src/agent/one-to-one-conversation';
import { chatTurnBodyOf } from '../../../src/agent/chat-turn-body';

describe('a chat turn body', (): void => {
  it('reads the employee, the manager and each of the three turns', (): void => {
    expect(chatTurnBodyOf({ agentId: 'a1', bossLabel: 'Sam', request: { kind: 'open' } })).toEqual({
      agentId: 'a1',
      bossLabel: 'Sam',
      request: { kind: 'open' },
    });
    expect(
      chatTurnBodyOf({
        agentId: 'a1',
        request: {
          kind: 'reply',
          question: 'e1',
          replies: [
            { id: 'm1', text: 'Failed to send.' },
            { id: 'm2', text: 'Yes.' },
          ],
        },
      }),
    ).toEqual({
      agentId: 'a1',
      bossLabel: 'there',
      request: {
        kind: 'reply',
        question: 'e1',
        replies: [
          { id: 'm1', text: 'Failed to send.' },
          { id: 'm2', text: 'Yes.' },
        ],
      },
    });
    expect(
      chatTurnBodyOf({
        agentId: 'a1',
        request: {
          kind: 'ask-again',
          question: 'e0',
          replies: [{ id: 'm1', text: 'Yes.' }],
          discarding: 'e1',
          x: 1,
        },
      }),
    ).toEqual({
      agentId: 'a1',
      bossLabel: 'there',
      request: {
        kind: 'ask-again',
        question: 'e0',
        replies: [{ id: 'm1', text: 'Yes.' }],
        discarding: 'e1',
      },
    });
    expect(
      chatTurnBodyOf({
        agentId: 'a1',
        request: { kind: 'ask-again', question: null, replies: [], discarding: null },
      })?.request,
    ).toEqual({ kind: 'ask-again', question: null, replies: [], discarding: null });
  });

  it('reads nothing from a body without an employee, a known turn, its question or its replies', (): void => {
    const reply = { id: 'm1', text: 'Yes.' };
    for (const value of [
      null,
      'open',
      { request: { kind: 'open' } },
      { agentId: '', request: { kind: 'open' } },
      { agentId: 'a1', request: { kind: 'close' } },
      { agentId: 'a1', request: { kind: 'reply', question: 'e0', replies: [] } },
      { agentId: 'a1', request: { kind: 'reply', replies: [reply] } },
      { agentId: 'a1', request: { kind: 'reply', question: 'e0', replies: [{ text: 'Yes.' }] } },
      { agentId: 'a1', request: { kind: 'reply', question: 7, replies: [reply] } },
      { agentId: 'a1', request: { kind: 'reply', id: 'm1', text: 'Yes.' } },
      {
        agentId: 'a1',
        request: {
          kind: 'reply',
          question: 'e0',
          replies: Array.from({ length: MAX_KEPT_TURNS + 1 }, (_, i) => ({
            id: `m${i}`,
            text: 'a',
          })),
        },
      },
      { agentId: 'a1', request: { kind: 'ask-again' } },
      { agentId: 'a1', request: { kind: 'ask-again', question: null, replies: [], discarding: 4 } },
      { agentId: 'a1', request: { kind: 'ask-again', reply: null, discarding: null } },
      { agentId: 'a1', messages: [] },
    ]) {
      expect(chatTurnBodyOf(value)).toBeUndefined();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_KEPT_TURNS } from '../../../src/agent/one-to-one-conversation';
import {
  chatTurnBodyOf,
  isOutdatedTurnBody,
  reorientationTalkBodyOf,
} from '../../../src/agent/chat-turn-body';

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

describe('a body from a room older than the route', (): void => {
  it('is one that sent its history, or a turn in a shape the route no longer takes', (): void => {
    expect(
      isOutdatedTurnBody({ id: 'one-to-one-a1', messages: [], trigger: 'submit-message' }),
    ).toBe(true);
    expect(
      isOutdatedTurnBody({ agentId: 'a1', request: { kind: 'reply', id: 'm1', text: 'Yes.' } }),
    ).toBe(true);
    expect(
      isOutdatedTurnBody({
        agentId: 'a1',
        request: { kind: 'ask-again', reply: null, discarding: null },
      }),
    ).toBe(true);
    // Merely malformed is not outdated: it stays a 400 (second pass minor 6).
    for (const malformed of [
      { agentId: 'a1' },
      { agentId: '', request: { kind: 'open' } },
      { request: { kind: 'open' } },
      { agentId: 'a1', request: { kind: 'reply', question: 'e0', replies: [] } },
      { agentId: 'a1', request: { kind: 'bogus' } },
      { agentId: 'a1', request: [] },
    ]) {
      expect(isOutdatedTurnBody(malformed), JSON.stringify(malformed)).toBe(false);
    }
    expect(isOutdatedTurnBody(null)).toBe(false);
    expect(isOutdatedTurnBody('messages')).toBe(false);
  });
});

describe('a reorientation talk turn body (16-D)', (): void => {
  it('reads the card and each of the one-to-one’s three turns', (): void => {
    expect(reorientationTalkBodyOf({ reorientationId: 'r1', request: { kind: 'open' } })).toEqual({
      reorientationId: 'r1',
      request: { kind: 'open' },
    });
    const replies = [{ id: 'm0', text: 'Yes, send committee-deck drafts to Priya first.' }];
    expect(
      reorientationTalkBodyOf({
        reorientationId: 'r1',
        request: { kind: 'reply', question: 'e0', replies },
      }),
    ).toEqual({ reorientationId: 'r1', request: { kind: 'reply', question: 'e0', replies } });
    expect(
      reorientationTalkBodyOf({
        reorientationId: 'r1',
        request: { kind: 'ask-again', question: 'e0', replies, discarding: 'e1' },
      }),
    ).toEqual({
      reorientationId: 'r1',
      request: { kind: 'ask-again', question: 'e0', replies, discarding: 'e1' },
    });
  });

  it('reads a finish, with the replies it carries or with none', (): void => {
    expect(
      reorientationTalkBodyOf({
        reorientationId: 'r1',
        request: { kind: 'finish', question: 'e1', replies: [] },
      }),
    ).toEqual({ reorientationId: 'r1', request: { kind: 'finish', question: 'e1', replies: [] } });
  });

  it('is none for a body that names no card or carries no turn it takes', (): void => {
    for (const malformed of [
      { request: { kind: 'open' } },
      { reorientationId: '', request: { kind: 'open' } },
      { reorientationId: 'r1' },
      { reorientationId: 'r1', request: { kind: 'finish', question: 'e1' } },
      { reorientationId: 'r1', request: { kind: 'reply', question: 'e0', replies: [] } },
      { reorientationId: 'r1', request: { kind: 'bogus' } },
      { agentId: 'a1', bossLabel: 'Sam', request: { kind: 'open' } },
    ]) {
      expect(reorientationTalkBodyOf(malformed), JSON.stringify(malformed)).toBeUndefined();
    }
  });

  it('leaves the day-one reader as it was: a finish is no turn of the one-to-one', (): void => {
    expect(
      chatTurnBodyOf({ agentId: 'a1', request: { kind: 'finish', question: 'e1', replies: [] } }),
    ).toBeUndefined();
  });
});

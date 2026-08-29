import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import {
  DECISION_ID_ALPHABET,
  decisionIdFromBytes,
  decisionRequestText,
  managerMessageAction,
  parseDecisionReply,
} from '../../../src/work/manager-channel';
import type { MockAction } from '../../../src/work/types';

const slack: SurfaceRecord = {
  slug: 'team-chat',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: Date.now(),
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: ['conversations.history', 'chat.postMessage'],
  toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text', 'thread_ts'] }],
  managerDmChannelId: 'D0MANAGER',
};

describe('manager channel decision requests', (): void => {
  it('draws every symbol with the same probability from random bytes', (): void => {
    // 256 is not a multiple of 31: a plain modulo makes the first eight symbols
    // 12.5% likelier than the rest. Bytes at or above 248 must be skipped.
    const alphabet = DECISION_ID_ALPHABET;
    expect(alphabet).toHaveLength(31);
    expect(decisionIdFromBytes(new Uint8Array([248, 255, 0, 1, 2, 3, 4, 5, 250]))).toBe(
      alphabet.slice(0, 6),
    );
    expect(decisionIdFromBytes(new Uint8Array([247, 30, 31, 61, 62, 93, 200]))).toBe(
      [alphabet[247 % 31], alphabet[30], alphabet[0], alphabet[30], alphabet[0], alphabet[0]].join(''),
    );
    expect(() => decisionIdFromBytes(new Uint8Array([248, 249, 250, 251, 252, 253, 1, 2, 3]))).toThrow(
      /random bytes/,
    );
  });

  it('derives a six-character token from random bytes without ambiguous characters', (): void => {
    const id = decisionIdFromBytes(Uint8Array.from([0, 1, 2, 3, 4, 5]));
    expect(id).toBe('234567');
    expect(id).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
  });

  it('builds plan and action requests with the literal reply words', (): void => {
    expect(
      decisionRequestText({
        agentName: 'ops worker',
        title: 'Close August',
        id: 'ab3xyz',
        kind: 'plan',
        plan: { summary: 'Comment, then close the issue.' },
      }),
    ).toBe(
      'ops worker needs your decision on “Close August”.\n\nPlan: Comment, then close the issue.\n\nReply “approve ab3xyz” or “reject ab3xyz <reason>”.',
    );

    const held: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'team-chat',
        method: 'POST',
        path: 'chat.postMessage',
        body: JSON.stringify({ channel: 'C0PUBLIC', text: 'Close completed.' }),
      },
    };
    expect(
      decisionRequestText({
        agentName: 'ops worker',
        title: 'Close August',
        id: 'ab3xyz',
        kind: 'actions',
        actions: [held],
        heldIndexes: [0],
        surfaces: [slack],
      }),
    ).toContain(
      'Held actions:\n1. Post to Slack channel C0PUBLIC: "Close completed."\n\nReply “approve ab3xyz” or “reject ab3xyz <reason>”.',
    );
  });

  it('tells the manager a second request closes the run they already approved', (): void => {
    const held: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"iss-1","state":"Done"}' },
    };
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Refresh the Looker pipeline tile',
      id: 'ab3xyz',
      kind: 'actions',
      actions: [held],
      heldIndexes: [0],
      surfaces: [slack],
      closingPhase: true,
    });
    expect(text).toContain(
      'Closing actions, written from the results of the actions already applied in this run:\n1. ',
    );
    expect(text).not.toContain('Held actions:');
    expect(text).toContain('Reply “approve ab3xyz” or “reject ab3xyz <reason>”.');
  });

  it('uses the connected chat surface adapter path for HTTP and MCP', (): void => {
    expect(managerMessageAction(slack, 'Decide this.')).toEqual({
      tool: 'http.request',
      args: {
        surface: 'team-chat',
        method: 'POST',
        path: 'chat.postMessage',
        headersJson: JSON.stringify({
          Authorization: 'Bearer {{secret}}',
          'Content-Type': 'application/json; charset=utf-8',
        }),
        body: JSON.stringify({ channel: 'D0MANAGER', text: 'Decide this.' }),
      },
    });

    expect(
      managerMessageAction(
        {
          ...slack,
          path: 'mcp',
          toolAllowlist: ['send_message'],
          toolArguments: [{ tool: 'send_message', arguments: ['conversationId', 'content'] }],
        },
        'Decide this.',
      ),
    ).toEqual({
      tool: 'mcp.call',
      args: {
        surface: 'team-chat',
        tool: 'send_message',
        toolArgsJson: JSON.stringify({ conversationId: 'D0MANAGER', content: 'Decide this.' }),
      },
    });
  });

  it('parses only bounded approve and reject prefixes', (): void => {
    expect(parseDecisionReply('  APPROVE   ab3xyz  ')).toEqual({
      verb: 'approve',
      id: 'ab3xyz',
    });
    expect(parseDecisionReply('reject ab3xyz   run the revised close checklist')).toEqual({
      verb: 'reject',
      id: 'ab3xyz',
      reason: 'run the revised close checklist',
    });
    const longReason = 'x'.repeat(250);
    expect(parseDecisionReply(`reject ab3xyz ${longReason}`)).toEqual({
      verb: 'reject',
      id: 'ab3xyz',
      reason: 'x'.repeat(200),
    });
    expect(parseDecisionReply('please approve ab3xyz')).toBeUndefined();
    expect(parseDecisionReply('approve sequential-123')).toBeUndefined();
    expect(parseDecisionReply('approve ab')).toBeUndefined();
  });

  it('accepts the quoted form the request shows, and ordinary punctuation around the command', (): void => {
    // The request says: Reply “approve ab3xyz” - a manager who copies it keeps the quotes.
    expect(parseDecisionReply('“approve ab3xyz”')).toEqual({ verb: 'approve', id: 'ab3xyz' });
    expect(parseDecisionReply('"approve ab3xyz"')).toEqual({ verb: 'approve', id: 'ab3xyz' });
    expect(parseDecisionReply('`approve ab3xyz`')).toEqual({ verb: 'approve', id: 'ab3xyz' });
    expect(parseDecisionReply('Approve ab3xyz.')).toEqual({ verb: 'approve', id: 'ab3xyz' });
    expect(parseDecisionReply('approve ab3xyz!')).toEqual({ verb: 'approve', id: 'ab3xyz' });
    expect(parseDecisionReply('“reject ab3xyz not this week”')).toEqual({
      verb: 'reject',
      id: 'ab3xyz',
      reason: 'not this week',
    });
    // Still bounded: prose before the verb is not a command; prose after an approve
    // never was one either (it is ignored, as before).
    expect(parseDecisionReply('“please approve ab3xyz”')).toBeUndefined();
    expect(parseDecisionReply('approve ab3xyz thanks')).toEqual({ verb: 'approve', id: 'ab3xyz' });
  });
});

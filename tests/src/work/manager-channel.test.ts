import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import {
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
});

import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import {
  askedFor,
  DECISION_ID_ALPHABET,
  decisionIdFromBytes,
  decisionRequestText,
  MANAGER_FEEDBACK_MAX_CHARS,
  MANAGER_MESSAGE_MAX_CHARS,
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
      [alphabet[247 % 31], alphabet[30], alphabet[0], alphabet[30], alphabet[0], alphabet[0]].join(
        '',
      ),
    );
    expect(() =>
      decisionIdFromBytes(new Uint8Array([248, 249, 250, 251, 252, 253, 1, 2, 3])),
    ).toThrow(/random bytes/);
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
    // A plan with steps, risk and reversibility sends them, so the decision can be made from the message (P5-8).
    expect(
      decisionRequestText({
        agentName: 'ops worker',
        title: 'Close August',
        id: 'ab3xyz',
        kind: 'plan',
        plan: {
          summary: 'Comment, then close the issue.',
          steps: ['Add the audit comment to REVOPS-5.', 'Move REVOPS-5 to Done.'],
          riskNotes: 'Closing hides the ticket from the triage view.',
          reversibility: 'reversible',
        },
      }),
    ).toBe(
      [
        'ops worker needs your decision on “Close August”.',
        '',
        'Plan: Comment, then close the issue.',
        'Steps:',
        '1. Add the audit comment to REVOPS-5.',
        '2. Move REVOPS-5 to Done.',
        'Risk: Closing hides the ticket from the triage view.',
        'Reversibility: reversible',
        '',
        'Reply “approve ab3xyz” or “reject ab3xyz <reason>”.',
      ].join('\n'),
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

  it('says an approval covers every held action listed, and where to approve some (P5-8)', (): void => {
    const held: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_issue',
        toolArgsJson: '{"id":"iss-1","state":"Done"}',
      },
    };
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Close August',
      id: 'ab3xyz',
      kind: 'actions',
      actions: [held, held],
      heldIndexes: [0, 1],
      surfaces: [slack],
    });
    expect(text).toContain(
      '“approve ab3xyz” applies both actions listed; to approve only some, decide in day0.',
    );
  });

  it('keeps a long request inside one chat message, saying how many it left out', (): void => {
    const held: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'y'.repeat(400) }),
      },
    };
    const actions = Array.from({ length: 40 }, () => held);
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Close August',
      id: 'ab3xyz',
      kind: 'actions',
      actions,
      heldIndexes: actions.map((_, index) => index),
      surfaces: [slack],
    });
    expect(text.length).toBeLessThanOrEqual(MANAGER_MESSAGE_MAX_CHARS);
    expect(text).toMatch(/…and \d+ more held actions; the full list is in day0\./);
    expect(text).toContain('Reply “approve ab3xyz” or “reject ab3xyz <reason>”.');
  });

  it('tells the manager a second request closes the run they already approved', (): void => {
    const held: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_issue',
        toolArgsJson: '{"id":"iss-1","state":"Done"}',
      },
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
    // The reason is kept as the card keeps one, not cut at 200 (P5-9).
    const longReason = 'x'.repeat(1_200);
    expect(parseDecisionReply(`reject ab3xyz ${longReason}`)).toEqual({
      verb: 'reject',
      id: 'ab3xyz',
      reason: 'x'.repeat(MANAGER_FEEDBACK_MAX_CHARS),
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
    // Still bounded: prose before the verb is not a command. After an approve a
    // courtesy is ignored, but a condition is not an approval of everything (P5-9).
    expect(parseDecisionReply('“please approve ab3xyz”')).toBeUndefined();
    expect(parseDecisionReply('approve ab3xyz thanks')).toEqual({ verb: 'approve', id: 'ab3xyz' });
    expect(parseDecisionReply('approve ab3xyz, thank you!')).toEqual({
      verb: 'approve',
      id: 'ab3xyz',
    });
    expect(parseDecisionReply('approve ab3xyz but not the Done')).toBeUndefined();
    expect(parseDecisionReply('approve ab3xyz except the close')).toBeUndefined();
  });

  it('reads the forms a manager actually types around the command (P5-9, P8-6)', (): void => {
    const approved = { verb: 'approve', id: 'ab3xyz' };
    expect(parseDecisionReply('Approved ab3xyz')).toEqual(approved);
    expect(parseDecisionReply('approve: ab3xyz')).toEqual(approved);
    expect(parseDecisionReply('approve ab3xyz,')).toEqual(approved);
    expect(parseDecisionReply('*approve ab3xyz*')).toEqual(approved);
    expect(parseDecisionReply('_approve ab3xyz_')).toEqual(approved);
    expect(parseDecisionReply('> approve ab3xyz')).toEqual(approved);
    expect(parseDecisionReply('&gt; approve ab3xyz')).toEqual(approved);
    expect(parseDecisionReply('<@U0DAY0BOT> approve ab3xyz')).toEqual(approved);
    expect(parseDecisionReply('Rejected ab3xyz: not this week')).toEqual({
      verb: 'reject',
      id: 'ab3xyz',
      reason: 'not this week',
    });
    expect(parseDecisionReply('approve ab3xyz?')).toBeUndefined();
  });
});

describe('askedFor (wave 3 review M5)', (): void => {
  it('counts only an undecided request of the kind the row is parked on', (): void => {
    expect(askedFor({ kind: 'plan' }, 'plan-pending')).toBe(true);
    expect(askedFor({ kind: 'actions' }, 'actions-pending')).toBe(true);
    expect(askedFor(undefined, 'actions-pending')).toBe(false);
    expect(askedFor({ kind: 'plan', decidedAt: 2 }, 'actions-pending')).toBe(false);
    expect(askedFor({ kind: 'plan' }, 'actions-pending')).toBe(false);
    expect(askedFor({ kind: 'actions', decidedAt: 2 }, 'actions-pending')).toBe(false);
  });
});

describe('what a decision request says about its item (P8-6, U9 step 24)', (): void => {
  const close: MockAction = {
    tool: 'mcp.call',
    args: {
      surface: 'linear',
      tool: 'save_issue',
      toolArgsJson: '{"id":"REVOPS-7","state":"Done"}',
    },
  };

  it('names the ticket and its link under the heading', (): void => {
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Close August',
      id: 'ab3xyz',
      kind: 'plan',
      plan: { summary: 'Comment, then close the issue.' },
      item: {
        sourceCategory: 'ticket-queue',
        externalId: 'REVOPS-7',
        link: 'https://linear.app/day0/issue/REVOPS-7',
      },
    });
    expect(text.split('\n').slice(0, 2)).toEqual([
      'ops worker needs your decision on “Close August”.',
      'Ticket: REVOPS-7 https://linear.app/day0/issue/REVOPS-7',
    ]);
  });

  it('says where a chat ask was made and that its answer goes back to its thread', (): void => {
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Slack mention in #revops-asks',
      id: 'ab3xyz',
      kind: 'plan',
      plan: { summary: 'Answer the ask.' },
      item: {
        sourceCategory: 'event-stream',
        externalId: 'CASKS:1789757862.783069',
        link: 'https://app.slack.com/client/T0/CASKS/thread/CASKS-1789757862783069',
        replyTarget: { channel: 'CASKS', channelName: 'revops-asks' },
      },
    });
    expect(text.split('\n').slice(1, 3)).toEqual([
      'Asked in #revops-asks: https://app.slack.com/client/T0/CASKS/thread/CASKS-1789757862783069',
      'The answer to the ask goes to its thread in #revops-asks.',
    ]);
  });

  it('lists the rows the gate refused, with why, apart from the held ones', (): void => {
    const post: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'team-chat',
        method: 'POST',
        path: 'chat.postMessage',
        body: JSON.stringify({ channel: 'C0PUBLIC', text: 'Close completed.' }),
      },
    };
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Close August',
      id: 'ab3xyz',
      kind: 'actions',
      actions: [close, post],
      heldIndexes: [0],
      refused: [{ index: 1, reason: 'reply outside the source channel' }],
      surfaces: [slack],
    });
    expect(text).toContain(
      [
        'Refused by Day0’s gate, so not sent whatever you decide:',
        '- Post to Slack channel C0PUBLIC: "Close completed." (reply outside the source channel)',
        '',
        'Reply “approve ab3xyz” or “reject ab3xyz <reason>”.',
      ].join('\n'),
    );
    expect(text.indexOf('Held actions:')).toBeLessThan(text.indexOf('Refused by'));
  });
});

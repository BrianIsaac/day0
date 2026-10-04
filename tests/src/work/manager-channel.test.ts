import { describe, expect, it } from 'vitest';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import {
  askedFor,
  batchDecisionNoticeText,
  batchRequestLines,
  CLOSE_ONLY_ON_CARD_REASON,
  closeOnCardNoticeText,
  canEditManagerMessage,
  DECISION_ID_ALPHABET,
  decisionIdFromBytes,
  decisionNoticeText,
  decisionRequestText,
  MANAGER_FEEDBACK_MAX_CHARS,
  MANAGER_MESSAGE_MAX_CHARS,
  managerMessageAction,
  managerMessageUpdateAction,
  parseDecisionReply,
  readsManagerDm,
} from '../../../src/work/manager-channel';
import { decisionRequestBlocks, settledRequestBlocks } from '../../../src/work/decision-blocks';
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

  it('names the ask’s channel and thread for a held reply, and quotes a body up to the plan line’s length (U9 step 24)', (): void => {
    const body = `Pipeline coverage is ${'three point one times, '.repeat(6).trim()}.`;
    const reply: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'team-chat',
        method: 'POST',
        path: 'chat.postMessage',
        body: JSON.stringify({ channel: 'C0ASKS', thread_ts: '1787746453.202809', text: body }),
      },
    };
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Coverage for standup',
      id: 'ab3xyz',
      kind: 'actions',
      actions: [reply],
      heldIndexes: [0],
      surfaces: [slack],
      item: {
        sourceCategory: 'inbox',
        externalId: 'C0ASKS:1787746453.202809',
        replyTarget: {
          channel: 'C0ASKS',
          channelName: 'revops-asks',
          threadTs: '1787746453.202809',
        },
      },
    });
    expect(body.length).toBeGreaterThan(120);
    expect(text).toContain(`1. Reply in #revops-asks thread: "${body}"`);
    expect(text).not.toContain('C0ASKS (in thread)');
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

  it('threads a message under the request when told to, where the rung takes a thread (M finding 3)', (): void => {
    const threaded = managerMessageAction(slack, 'Received.', { threadTs: '1.100' });
    expect(JSON.parse((threaded.args as { body: string }).body)).toEqual({
      channel: 'D0MANAGER',
      text: 'Received.',
      thread_ts: '1.100',
    });
    const mcp = {
      ...slack,
      path: 'mcp' as const,
      toolAllowlist: ['send_message'],
    };
    // An MCP tool that advertised no thread argument posts at the top of the DM.
    expect(
      managerMessageAction(
        { ...mcp, toolArguments: [{ tool: 'send_message', arguments: ['channel', 'text'] }] },
        'Received.',
        { threadTs: '1.100' },
      ).args,
    ).toMatchObject({ toolArgsJson: JSON.stringify({ channel: 'D0MANAGER', text: 'Received.' }) });
    expect(
      managerMessageAction(
        {
          ...mcp,
          toolArguments: [{ tool: 'send_message', arguments: ['channel', 'text', 'threadTs'] }],
        },
        'Received.',
        { threadTs: '1.100' },
      ).args,
    ).toMatchObject({
      toolArgsJson: JSON.stringify({ channel: 'D0MANAGER', text: 'Received.', threadTs: '1.100' }),
    });
  });

  it('edits a message in the manager DM only on a documented API that allows chat.update', (): void => {
    const updating = { ...slack, toolAllowlist: [...slack.toolAllowlist!, 'chat.update'] };
    expect(managerMessageUpdateAction(updating, '1.100', 'Decided.')).toEqual({
      tool: 'http.request',
      args: {
        surface: 'team-chat',
        method: 'POST',
        path: 'chat.update',
        headersJson: JSON.stringify({
          Authorization: 'Bearer {{secret}}',
          'Content-Type': 'application/json; charset=utf-8',
        }),
        body: JSON.stringify({ channel: 'D0MANAGER', ts: '1.100', text: 'Decided.' }),
      },
    });
    expect(managerMessageUpdateAction(slack, '1.100', 'Decided.')).toBeUndefined();
    expect(
      managerMessageUpdateAction({ ...updating, path: 'mcp' }, '1.100', 'Decided.'),
    ).toBeUndefined();
  });

  it('sends the blocks of a request beside its text on the documented API, and refuses them over MCP', (): void => {
    const blocks = decisionRequestBlocks({ id: 'ab3xyz', text: 'Decide this.', buttons: true });
    const action = managerMessageAction(slack, 'Decide this.', { blocks });
    expect(JSON.parse((action.args as { body: string }).body)).toEqual({
      channel: 'D0MANAGER',
      text: 'Decide this.',
      blocks,
    });
    expect(() =>
      managerMessageAction(
        {
          ...slack,
          path: 'mcp',
          toolAllowlist: ['send_message'],
          toolArguments: [{ tool: 'send_message', arguments: ['channel', 'text'] }],
        },
        'Decide this.',
        { blocks },
      ),
    ).toThrow(/blocks/);
  });

  it('edits a request with the blocks it is given, so its buttons go with the edit', (): void => {
    const updating = { ...slack, toolAllowlist: [...slack.toolAllowlist!, 'chat.update'] };
    const blocks = settledRequestBlocks('Decided.');
    const action = managerMessageUpdateAction(updating, '1.100', 'Decided.', blocks);
    expect(JSON.parse((action!.args as { body: string }).body)).toEqual({
      channel: 'D0MANAGER',
      ts: '1.100',
      text: 'Decided.',
      blocks,
    });
  });

  it('names the buttons in the reply line when the request carries them, keeping the typed code', (): void => {
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Close August',
      id: 'ab3xyz',
      kind: 'plan',
      plan: { summary: 'Comment, then close the issue.' },
      buttons: true,
    });
    expect(text.split('\n').at(-1)).toBe(
      'Press Approve or Reject below, or reply “approve ab3xyz” or “reject ab3xyz <reason>”.',
    );
  });

  it('can edit a manager DM message only where the gate would allow chat.update', (): void => {
    const withEdit = { ...slack, toolAllowlist: [...(slack.toolAllowlist ?? []), 'chat.update'] };
    expect(canEditManagerMessage(withEdit)).toBe(true);
    expect(canEditManagerMessage(slack)).toBe(false);
    // The gate names the operation exactly, so a spelling it refuses edits nothing.
    expect(canEditManagerMessage({ ...slack, toolAllowlist: ['/chat.update'] })).toBe(false);
    expect(
      managerMessageUpdateAction({ ...slack, toolAllowlist: ['/chat.update'] }, '1.1', 'x'),
    ).toBeUndefined();
    expect(canEditManagerMessage({ ...withEdit, managerDmChannelId: undefined })).toBe(false);
    expect(canEditManagerMessage({ ...withEdit, path: 'mcp' })).toBe(false);
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

describe('readsManagerDm (M10)', (): void => {
  it('reads the DM for the threads of Day0’s other recent messages too', (): void => {
    expect(readsManagerDm({ requests: [], batches: [], noticeOwed: false })).toBe(false);
    expect(
      readsManagerDm({ requests: [], batches: [], noticeOwed: false, threads: ['1.000100'] }),
    ).toBe(true);
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

  it('tells the manager a plan was drafted without its ticket, and what approving it means (P7-18)', (): void => {
    const request = (cause: 'not-connected' | 'read-failed'): string[] =>
      decisionRequestText({
        agentName: 'ops worker',
        title: 'Close August',
        id: 'ab3xyz',
        kind: 'plan',
        plan: { summary: 'Close the month.', steps: ['Comment the figures.'] },
        draftedWithout: { system: 'Linear', subject: 'record', cause },
      }).split('\n');
    expect(request('not-connected').slice(2, 4)).toEqual([
      'Plan: Close the month.',
      'Drafted without reading the ticket: Linear was not connected. Day0 drafts the plan again when Linear is back; approving now runs it as drafted.',
    ]);
    expect(request('read-failed')[3]).toBe(
      'Drafted without reading the ticket: the read on Linear did not land. Approving runs it as drafted.',
    );
  });

  it('names another channel by its Slack mention when Slack renders the request', (): void => {
    const post: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'team-chat',
        method: 'POST',
        path: 'chat.postMessage',
        body: JSON.stringify({ channel: 'C0PUBLIC', text: 'Close completed.' }),
      },
    };
    const request = (slackMarkup: boolean): string =>
      decisionRequestText({
        agentName: 'ops worker',
        title: 'Close August',
        id: 'ab3xyz',
        kind: 'actions',
        actions: [post],
        heldIndexes: [0],
        surfaces: [slack],
        slackMarkup,
      });
    expect(request(true)).toContain('1. Post to Slack channel <#C0PUBLIC>: "Close completed."');
    expect(request(false)).toContain('1. Post to Slack channel C0PUBLIC: "Close completed."');
  });

  it('keeps the gate’s reason on a refused row whose body fills the quote', (): void => {
    const long: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'team-chat',
        method: 'POST',
        path: 'chat.postMessage',
        body: JSON.stringify({ channel: 'C0PUBLIC', text: 'Close figures. '.repeat(40) }),
      },
    };
    const text = decisionRequestText({
      agentName: 'ops worker',
      title: 'Close August',
      id: 'ab3xyz',
      kind: 'actions',
      actions: [close, long],
      heldIndexes: [0],
      refused: [{ index: 1, reason: 'reply outside the source channel' }],
      surfaces: [slack],
    });
    const line = text.split('\n').find((entry) => entry.startsWith('- Post to Slack'))!;
    expect(line.endsWith('… (reply outside the source channel)')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(300);
  });
});

describe('the acknowledgement of a decision while a pause holds the step (W12-R15)', (): void => {
  it('says the approved step runs now, or when the pause that holds it ends', (): void => {
    const employee = { by: 'employee', employeeName: 'Priya' } as const;
    expect(
      decisionNoticeText({ id: 'ab12cd', verb: 'approve', kind: 'actions', hold: undefined }),
    ).toBe('Approval ab12cd received. I’m applying the approved actions now.');
    expect(
      decisionNoticeText({ id: 'ab12cd', verb: 'approve', kind: 'actions', hold: employee }),
    ).toBe(
      'Approval ab12cd received. I’m paused: I’ll apply the approved actions when you resume me.',
    );
    expect(decisionNoticeText({ id: 'ab12cd', verb: 'reject', kind: 'plan', hold: employee })).toBe(
      'Rejection ab12cd received. I won’t apply it.',
    );
    expect(
      batchDecisionNoticeText({
        id: 'b1',
        verb: 'approve',
        decided: ['ab12cd'],
        skipped: [],
        hold: { by: 'deployment' },
      }),
    ).toBe(
      'Approval b1 received for 1 of 1 decisions (ab12cd). Scheduled work on this deployment is paused: I’ll apply the approved actions once it runs again.',
    );
  });
});

describe('the acknowledgement of an approval that left a ticket close for its card (12-H)', (): void => {
  const employee = { by: 'employee', employeeName: 'Priya' } as const;

  it('says what it applies and that the close waits on its card, under a pause too', (): void => {
    expect(
      decisionNoticeText({
        id: 'ab12cd',
        verb: 'approve',
        kind: 'actions',
        hold: undefined,
        closesHeld: 1,
      }),
    ).toBe(
      'Approval ab12cd received. I’m applying the approved actions now. I won’t send the ticket close with them: Day0 held it because my own words say the work was not done, so it waits for you on its card in day0.',
    );
    expect(
      decisionNoticeText({
        id: 'ab12cd',
        verb: 'approve',
        kind: 'actions',
        hold: employee,
        closesHeld: 2,
      }),
    ).toBe(
      'Approval ab12cd received. I’m paused: I’ll apply the approved actions when you resume me. I won’t send the 2 ticket closes with them: Day0 held them because my own words say the work was not done, so each waits for you on its card in day0.',
    );
    // A rejection takes the whole set, the close with it: nothing is left for the card.
    expect(
      decisionNoticeText({
        id: 'ab12cd',
        verb: 'reject',
        kind: 'actions',
        hold: undefined,
        closesHeld: 1,
      }),
    ).toBe('Rejection ab12cd received. I won’t apply any of it, the ticket close included.');
    expect(
      decisionNoticeText({ id: 'ab12cd', verb: 'reject', kind: 'actions', hold: undefined }),
    ).toBe('Rejection ab12cd received. I won’t apply it.');
  });

  it('names in a batch acknowledgement each request whose close waits, and one whose close was all it had', (): void => {
    expect(
      batchDecisionNoticeText({
        id: 'b1',
        verb: 'approve',
        decided: ['ab12cd', 'ef34gh'],
        skipped: [{ decisionId: 'jk56mn', reason: CLOSE_ONLY_ON_CARD_REASON }],
        leftForCard: ['ab12cd', 'ef34gh'],
      }),
    ).toBe(
      'Approval b1 received for 2 of 3 decisions (ab12cd, ef34gh). I’m applying the approved actions now. I won’t send the ticket closes of ab12cd and ef34gh with them: Day0 held them because my own words say the work was not done, so each waits for you on its card in day0. Left as they were: jk56mn: nothing to send: its only write is a ticket close, which waits on its card.',
    );
  });

  it('answers an approval of a request whose only waiting write is the close with where it is decided', (): void => {
    expect(closeOnCardNoticeText('ab12cd')).toBe(
      'Approval ab12cd received, but there is nothing here for me to send: the only write waiting is the ticket close, which Day0 held because my own words say the work was not done. Decide it on its card in day0.',
    );
  });
});

describe('a decision request with a ticket close Day0 held (12-H, R-12D-1)', (): void => {
  const comment: MockAction = {
    tool: 'mcp.call',
    args: {
      surface: 'linear',
      tool: 'save_comment',
      toolArgsJson: '{"issueId":"REVOPS-12","body":"Audit note posted."}',
    },
  };
  const post: MockAction = {
    tool: 'mcp.call',
    args: {
      surface: 'linear',
      tool: 'save_comment',
      toolArgsJson: '{"issueId":"REVOPS-13","body":"Finance follow-up."}',
    },
  };
  const close: MockAction = {
    tool: 'mcp.call',
    args: {
      surface: 'linear',
      tool: 'save_issue',
      toolArgsJson: '{"id":"REVOPS-12","state":"Done"}',
    },
  };
  const base = {
    agentName: 'Priya',
    title: 'Post the close-summary audit note',
    id: 'gh6npq',
    kind: 'actions' as const,
    actions: [comment, close, post],
    surfaces: [slack],
    item: { sourceCategory: 'ticket-queue', externalId: 'REVOPS-12' },
  };

  it('lists the writes an approval sends, and names the close it leaves out, why, and where it is decided', (): void => {
    const text = decisionRequestText({
      ...base,
      heldIndexes: [0, 2],
      leftForCard: { indexes: [1], clause: 'I could not find the close summary.' },
      buttons: true,
    });
    const lines = text.split('\n');
    expect(lines.filter((line) => /^\d+\. /.test(line))).toHaveLength(2);
    expect(text).toContain('Not sent by approving here, as it waits on its card in day0:');
    expect(text).toContain(
      'Priya answered that the work is done, but wrote “I could not find the close summary”. Day0 held this close for that reason, so approving here does not send it, and rejecting here rejects everything, the close included. Decide it on its card, where you can read the run first.',
    );
    expect(text).toContain('“approve gh6npq” applies both actions listed');
    expect(text.indexOf('Not sent by approving here')).toBeLessThan(text.indexOf('Press Approve'));
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(text).not.toContain('—');
  });

  it('asks nothing a press could decide when the close is the only write waiting', (): void => {
    const text = decisionRequestText({
      ...base,
      heldIndexes: [],
      leftForCard: { indexes: [1], clause: 'Did the deals sync?' },
      buttons: false,
    });
    expect(text.split('\n')[0]).toBe(
      'Priya’s ticket close on “Post the close-summary audit note” waits for you on its card in day0.',
    );
    expect(text).toContain(
      'Priya answered that the work is done, but wrote “Did the deals sync?” Day0 held the close for that reason, so it is decided on its card, not here: approve it there only if the work was done, or finish without it.',
    );
    expect(text).not.toContain('approve gh6npq');
    expect(text).not.toContain('Press Approve');
    expect(text).not.toContain('Reply');
  });

  it('keeps a very long sentence inside one section of a Slack message', (): void => {
    const text = decisionRequestText({
      ...base,
      heldIndexes: [0, 2],
      leftForCard: { indexes: [1], clause: `${'The deals were not found. '.repeat(200)}` },
    });
    expect(text.length).toBeLessThanOrEqual(3_000);
    const sentence = text.split('\n').find((line) => line.startsWith('Priya answered'))!;
    // The quotation is cut at 400 characters; the line around it says why and where it is decided.
    expect(sentence.length).toBeLessThanOrEqual(800);
    expect(sentence).toContain('…”');
  });
});

describe('the batch lines when a member leaves a ticket close for its card (12-H)', (): void => {
  it('marks the member and says the batch code leaves its close for the card', (): void => {
    expect(
      batchRequestLines({
        id: 'bq2wxy',
        members: [
          { title: 'Post the audit note', decisionId: 'gh6npq', leavesCloseForCard: true },
          { title: 'Post the second note', decisionId: 'hk7rst' },
        ],
      }),
    ).toEqual([
      '',
      '2 held action sets are waiting, each shown in its own request:',
      '1. Post the audit note (gh6npq; its ticket close waits on its card)',
      '2. Post the second note (hk7rst)',
      'Reply “approve bq2wxy” to approve every held action in all 2 but any ticket close Day0 held, which is decided on its card in day0, or “reject bq2wxy <reason>” to reject them all, any such close included. A request decided since is left as decided.',
    ]);
  });
});

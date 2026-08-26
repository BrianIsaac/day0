import { describe, expect, it } from 'vitest';
import {
  ACTION_JSON_LIMIT_BYTES,
  actionIntent,
  applyProvenance,
  containsProvenanceTrailer,
  describeAction,
  grantingScopes,
  grantRefusal,
  HELD_PUBLIC_POST,
  heldReason,
  isAuditComment,
  isManagerDm,
  isStatusChange,
  MALFORMED_ACTION,
  MOCK_VERB_REFUSED,
  parseSurfaceAction,
  provenanceTrailer,
  requiredScope,
  reviewAction,
  reviewActions,
  reviewPayload,
  serialiseSurfaceAction,
  SHARED_IDENTITY_ICON,
  skillApprovalRefusal,
  statusChangeWithoutComment,
  surfaceRefusal,
  TRAILER_REFUSED,
  USERNAME_REFUSED,
  type ParsedSurfaceAction,
} from '../../../src/surfaces/policy';
import type { AppliedAction, SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

const now = Date.UTC(2026, 7, 29, 9);

const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  endpoint: 'https://mcp.linear.app/mcp',
  path: 'mcp',
  toolAllowlist: ['get_issue', 'save_comment', 'save_issue', 'list_issues'],
  credentialId: 'cred-linear',
  credentialKind: 'value',
};

const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  endpoint: 'https://slack.com/api/',
  path: 'documented-api',
  toolAllowlist: ['auth.test', 'users.lookupByEmail', 'conversations.open', 'chat.postMessage'],
  credentialId: 'cred-slack',
  credentialKind: 'value',
  managerDmChannelId: 'D0MANAGER',
};

const run = { agentName: 'Priya', workItemId: 'wi_1', runId: 'run_1' };

function comment(body = 'Prepared the close summary.', issueId = 'iss-1'): MockAction {
  return {
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId, body }) },
  };
}

function statusChange(id = 'iss-1'): MockAction {
  return {
    tool: 'mcp.call',
    args: { surface: 'linear', tool: 'save_issue', toolArgsJson: JSON.stringify({ id, state: 'Done' }) },
  };
}

function chatPost(channel: string, extra: Record<string, unknown> = {}): MockAction {
  return {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      body: JSON.stringify({ channel, text: 'Draft ready.', ...extra }),
    },
  };
}

function parsed(action: MockAction): ParsedSurfaceAction {
  const result = parseSurfaceAction(action);
  if (!result.ok) throw new Error(result.reason);
  return result.action;
}

describe('surface action parsing', (): void => {
  it('parses an mcp.call with its JSON tool arguments', (): void => {
    expect(parsed(comment())).toEqual({
      kind: 'mcp.call',
      surface: 'linear',
      tool: 'save_comment',
      toolArgs: { issueId: 'iss-1', body: 'Prepared the close summary.' },
    });
  });

  it('parses an http.request with headers, method and a JSON body', (): void => {
    const request = parsed(chatPost('D0MANAGER'));
    expect(request).toMatchObject({
      kind: 'http.request',
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      headers: { Authorization: 'Bearer {{secret}}' },
      bodyJson: { channel: 'D0MANAGER', text: 'Draft ready.' },
    });
    expect(parsed({ tool: 'http.request', args: { surface: 'slack', path: 'auth.test' } })).toMatchObject({
      method: 'GET',
      headers: {},
    });
  });

  it.each<[string, MockAction]>([
    ['missing surface', { tool: 'mcp.call', args: { tool: 'save_comment' } }],
    ['missing tool', { tool: 'mcp.call', args: { surface: 'linear' } }],
    ['invalid JSON', { tool: 'mcp.call', args: { surface: 'linear', tool: 'x', toolArgsJson: '{not json' } }],
    ['non-object JSON', { tool: 'mcp.call', args: { surface: 'linear', tool: 'x', toolArgsJson: '[1,2]' } }],
    ['missing path', { tool: 'http.request', args: { surface: 'slack', method: 'POST' } }],
    ['bad method', { tool: 'http.request', args: { surface: 'slack', method: 'FETCH', path: '/x' } }],
    ['non-string header', { tool: 'http.request', args: { surface: 'slack', path: '/x', headersJson: '{"A":1}' } }],
    ['bad JSON body', { tool: 'http.request', args: { surface: 'slack', path: '/x', body: '{oops' } }],
  ])('rejects a malformed action: %s', (_label, action): void => {
    const result = parseSurfaceAction(action);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith(MALFORMED_ACTION)).toBe(true);
  });

  it('caps every JSON string argument at 16 KiB', (): void => {
    const big = JSON.stringify({ body: 'x'.repeat(ACTION_JSON_LIMIT_BYTES) });
    const overCap = parseSurfaceAction({ tool: 'mcp.call', args: { surface: 'linear', tool: 'x', toolArgsJson: big } });
    expect(overCap).toMatchObject({ ok: false, reason: `${MALFORMED_ACTION} (toolArgsJson exceeds ${ACTION_JSON_LIMIT_BYTES} bytes)` });
    const headers = parseSurfaceAction({ tool: 'http.request', args: { surface: 'slack', path: '/x', headersJson: big } });
    expect(headers).toMatchObject({ ok: false, reason: `${MALFORMED_ACTION} (headersJson exceeds ${ACTION_JSON_LIMIT_BYTES} bytes)` });
    const body = parseSurfaceAction({ tool: 'http.request', args: { surface: 'slack', path: '/x', body: 'y'.repeat(ACTION_JSON_LIMIT_BYTES + 1) } });
    expect(body).toMatchObject({ ok: false, reason: `${MALFORMED_ACTION} (body exceeds ${ACTION_JSON_LIMIT_BYTES} bytes)` });
    const atCap = parseSurfaceAction({ tool: 'http.request', args: { surface: 'slack', path: '/x', body: 'y'.repeat(ACTION_JSON_LIMIT_BYTES) } });
    expect(atCap.ok).toBe(true);
  });

  it('round-trips through serialisation', (): void => {
    expect(parsed(serialiseSurfaceAction(parsed(comment())))).toEqual(parsed(comment()));
    expect(parsed(serialiseSurfaceAction(parsed(chatPost('D0MANAGER'))))).toEqual(parsed(chatPost('D0MANAGER')));
  });
});

describe('intent, scope and connection', (): void => {
  it('classifies reads by tool prefix or HTTP method and defaults to write', (): void => {
    expect(actionIntent(parsed({ tool: 'mcp.call', args: { surface: 'linear', tool: 'list_issues' } }))).toBe('read');
    expect(actionIntent(parsed({ tool: 'mcp.call', args: { surface: 'linear', tool: 'get_issue' } }))).toBe('read');
    expect(actionIntent(parsed(comment()))).toBe('write');
    expect(actionIntent(parsed({ tool: 'mcp.call', args: { surface: 'linear', tool: 'frobnicate' } }))).toBe('write');
    expect(actionIntent(parsed({ tool: 'http.request', args: { surface: 'slack', path: 'conversations.history' } }))).toBe('read');
    expect(actionIntent(parsed({ tool: 'http.request', args: { surface: 'slack', path: '/chat.postMessage?channel=D0MANAGER&text=smuggled' } }))).toBe('write');
    expect(actionIntent(parsed({ tool: 'http.request', args: { surface: 'slack', method: 'HEAD', path: '/conversations.open?users=U1' } }))).toBe('write');
    expect(actionIntent(parsed({ tool: 'http.request', args: { surface: 'northstar', path: '/contacts/42' } }))).toBe('read');
    expect(actionIntent(parsed(chatPost('D0MANAGER')))).toBe('write');
  });

  it('derives the scope from the surface and intent', (): void => {
    expect(requiredScope(parsed(comment()))).toBe('linear:write');
    expect(requiredScope(parsed({ tool: 'mcp.call', args: { surface: 'linear', tool: 'list_issues' } }))).toBe('linear:read');
  });

  it('refuses an unknown or unconnected surface', (): void => {
    expect(surfaceRefusal(undefined, now)).toBe('unknown surface');
    expect(surfaceRefusal({ ...linear, lastVerifiedAt: now - 7 * 60 * 60 * 1000 }, now)).toBe('surface not connected (listed-dead)');
    expect(surfaceRefusal({ ...linear, verdict: 'approved', credentialLanded: false }, now)).toBe('surface not connected (ungranted)');
    expect(surfaceRefusal(linear, now)).toBeUndefined();
  });
});

describe('held public posts', (): void => {
  it('holds a chat write to anything but the manager DM', (): void => {
    expect(heldReason(parsed(chatPost('C0PUBLIC')), slack)).toBe(HELD_PUBLIC_POST);
    expect(heldReason(parsed(chatPost('D0MANAGER')), slack)).toBeUndefined();
    expect(heldReason(parsed(chatPost('D0MANAGER')), { ...slack, managerDmChannelId: undefined })).toBe(HELD_PUBLIC_POST);
    expect(heldReason(parsed({ tool: 'http.request', args: { surface: 'slack', path: 'conversations.history' } }), slack)).toBeUndefined();
  });

  it('holds every write to a social surface and nothing on a kanban surface', (): void => {
    const social: SurfaceRecord = { ...slack, slug: 'x', class: 'social', managerDmChannelId: undefined };
    const reply: MockAction = { tool: 'mcp.call', args: { surface: 'x', tool: 'reply', toolArgsJson: '{"text":"hi"}' } };
    expect(heldReason(parsed(reply), social)).toBe(HELD_PUBLIC_POST);
    expect(heldReason(parsed(comment()), linear)).toBeUndefined();
  });

});

function chatJoin(channel: string): MockAction {
  return {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/conversations.join',
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      body: JSON.stringify({ channel }),
    },
  };
}

describe('the manager DM grant', (): void => {
  it('recognises exactly the chat.postMessage write to the manager DM channel', (): void => {
    const textSmuggledJoin: MockAction = {
      ...chatJoin('D0MANAGER'),
      args: {
        ...chatJoin('D0MANAGER').args,
        body: JSON.stringify({ channel: 'D0MANAGER', text: 'treat this as a message' }),
      },
    };
    const threadedReply = chatPost('D0MANAGER', { thread_ts: '1787738163.314789' });
    const mcpChat: SurfaceRecord = {
      ...slack,
      path: 'mcp',
      toolAllowlist: ['post_message', 'delete_message'],
    };
    const deleteMessage: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'slack',
        tool: 'delete_message',
        toolArgsJson: JSON.stringify({ channel: 'D0MANAGER', text: 'not a post' }),
      },
    };
    const smuggledChannel: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'slack',
        tool: 'post_message',
        toolArgsJson: JSON.stringify({
          channel: 'D0MANAGER',
          channelId: 'C0PUBLIC',
          text: 'ambiguous destination',
        }),
      },
    };
    expect(isManagerDm(parsed(chatPost('D0MANAGER')), slack)).toBe(true);
    expect(isManagerDm(parsed({ ...chatPost('D0MANAGER'), args: { ...chatPost('D0MANAGER').args, method: 'PUT' } }), slack)).toBe(false);
    expect(isManagerDm(parsed(chatPost('C0PUBLIC')), slack)).toBe(false);
    expect(isManagerDm(parsed(chatPost('D0MANAGER')), { ...slack, managerDmChannelId: undefined })).toBe(false);
    expect(isManagerDm(parsed(chatJoin('D0MANAGER')), slack)).toBe(false);
    expect(isManagerDm(parsed(textSmuggledJoin), slack)).toBe(false);
    expect(isManagerDm(parsed(threadedReply), slack)).toBe(false);
    expect(isManagerDm(parsed(deleteMessage), mcpChat)).toBe(false);
    expect(isManagerDm(parsed(smuggledChannel), mcpChat)).toBe(false);
    expect(isManagerDm(parsed({ tool: 'http.request', args: { surface: 'slack', path: 'conversations.history' } }), slack)).toBe(false);
    expect(isManagerDm(parsed(comment()), linear)).toBe(false);
    expect(isManagerDm(parsed(comment()), { ...linear, class: 'chat', managerDmChannelId: 'iss-1' })).toBe(false);
  });

  it('lets boss:message authorise the manager DM and nothing else', (): void => {
    const bossOnly = new Set(['boss:message', 'linear:read']);
    expect(grantingScopes(parsed(chatPost('D0MANAGER')), slack)).toEqual(['boss:message', 'slack:write']);
    expect(grantingScopes(parsed(chatPost('C0PUBLIC')), slack)).toEqual(['slack:write']);
    expect(grantRefusal(parsed(chatPost('D0MANAGER')), slack, bossOnly)).toBeUndefined();
    expect(grantRefusal(parsed(chatPost('C0PUBLIC')), slack, bossOnly)).toBe('no grant (slack:write)');
    expect(grantRefusal(parsed(chatJoin('D0MANAGER')), slack, bossOnly)).toBe('no grant (slack:write)');
    expect(grantRefusal(parsed(comment()), linear, bossOnly)).toBe('no grant (linear:write)');
    expect(grantRefusal(parsed(chatPost('D0MANAGER')), slack, new Set(['slack:write']))).toBeUndefined();
    expect(grantRefusal(parsed(chatPost('D0MANAGER')), slack, new Set(['slack:read']))).toBe('no grant (boss:message)');
    expect(grantRefusal(parsed({ tool: 'http.request', args: { surface: 'slack', path: 'conversations.history' } }), slack, bossOnly)).toBe('no grant (slack:read)');
  });
});

describe('reviewing a held run', (): void => {
  it('holds every row the gate cannot apply, with the reason the ledger would record', (): void => {
    const grants = new Set(['boss:message', 'linear:read']);
    const verdicts = reviewActions(
      [
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"iss-1"}' } },
        comment(),
        chatPost('D0MANAGER'),
        chatPost('C0PUBLIC'),
        { tool: 'mcp.call', args: { surface: 'northstar-crm', tool: 'get_account', toolArgsJson: '{}' } },
        { tool: 'http.request', args: { surface: 'linear', method: 'POST', path: '/issues', body: '{}' } },
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{not json' } },
        { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'x' } },
        { tool: 'frobnicate', args: {} } as unknown as MockAction,
      ],
      [linear, slack],
      grants,
      now,
    );
    expect(verdicts).toEqual([
      { held: false },
      { held: true, reason: 'no grant (linear:write)' },
      { held: false },
      { held: true, reason: HELD_PUBLIC_POST },
      { held: true, reason: 'unknown surface' },
      { held: true, reason: 'http.request is not allowed on surface path mcp' },
      { held: true, reason: expect.stringContaining(MALFORMED_ACTION) },
      { held: true, reason: expect.stringContaining(MOCK_VERB_REFUSED) },
      { held: true, reason: 'unknown tool' },
    ]);
    expect(reviewAction(comment(), [{ ...linear, lastVerifiedAt: now - 7 * 60 * 60 * 1000 }], grants, now)).toEqual({
      held: true,
      reason: 'surface not connected (listed-dead)',
    });
    expect(reviewAction(comment(), [linear], new Set(['linear:write']), now)).toEqual({ held: false });
  });

  it('holds a surface operation that is absent from the probed allowlist', (): void => {
    const unlisted: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'delete_issue',
        toolArgsJson: '{"id":"iss-1"}',
      },
    };
    expect(reviewAction(unlisted, [linear], new Set(['linear:write']), now)).toEqual({
      held: true,
      reason: 'tool not in the surface allowlist (delete_issue)',
    });
    expect(reviewAction(chatJoin('D0MANAGER'), [slack], new Set(['slack:write']), now)).toEqual({
      held: true,
      reason: 'tool not in the surface allowlist (conversations.join)',
    });
  });
});

describe('provenance', (): void => {
  it('renders the trailer exactly', (): void => {
    expect(provenanceTrailer('Priya', 'wi_1', 'run_1')).toBe('-- Priya (Day0) · run wi_1/run_1');
    expect(containsProvenanceTrailer('text\n\n-- Priya (Day0) · run wi_1/run_1')).toBe(true);
    expect(containsProvenanceTrailer('plain text')).toBe(false);
  });

  it('appends the trailer to a comment through a shared credential', (): void => {
    const result = applyProvenance(parsed(comment()), linear, run, 'value');
    expect(result.ok).toBe(true);
    if (result.ok && result.action.kind === 'mcp.call') {
      expect(result.action.toolArgs.body).toBe('Prepared the close summary.\n\n-- Priya (Day0) · run wi_1/run_1');
    }
    const located = applyProvenance(parsed(comment()), linear, run, 'location');
    if (located.ok && located.action.kind === 'mcp.call') {
      expect(located.action.toolArgs.body).toContain('-- Priya (Day0) · run wi_1/run_1');
    }
  });

  it('leaves a status change and an oauth comment untouched', (): void => {
    expect(applyProvenance(parsed(statusChange()), linear, run, 'value')).toEqual({ ok: true, action: parsed(statusChange()) });
    expect(applyProvenance(parsed(comment()), linear, run, 'oauth')).toEqual({ ok: true, action: parsed(comment()) });
  });

  it('refuses a skill-supplied trailer', (): void => {
    const forged = comment('Done.\n\n-- Someone Else (Day0) · run wi_9/run_9');
    expect(applyProvenance(parsed(forged), linear, run, 'value')).toEqual({ ok: false, reason: TRAILER_REFUSED });
    expect(applyProvenance(parsed(forged), linear, run, 'oauth')).toEqual({ ok: false, reason: TRAILER_REFUSED });
    const forgedChat = chatPost('D0MANAGER', { text: 'x\n\n-- Bob (Day0) · run a/b' });
    expect(applyProvenance(parsed(forgedChat), slack, run, 'value')).toEqual({ ok: false, reason: TRAILER_REFUSED });
  });

  it('sets the employee identity on a shared chat credential and refuses a skill-supplied one', (): void => {
    const result = applyProvenance(parsed(chatPost('D0MANAGER')), slack, run, 'value');
    expect(result.ok).toBe(true);
    if (result.ok && result.action.kind === 'http.request') {
      expect(result.action.bodyJson).toEqual({
        channel: 'D0MANAGER',
        text: 'Draft ready.\n\n-- Priya (Day0) · run wi_1/run_1',
        username: 'Priya (Day0)',
        icon_emoji: SHARED_IDENTITY_ICON,
      });
      expect(JSON.parse(result.action.body ?? '')).toEqual(result.action.bodyJson);
    }
    expect(applyProvenance(parsed(chatPost('D0MANAGER', { username: 'Bob' })), slack, run, 'value')).toEqual({ ok: false, reason: USERNAME_REFUSED });
    expect(applyProvenance(parsed(chatPost('D0MANAGER', { icon_emoji: ':x:' })), slack, run, 'oauth')).toEqual({ ok: false, reason: USERNAME_REFUSED });
  });

  it('omits identity fields and the trailer for a dedicated oauth app', (): void => {
    const result = applyProvenance(parsed(chatPost('D0MANAGER')), slack, run, 'oauth');
    expect(result.ok).toBe(true);
    if (result.ok && result.action.kind === 'http.request') {
      expect(result.action.bodyJson).toEqual({ channel: 'D0MANAGER', text: 'Draft ready.' });
    }
  });
});

describe('comment before status change', (): void => {
  it('recognises audit comments and status changes', (): void => {
    expect(isAuditComment(parsed(comment()))).toBe(true);
    expect(isAuditComment(parsed(statusChange()))).toBe(false);
    expect(isStatusChange(parsed(statusChange()))).toBe(true);
    expect(isStatusChange(parsed(comment()))).toBe(false);
    expect(isStatusChange(parsed({ tool: 'mcp.call', args: { surface: 'linear', tool: 'save_issue', toolArgsJson: '{"id":"iss-1","title":"x"}' } }))).toBe(false);
  });

  it('fails a status change with no landed comment before it', (): void => {
    const landed: AppliedAction = { tool: 'mcp.call', ok: true, idempotencyKey: 'k0' };
    const failed: AppliedAction = { tool: 'mcp.call', ok: false, idempotencyKey: 'k0' };
    const held: AppliedAction = { tool: 'mcp.call', ok: true, held: true, idempotencyKey: 'k0' };
    expect(statusChangeWithoutComment(parsed(statusChange()), 1, [parsed(comment())], [landed])).toBe(false);
    expect(statusChangeWithoutComment(parsed(statusChange()), 1, [parsed(comment())], [failed])).toBe(true);
    expect(statusChangeWithoutComment(parsed(statusChange()), 1, [parsed(comment())], [held])).toBe(true);
    expect(statusChangeWithoutComment(parsed(statusChange()), 0, [], [])).toBe(true);
    expect(statusChangeWithoutComment(parsed(statusChange()), 1, [parsed(statusChange())], [landed])).toBe(true);
  });

  it('requires the comment on the same issue when both name one', (): void => {
    const landed: AppliedAction = { tool: 'mcp.call', ok: true, idempotencyKey: 'k0' };
    expect(statusChangeWithoutComment(parsed(statusChange('iss-2')), 1, [parsed(comment('c', 'iss-1'))], [landed])).toBe(true);
    expect(statusChangeWithoutComment(parsed(statusChange('iss-1')), 1, [parsed(comment('c', 'iss-1'))], [landed])).toBe(false);
    expect(
      statusChangeWithoutComment(
        parsed(statusChange('iss-1')),
        1,
        [
          parsed({
            tool: 'mcp.call',
            args: {
              surface: 'linear',
              tool: 'save_comment',
              toolArgsJson: JSON.stringify({ projectId: 'project-1', body: 'Project note.' }),
            },
          }),
        ],
        [landed],
      ),
    ).toBe(true);
    expect(statusChangeWithoutComment(parsed(comment()), 0, [], [])).toBe(false);
  });
});

describe('skill approval and card rendering', (): void => {
  it('refuses a surface skill until its surface is connected', (): void => {
    expect(skillApprovalRefusal(undefined, undefined, now)).toBeUndefined();
    expect(skillApprovalRefusal('linear', undefined, now)).toBe('surface linear is not listed for this agent');
    expect(skillApprovalRefusal('linear', { ...linear, verdict: 'approved', credentialLanded: false }, now)).toBe(
      'surface linear is ungranted; connect it on the Surfaces tab before approving this skill',
    );
    expect(skillApprovalRefusal('linear', linear, now)).toBeUndefined();
  });

  it('describes every verb verbatim on one line', (): void => {
    expect(describeAction(comment())).toBe('mcp.call linear · save_comment · {issueId: "iss-1", body: "Prepared the close summary."}');
    expect(describeAction(chatPost('D0MANAGER'))).toBe(
      'http.request slack · POST /chat.postMessage · headers {Authorization: "Bearer {{secret}}"} · body "{"channel":"D0MANAGER","text":"Draft ready."}"',
    );
    expect(describeAction({ tool: 'mcp.call', args: { surface: 'linear', tool: 'x', toolArgsJson: '{broken' } })).toBe('mcp.call linear · x · "{broken"');
    expect(describeAction({ tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'Hello' } })).toBe('slack.postMessage · {channelSlug: "dm-manager", body: "Hello"}');
    expect(describeAction({ tool: 'spreadsheet.appendRow', args: { sheetSlug: 'q4', tabName: 'Won', cells: [{ header: 'Name', value: 'A' }] } })).toBe(
      'spreadsheet.appendRow · {sheetSlug: "q4", tabName: "Won", cells: ["Name=A"]}',
    );
  });
});

describe('review payload for the approval card', (): void => {
  it('shows only the arguments the verb reads, and only the non-empty ones, verbatim', (): void => {
    const flat: MockAction = {
      tool: 'mcp.call',
      args: {
        body: '',
        cells: [],
        channelSlug: '',
        comment: '',
        headersJson: '',
        method: '',
        path: '',
        sheetSlug: '',
        slug: '',
        status: 'open',
        surface: 'linear',
        tabName: '',
        threadKey: '',
        tool: 'save_comment',
        toolArgsJson: '{"issueId":"REVOPS-5","body":"Audit note."}',
        tweetSlug: '',
      },
    };
    expect(reviewPayload(flat)).toEqual({
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{"issueId":"REVOPS-5","body":"Audit note."}' },
    });
    expect(
      reviewPayload({
        tool: 'http.request',
        args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', headersJson: '{"Authorization":"Bearer {{secret}}"}', body: '{"channel":"D1","text":"hi"}', status: 'open', cells: [] },
      }),
    ).toEqual({
      tool: 'http.request',
      args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', headersJson: '{"Authorization":"Bearer {{secret}}"}', body: '{"channel":"D1","text":"hi"}' },
    });
    expect(reviewPayload({ tool: 'ticket.update', args: { slug: 'REVOPS-5', status: 'done', comment: '', surface: 'linear' } })).toEqual({
      tool: 'ticket.update',
      args: { slug: 'REVOPS-5', status: 'done' },
    });
    expect(reviewPayload({ tool: 'spreadsheet.appendRow', args: { sheetSlug: 's', tabName: 't', cells: [{ header: 'h', value: '' }] } })).toEqual({
      tool: 'spreadsheet.appendRow',
      args: { sheetSlug: 's', tabName: 't', cells: [{ header: 'h', value: '' }] },
    });
    expect(reviewPayload({ tool: 'mcp.call' } as MockAction)).toEqual({ tool: 'mcp.call', args: {} });
  });
});

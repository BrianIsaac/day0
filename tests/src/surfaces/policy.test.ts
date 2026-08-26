import { describe, expect, it } from 'vitest';
import {
  ACTION_JSON_LIMIT_BYTES,
  actionClass,
  actionIntent,
  applyProvenance,
  containsProvenanceTrailer,
  describeAction,
  grantingScopes,
  grantRefusal,
  HELD_MUTATION,
  HELD_PUBLIC_POST,
  heldReason,
  isAutomatic,
  isAuditComment,
  isManagerDm,
  isStatusChange,
  MALFORMED_ACTION,
  MOCK_VERB_REFUSED,
  needsStandingGrant,
  normaliseActionVerdict,
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
  type ReviewScope,
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
    expect(actionIntent(parsed({ tool: 'mcp.call', args: { surface: 'linear', tool: 'list_and_delete_issues' } }))).toBe('write');
    expect(actionIntent(parsed(comment()))).toBe('write');
    expect(actionIntent(parsed({ tool: 'mcp.call', args: { surface: 'linear', tool: 'frobnicate' } }))).toBe('write');
    expect(actionIntent(parsed({ tool: 'http.request', args: { surface: 'slack', path: 'conversations.history' } }))).toBe('read');
    expect(actionIntent(parsed({ tool: 'http.request', args: { surface: 'slack', method: 'HEAD', path: 'conversations.history', body: '{"mark":"read"}' } }))).toBe('write');
    expect(actionIntent(parsed({ tool: 'http.request', args: { surface: 'slack', path: 'conversations.history?operation=delete' } }))).toBe('write');
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
    const alternateSmuggledChannel: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'slack',
        tool: 'post_message',
        toolArgsJson: JSON.stringify({
          channel: 'D0MANAGER',
          conversation_id: 'C0PUBLIC',
          text: 'ambiguous destination',
        }),
      },
    };
    const alternateThread: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'slack',
        tool: 'post_message',
        toolArgsJson: JSON.stringify({
          channel: 'D0MANAGER',
          text: 'thread reply',
          thread: '1787738163.314789',
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
    expect(isManagerDm(parsed(alternateSmuggledChannel), mcpChat)).toBe(false);
    expect(isManagerDm(parsed(alternateThread), mcpChat)).toBe(false);
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

/** The supervised state, the default: the classification table decides each row. */
const supervised: ReviewScope = { autonomousActions: false };
/** The switch on: every applicable row applies on its own. */
const autonomous: ReviewScope = { autonomousActions: true };

describe('reviewing a held run', (): void => {
  it('refuses every row the gate cannot apply, with the reason the ledger would record', (): void => {
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
      supervised,
    );
    // A write with no standing grant is held for the manager, never refused: the
    // approval of the literal payload is its authority.
    expect(verdicts).toEqual([
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
      { disposition: 'refused', reason: 'unknown surface' },
      { disposition: 'refused', reason: 'http.request is not allowed on surface path mcp' },
      { disposition: 'refused', reason: expect.stringContaining(MALFORMED_ACTION) },
      { disposition: 'refused', reason: expect.stringContaining(MOCK_VERB_REFUSED) },
      { disposition: 'refused', reason: 'unknown tool' },
    ]);
    expect(
      reviewAction(comment(), [{ ...linear, lastVerifiedAt: now - 7 * 60 * 60 * 1000 }], grants, now, supervised),
    ).toEqual({ disposition: 'refused', reason: 'surface not connected (listed-dead)' });
    // A standing write grant does not make a write automatic while the switch is off.
    expect(reviewAction(comment(), [linear], new Set(['linear:write']), now, supervised)).toEqual({
      disposition: 'held',
      reason: HELD_MUTATION,
    });
  });

  it('refuses a surface operation that is absent from the probed allowlist, whatever the switch', (): void => {
    const unlisted: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'delete_issue',
        toolArgsJson: '{"id":"iss-1"}',
      },
    };
    for (const scope of [supervised, autonomous]) {
      expect(reviewAction(unlisted, [linear], new Set(['linear:write']), now, scope)).toEqual({
        disposition: 'refused',
        reason: 'tool not in the surface allowlist (delete_issue)',
      });
      expect(reviewAction(chatJoin('D0MANAGER'), [slack], new Set(['slack:write']), now, scope)).toEqual({
        disposition: 'refused',
        reason: 'tool not in the surface allowlist (conversations.join)',
      });
    }
  });

  it('refuses actions whose provenance fields will be refused at apply, whatever the switch', (): void => {
    const forged = comment('Done.\n\n-- Someone Else (Day0) · run wi_9/run_9');
    for (const scope of [supervised, autonomous]) {
      expect(reviewAction(forged, [linear], new Set(['linear:write']), now, scope)).toEqual({
        disposition: 'refused',
        reason: TRAILER_REFUSED,
      });
      expect(
        reviewAction(
          chatPost('D0MANAGER', { username: 'Someone Else' }),
          [slack],
          new Set(['boss:message']),
          now,
          scope,
        ),
      ).toEqual({ disposition: 'refused', reason: USERNAME_REFUSED });
    }
  });
});

describe('the autonomous-actions switch', (): void => {
  const grants = new Set(['boss:message', 'linear:read', 'linear:write', 'slack:read', 'slack:write']);
  const slackReads: SurfaceRecord = {
    ...slack,
    toolAllowlist: [...(slack.toolAllowlist ?? []), 'conversations.history', 'conversations.replies'],
  };
  const linearAll: SurfaceRecord = {
    ...linear,
    toolAllowlist: [...(linear.toolAllowlist ?? []), 'list_comments', 'create_issue', 'delete_issue'],
  };
  const surfaces = [linearAll, slackReads];
  const mcp = (tool: string, toolArgs: Record<string, unknown>): MockAction => ({
    tool: 'mcp.call',
    args: { surface: 'linear', tool, toolArgsJson: JSON.stringify(toolArgs) },
  });
  const publicReply = chatPost('C0PUBLIC', { thread_ts: '1787746453.202809' });
  const rpcGet: MockAction = {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'GET',
      path: '/chat.postMessage?channel=C0PUBLIC&text=smuggled',
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
    },
  };
  const historyGet: MockAction = {
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'GET',
      path: '/conversations.history?channel=C0PUBLIC',
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
    },
  };
  const stateChange = mcp('save_issue', { id: 'REVOPS-10', state: 'Done' });
  const demo: MockAction[] = [
    mcp('get_issue', { id: 'REVOPS-10' }),
    mcp('list_comments', { issueId: 'REVOPS-10' }),
    historyGet,
    chatPost('D0MANAGER'),
    comment('Audit note.', 'REVOPS-10'),
    comment('Audit note.', 'REVOPS-11'),
    publicReply,
    stateChange,
    mcp('save_issue', { title: 'New issue', team: 'RevOps' }),
    mcp('create_issue', { title: 'New issue' }),
    mcp('delete_issue', { id: 'REVOPS-10' }),
    rpcGet,
  ];

  it('off: reads and the DM apply on their own and every other write is held with its reason', (): void => {
    expect(reviewActions(demo, surfaces, grants, now, supervised)).toEqual([
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_MUTATION },
      { disposition: 'held', reason: HELD_PUBLIC_POST },
    ]);
    // H2 kept: an RPC mutation over GET is a write, so with slack:read alone it is held rather than read on its own.
    expect(reviewAction(rpcGet, surfaces, new Set(['slack:read']), now, supervised)).toEqual({
      disposition: 'held',
      reason: HELD_PUBLIC_POST,
    });
    // A read without its standing grant, and the DM without boss:message, stay refused.
    expect(reviewAction(historyGet, surfaces, new Set(['boss:message']), now, supervised)).toEqual({
      disposition: 'refused',
      reason: 'no grant (slack:read)',
    });
    expect(reviewAction(chatPost('D0MANAGER'), surfaces, new Set(['slack:read']), now, supervised)).toEqual({
      disposition: 'refused',
      reason: 'no grant (boss:message)',
    });
    // An unrecognised HTTP write on a non-chat surface is held as a plain write.
    const httpWrite: MockAction = {
      tool: 'http.request',
      args: { surface: 'linear', method: 'POST', path: '/issues', body: '{}' },
    };
    expect(actionClass(parsed(httpWrite), { ...linearAll, path: 'documented-api', endpoint: 'https://api.linear.app/' })).toBe('write');
    expect(actionClass(parsed(rpcGet), slackReads)).toBe('public-post');
    expect(actionClass(parsed(historyGet), slackReads)).toBe('read');
    expect(actionClass(parsed(chatPost('D0MANAGER')), slackReads)).toBe('manager-dm');
    expect(actionClass(parsed(comment('x', 'revops-10')), linearAll)).toBe('mutation');
    expect(isAutomatic(parsed(publicReply), slackReads, false)).toBe(false);
    expect(isAutomatic(parsed(comment()), linearAll, false)).toBe(false);
    expect(isAutomatic(parsed(chatPost('D0MANAGER')), slackReads, false)).toBe(true);
    expect(isAutomatic(parsed(historyGet), slackReads, false)).toBe(true);

    const readDressedMutation = mcp('list_and_delete_issues', { ids: ['REVOPS-10'] });
    const linearWithDressedMutation = {
      ...linearAll,
      toolAllowlist: [...(linearAll.toolAllowlist ?? []), 'list_and_delete_issues'],
    };
    expect(
      reviewAction(readDressedMutation, [linearWithDressedMutation], new Set(['linear:read']), now, supervised),
    ).toEqual({ disposition: 'held', reason: HELD_MUTATION });
  });

  it('on: every non-refused row applies on its own, and the switch is the write authority', (): void => {
    expect(reviewActions(demo, surfaces, grants, now, autonomous)).toEqual(
      Array.from({ length: demo.length }, () => ({ disposition: 'auto' })),
    );
    // A write with no standing grant applies under the switch: the toggle is the
    // manager's standing authority for writes on connected surfaces.
    expect(reviewAction(comment('x', 'REVOPS-10'), surfaces, new Set(['linear:read']), now, autonomous)).toEqual({
      disposition: 'auto',
    });
    expect(reviewAction(publicReply, surfaces, new Set(['boss:message']), now, autonomous)).toEqual({ disposition: 'auto' });
    expect(reviewAction(stateChange, surfaces, new Set(), now, autonomous)).toEqual({ disposition: 'auto' });
    // A read and the DM still need their own grants.
    expect(reviewAction(historyGet, surfaces, new Set(['boss:message']), now, autonomous)).toEqual({
      disposition: 'refused',
      reason: 'no grant (slack:read)',
    });
    expect(reviewAction(chatPost('D0MANAGER'), surfaces, new Set(['slack:read']), now, autonomous)).toEqual({
      disposition: 'refused',
      reason: 'no grant (boss:message)',
    });
    // The refusal list is unchanged: outside the allowlist, forged provenance, a mock verb, an unknown tool, malformed.
    expect(reviewAction(mcp('archive_issue', { id: 'REVOPS-10' }), surfaces, grants, now, autonomous)).toEqual({
      disposition: 'refused',
      reason: 'tool not in the surface allowlist (archive_issue)',
    });
    expect(reviewAction(comment('Done.\n\n-- Someone Else (Day0) · run wi_9/run_9', 'REVOPS-10'), surfaces, grants, now, autonomous)).toEqual({
      disposition: 'refused',
      reason: TRAILER_REFUSED,
    });
    expect(reviewAction({ tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'x' } }, surfaces, grants, now, autonomous)).toEqual({
      disposition: 'refused',
      reason: expect.stringContaining(MOCK_VERB_REFUSED),
    });
    expect(reviewAction({ tool: 'frobnicate', args: {} } as unknown as MockAction, surfaces, grants, now, autonomous)).toEqual({
      disposition: 'refused',
      reason: 'unknown tool',
    });
    expect(reviewAction(mcp('save_comment', {}), surfaces, grants, now, autonomous).disposition).toBe('auto');
    expect(
      reviewAction({ tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{not json' } }, surfaces, grants, now, autonomous),
    ).toEqual({ disposition: 'refused', reason: expect.stringContaining(MALFORMED_ACTION) });
    expect(isAutomatic(parsed(publicReply), slackReads, true)).toBe(true);
    expect(isAutomatic(parsed(stateChange), linearAll, true)).toBe(true);
  });

  it('lets the switch stand in for the write grant and for nothing else', (): void => {
    const bossOnly = new Set(['boss:message', 'linear:read']);
    expect(needsStandingGrant(parsed(historyGet), slackReads)).toBe(true);
    expect(needsStandingGrant(parsed(chatPost('D0MANAGER')), slackReads)).toBe(true);
    expect(needsStandingGrant(parsed(comment()), linearAll)).toBe(false);
    expect(needsStandingGrant(parsed(publicReply), slackReads)).toBe(false);
    expect(needsStandingGrant(parsed(stateChange), linearAll)).toBe(false);
    expect(grantRefusal(parsed(comment()), linearAll, bossOnly)).toBe('no grant (linear:write)');
    expect(grantRefusal(parsed(comment()), linearAll, bossOnly, false)).toBe('no grant (linear:write)');
    expect(grantRefusal(parsed(comment()), linearAll, bossOnly, true)).toBeUndefined();
    expect(grantRefusal(parsed(publicReply), slackReads, bossOnly)).toBe('no grant (slack:write)');
    expect(grantRefusal(parsed(publicReply), slackReads, bossOnly, true)).toBeUndefined();
    expect(grantRefusal(parsed(stateChange), linearAll, new Set(), true)).toBeUndefined();
    expect(grantRefusal(parsed(rpcGet), slackReads, new Set(['slack:read']), true)).toBeUndefined();
    expect(grantRefusal(parsed(historyGet), slackReads, bossOnly, true)).toBe('no grant (slack:read)');
    expect(grantRefusal(parsed(chatPost('D0MANAGER')), slackReads, new Set(['slack:read']), true)).toBe('no grant (boss:message)');
    expect(grantRefusal(parsed(chatPost('D0MANAGER')), slackReads, bossOnly, true)).toBeUndefined();
  });

  it('reads verdicts persisted before dispositions existed', (): void => {
    expect(normaliseActionVerdict({ held: true, reason: 'no grant (linear:write)' })).toEqual({
      disposition: 'refused',
      reason: 'no grant (linear:write)',
    });
    expect(normaliseActionVerdict({ held: false })).toEqual({ disposition: 'held', reason: 'write held for the manager' });
    expect(normaliseActionVerdict({ disposition: 'auto', held: false })).toEqual({ disposition: 'auto' });
    expect(normaliseActionVerdict({ disposition: 'held', reason: HELD_PUBLIC_POST })).toEqual({
      disposition: 'held',
      reason: HELD_PUBLIC_POST,
    });
    expect(normaliseActionVerdict({})).toEqual({ disposition: 'held', reason: 'write held for the manager' });
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

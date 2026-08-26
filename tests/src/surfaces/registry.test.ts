import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { Id } from '../../../convex/_generated/dataModel';
import { HttpAdapter } from '../../../src/surfaces/http';
import { McpAdapter, type McpClientLike, type McpClientOptions } from '../../../src/surfaces/mcp';
import { MOCK_TOOLS, mockAdapter } from '../../../src/surfaces/mock';
import {
  AWAITING_APPROVAL,
  HELD_NOT_APPROVED,
  HELD_PUBLIC_POST,
  MOCK_VERB_REFUSED,
  NOT_AUTOMATIC,
  STATUS_WITHOUT_COMMENT,
  TRAILER_REFUSED,
} from '../../../src/surfaces/policy';
import { applySurfaceActions, resolveAdapters, type RealAdapterDeps } from '../../../src/surfaces/registry';
import type { AdapterRun, SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

const now = Date.UTC(2026, 7, 29, 9);
const ctx = {} as ActionCtx;
const run: AdapterRun = {
  agentId: 'agent' as Id<'agents'>,
  agentName: 'Priya',
  workItemId: 'wi_1' as Id<'workItems'>,
  runId: 'run_1' as Id<'events'>,
};

const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  endpoint: 'https://mcp.linear.app/mcp',
  path: 'mcp',
  toolAllowlist: ['save_comment', 'save_issue', 'list_issues'],
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

const comment: MockAction = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'Audit note.' }) },
};
const status: MockAction = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'save_issue', toolArgsJson: JSON.stringify({ id: 'iss-1', state: 'Done' }) },
};
const dm: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
    body: JSON.stringify({ channel: 'D0MANAGER', text: 'Draft ready.' }),
  },
};
const publicPost: MockAction = {
  tool: 'http.request',
  args: { ...dm.args, body: JSON.stringify({ channel: 'C0PUBLIC', text: 'Drafting for you.' }) },
};

interface Recorded {
  mcp: Array<{ tool: string; args: unknown }>;
  http: Array<{ url: string; body: unknown }>;
}

function deps(
  recorded: Recorded,
  mcpResult: (tool: string) => unknown = (): unknown => ({ content: [{ type: 'text', text: '{"id":"prov-1"}' }] }),
  mcpTools: readonly string[] = ['save_comment', 'save_issue', 'list_issues'],
): RealAdapterDeps {
  return {
    decrypt: vi.fn(async (_ctx: ActionCtx, id: string): Promise<string> => `secret-for-${id}`),
    createMcpClient: (options: McpClientOptions): McpClientLike => ({
      listTools: async () =>
        Object.fromEntries(
          mcpTools.map((tool) => [
            `${options.serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                recorded.mcp.push({ tool, args });
                return mcpResult(tool);
              },
            },
          ]),
        ),
      disconnect: async (): Promise<void> => {},
    }),
    fetch: async (url: URL, init: RequestInit): Promise<Response> => {
      recorded.http.push({
        url: url.toString(),
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify({ ok: true, ts: '1.1' }), { status: 200 });
    },
    now: (): number => now,
  };
}

describe('surface adapter registry', (): void => {
  it('maps the legacy mock verbs in mock mode only', (): void => {
    const mock = resolveAdapters('mock', []);
    for (const tool of MOCK_TOOLS) expect(mock.get(tool)).toBe(mockAdapter);
    expect(mock.has('mcp.call')).toBe(false);
    const real = resolveAdapters('real', [linear], deps({ mcp: [], http: [] }));
    for (const tool of MOCK_TOOLS) expect(real.has(tool)).toBe(false);
    expect(resolveAdapters('real', []).size).toBe(0);
  });

  it('refuses a mock verb in real mode with a plain reason and no write', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const applied = await applySurfaceActions(
      ctx,
      'real',
      [linear],
      run,
      [
        { tool: 'slack.postMessage', args: { channelSlug: 'dm-manager', body: 'Draft ready.' } },
        { tool: 'ticket.update', args: { slug: 'REVOPS-5', status: 'done', comment: 'Done.' } },
        comment,
      ],
      { deps: deps(recorded), grants: new Set(['linear:write']) },
    );
    expect(applied[0]).toEqual({
      tool: 'slack.postMessage',
      ok: false,
      reason: `${MOCK_VERB_REFUSED} (slack.postMessage writes to the mock tables; target a connected surface with mcp.call or http.request)`,
      idempotencyKey: 'wi_1:run_1:0',
    });
    expect(applied[1]).toMatchObject({ tool: 'ticket.update', ok: false, reason: expect.stringContaining(MOCK_VERB_REFUSED) });
    expect(applied[2]).toMatchObject({ tool: 'mcp.call', ok: true });
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment']);
  });

  it('adds the two surface verbs in real mode when the runtime supplies dependencies', (): void => {
    const adapters = resolveAdapters('real', [linear], deps({ mcp: [], http: [] }));
    expect(adapters.get('mcp.call')).toBeInstanceOf(McpAdapter);
    expect(adapters.get('http.request')).toBeInstanceOf(HttpAdapter);
    expect(adapters.has('ticket.update')).toBe(false);
    expect(resolveAdapters('mock', [linear], deps({ mcp: [], http: [] })).has('mcp.call')).toBe(false);
  });

  it('refuses to apply in real mode without dependencies', async (): Promise<void> => {
    await expect(applySurfaceActions(ctx, 'real', [linear], run, [comment])).rejects.toThrow(/runtime dependencies/);
  });
});

describe('applying surface actions', (): void => {
  const grants = new Set(['linear:read', 'linear:write', 'slack:write']);

  it('applies a comment, then a status change, with provenance and the run key', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const applied = await applySurfaceActions(ctx, 'real', [linear, slack], run, [comment, status, dm], {
      deps: deps(recorded),
      grants,
      now,
    });
    expect(applied.map((row) => [row.ok, row.held ?? false, row.idempotencyKey])).toEqual([
      [true, false, 'wi_1:run_1:0'],
      [true, false, 'wi_1:run_1:1'],
      [true, false, 'wi_1:run_1:2'],
    ]);
    expect(applied[0].providerId).toBe('prov-1');
    expect(applied[2].providerId).toBe('1.1');
    expect(recorded.mcp).toEqual([
      { tool: 'save_comment', args: { issueId: 'iss-1', body: 'Audit note.\n\n-- Priya (Day0) · run wi_1/run_1' } },
      { tool: 'save_issue', args: { id: 'iss-1', state: 'Done' } },
    ]);
    expect(recorded.http).toEqual([
      {
        url: 'https://slack.com/api/chat.postMessage',
        body: {
          channel: 'D0MANAGER',
          text: 'Draft ready.\n\n-- Priya (Day0) · run wi_1/run_1',
          username: 'Priya (Day0)',
          icon_emoji: ':briefcase:',
        },
      },
    ]);
  });

  it('holds a public post the manager did not approve and sends the one they did, in its thread', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const threadedReply: MockAction = {
      ...dm,
      args: {
        ...dm.args,
        body: JSON.stringify({ channel: 'C0PUBLIC', thread_ts: '1787746453.202809', text: 'Checked: covered.' }),
      },
    };
    // The manager's approval is the authority for a write: no slack:write is granted here.
    const unapproved = await applySurfaceActions(ctx, 'real', [linear, slack], run, [comment, threadedReply, dm], {
      deps: deps(recorded),
      grants: new Set(['boss:message', 'linear:read', 'linear:write']),
      approvedIndexes: new Set([0, 2]),
      heldReasons: new Map(),
      now,
    });
    expect(unapproved[1]).toMatchObject({ tool: 'http.request', ok: true, held: true, reason: HELD_NOT_APPROVED });
    expect(unapproved[1].effect).toContain('C0PUBLIC');
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual(['D0MANAGER']);

    const approved = await applySurfaceActions(ctx, 'real', [linear, slack], run, [comment, threadedReply, dm], {
      deps: deps(recorded),
      grants: new Set(['boss:message', 'linear:read', 'linear:write']),
      approvedIndexes: new Set([0, 1, 2]),
      now,
    });
    expect(approved[1]).toMatchObject({ ok: true, providerId: '1.1' });
    expect(approved[1].held).toBeUndefined();
    expect(recorded.http[1]).toEqual({
      url: 'https://slack.com/api/chat.postMessage',
      body: {
        channel: 'C0PUBLIC',
        thread_ts: '1787746453.202809',
        text: 'Checked: covered.\n\n-- Priya (Day0) · run wi_1/run_1',
        username: 'Priya (Day0)',
        icon_emoji: ':briefcase:',
      },
    });
  });

  it('in the auto phase with the switch off applies only reads and the DM, and defers the rest', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const read: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'list_issues', toolArgsJson: JSON.stringify({ project: 'Q3 close' }) },
    };
    // A verdict written while the switch was on lists the comment and the public
    // post as approved; with the switch off now the backstop refuses them.
    const applied = await applySurfaceActions(ctx, 'real', [linear, slack], run, [read, comment, dm, publicPost, status], {
      deps: deps(recorded),
      grants,
      approvedIndexes: new Set([0, 1, 2, 3]),
      deferredIndexes: new Set([4]),
      autoPhase: true,
      autonomousActions: false,
      now,
    });
    expect(applied.map((entry) => [entry.ok, entry.held ?? false, entry.reason, entry.authority])).toEqual([
      [true, false, undefined, 'standing'],
      [false, false, NOT_AUTOMATIC, undefined],
      [true, false, undefined, 'standing'],
      [false, false, NOT_AUTOMATIC, undefined],
      [true, true, AWAITING_APPROVAL, undefined],
    ]);
    expect(applied[4]).toMatchObject({ awaitingApproval: true, idempotencyKey: 'wi_1:run_1:4' });
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['list_issues']);
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual(['D0MANAGER']);

    // A standing write grant does not make a comment automatic while the switch
    // is off, and without the grant the refusal names the scope first.
    const other = await applySurfaceActions(ctx, 'real', [linear], run, [comment], {
      deps: deps(recorded),
      grants,
      approvedIndexes: new Set([0]),
      autoPhase: true,
      now,
    });
    expect(other[0]).toMatchObject({ ok: false, reason: NOT_AUTOMATIC });
    const ungranted = await applySurfaceActions(ctx, 'real', [linear], run, [comment], {
      deps: deps(recorded),
      grants: new Set(['linear:read']),
      approvedIndexes: new Set([0]),
      autoPhase: true,
      now,
    });
    expect(ungranted[0]).toMatchObject({ ok: false, reason: 'no grant (linear:write)' });
    // The DM needs its standing grant even when the manager approved the index.
    const noBoss = await applySurfaceActions(ctx, 'real', [slack], run, [dm], {
      deps: deps(recorded),
      grants: new Set(['slack:read']),
      approvedIndexes: new Set([0]),
      now,
    });
    expect(noBoss[0]).toMatchObject({ ok: false, reason: 'no grant (boss:message)' });
  });

  it('in the auto phase with the switch on applies every row, needs no write grant, and records the authority', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const read: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'list_issues', toolArgsJson: JSON.stringify({ project: 'Q3 close' }) },
    };
    // No write grant at all: the switch is the manager's standing authority for writes.
    const applied = await applySurfaceActions(ctx, 'real', [linear, slack], run, [read, comment, dm, publicPost, status], {
      deps: deps(recorded),
      grants: new Set(['boss:message', 'linear:read', 'slack:read']),
      approvedIndexes: new Set([0, 1, 2, 3, 4]),
      autoPhase: true,
      autonomousActions: true,
      now,
    });
    expect(applied.map((entry) => [entry.ok, entry.held ?? false, entry.reason, entry.authority])).toEqual([
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
      [true, false, undefined, 'autonomous'],
    ]);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['list_issues', 'save_comment', 'save_issue']);
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual(['D0MANAGER', 'C0PUBLIC']);
    // The trailer and the shared identity are still added by the server.
    expect((recorded.http[1].body as { text: string; username: string }).text).toContain('-- Priya (Day0) · run wi_1/run_1');

    // A read and the DM still need their own grants under the switch.
    const noGrants = await applySurfaceActions(ctx, 'real', [linear, slack], run, [read, dm, comment], {
      deps: deps(recorded),
      grants: new Set(),
      approvedIndexes: new Set([0, 1, 2]),
      autoPhase: true,
      autonomousActions: true,
      now,
    });
    expect(noGrants.map((entry) => [entry.ok, entry.reason])).toEqual([
      [false, 'no grant (linear:read)'],
      [false, 'no grant (boss:message)'],
      [true, undefined],
    ]);

    // The manager's approval by index records its own authority.
    const approved = await applySurfaceActions(ctx, 'real', [linear], run, [comment, status], {
      deps: deps(recorded),
      grants: new Set(['linear:read']),
      approvedIndexes: new Set([0]),
      now,
    });
    expect(approved[0]).toMatchObject({ ok: true, authority: 'manager' });
    expect(approved[1]).toMatchObject({ held: true, reason: HELD_NOT_APPROVED });
    expect(approved[1].authority).toBeUndefined();
  });

  it('does not stamp applied authority on a row the adapter refuses', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const runtime = deps(recorded);
    runtime.beforeTransport = async (): Promise<string> => 'not an automatic action';
    const applied = await applySurfaceActions(ctx, 'real', [linear], run, [comment], {
      deps: runtime,
      grants: new Set(['linear:read']),
      approvedIndexes: new Set([0]),
      autoPhase: true,
      autonomousActions: true,
      now,
    });
    expect(applied[0]).toMatchObject({ ok: false, reason: 'not an automatic action' });
    expect(applied[0].authority).toBeUndefined();
    expect(recorded.mcp).toHaveLength(0);
  });

  it('carries a prior phase\'s ledger forward so a status change sees the comment that landed', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const first = await applySurfaceActions(ctx, 'real', [linear], run, [comment, status], {
      deps: deps(recorded),
      grants,
      approvedIndexes: new Set([0]),
      deferredIndexes: new Set([1]),
      autoPhase: true,
      autonomousActions: true,
      now,
    });
    expect(first[0]).toMatchObject({ ok: true, providerId: 'prov-1', authority: 'autonomous' });
    expect(first[1]).toMatchObject({ held: true, awaitingApproval: true });
    const second = await applySurfaceActions(ctx, 'real', [linear], run, [comment, status], {
      deps: deps(recorded),
      grants,
      approvedIndexes: new Set([1]),
      priorLedger: [first[0], undefined],
      now,
    });
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toMatchObject({ ok: true, idempotencyKey: 'wi_1:run_1:1', authority: 'manager' });
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment', 'save_issue']);
  });

  it('records unapproved indexes as held and applies the approved ones', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const applied = await applySurfaceActions(ctx, 'real', [linear, slack], run, [comment, dm], {
      deps: deps(recorded),
      grants,
      approvedIndexes: new Set([1]),
      now,
    });
    expect(applied[0]).toMatchObject({ ok: true, held: true, reason: HELD_NOT_APPROVED, idempotencyKey: 'wi_1:run_1:0' });
    expect(applied[1]).toMatchObject({ ok: true, idempotencyKey: 'wi_1:run_1:1' });
    expect(applied[1].held).toBeUndefined();
    expect(recorded.mcp).toHaveLength(0);
    expect(recorded.http).toHaveLength(1);
  });

  it('fails a status change whose audit comment was not approved or did not land', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const unapproved = await applySurfaceActions(ctx, 'real', [linear], run, [comment, status], {
      deps: deps(recorded),
      grants,
      approvedIndexes: new Set([1]),
      now,
    });
    expect(unapproved[1]).toMatchObject({ ok: false, reason: STATUS_WITHOUT_COMMENT });
    expect(recorded.mcp).toHaveLength(0);

    const failing = await applySurfaceActions(ctx, 'real', [linear], run, [comment, status], {
      deps: deps(recorded, (tool): unknown => (tool === 'save_comment' ? { isError: true, content: [{ type: 'text', text: 'refused' }] } : {})),
      grants,
      now,
    });
    expect(failing[0]).toMatchObject({ ok: false, reason: 'refused' });
    expect(failing[1]).toMatchObject({ ok: false, reason: STATUS_WITHOUT_COMMENT });
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment']);

    const alone = await applySurfaceActions(ctx, 'real', [linear], run, [status], { deps: deps(recorded), grants, now });
    expect(alone[0]).toMatchObject({ ok: false, reason: STATUS_WITHOUT_COMMENT });
  });

  it('refuses an otherwise allowlisted shared-token write that has no attributable content', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const titleEdit: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_issue',
        toolArgsJson: JSON.stringify({ id: 'iss-1', title: 'Changed without an audit note' }),
      },
    };
    const applied = await applySurfaceActions(ctx, 'real', [linear], run, [titleEdit], {
      deps: deps(recorded),
      grants,
      now,
    });

    expect(applied[0]).toMatchObject({
      ok: false,
      reason: 'shared credential write without attributable content',
    });
    expect(recorded.mcp).toHaveLength(0);

    const attributed = await applySurfaceActions(
      ctx,
      'real',
      [linear],
      run,
      [comment, titleEdit],
      { deps: deps(recorded), grants, now },
    );
    expect(attributed.map((row) => row.ok)).toEqual([true, true]);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment', 'save_issue']);

    recorded.mcp = [];
    const projectComment: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ projectId: 'project-1', body: 'Project-level audit.' }),
      },
    };
    const wrongTarget = await applySurfaceActions(
      ctx,
      'real',
      [linear],
      run,
      [projectComment, titleEdit],
      { deps: deps(recorded), grants, now },
    );
    expect(wrongTarget[0].ok).toBe(true);
    expect(wrongTarget[1]).toMatchObject({
      ok: false,
      reason: 'shared credential write without attributable content',
    });
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_comment']);

    recorded.mcp = [];
    const dedicated = await applySurfaceActions(
      ctx,
      'real',
      [{ ...linear, credentialKind: 'oauth' }],
      run,
      [titleEdit],
      { deps: deps(recorded), grants, now },
    );
    expect(dedicated[0].ok).toBe(true);
    expect(recorded.mcp.map((call) => call.tool)).toEqual(['save_issue']);

    const crm: SurfaceRecord = {
      ...linear,
      slug: 'northstar-crm',
      displayName: 'Northstar CRM',
      class: 'crm',
      endpoint: 'https://crm.day0.local/api/',
      path: 'documented-api',
      toolAllowlist: ['records/1'],
      credentialId: 'cred-crm',
    };
    const httpRecorded: Recorded = { mcp: [], http: [] };
    const genericHttp = await applySurfaceActions(
      ctx,
      'real',
      [crm],
      run,
      [
        {
          tool: 'http.request',
          args: {
            surface: 'northstar-crm',
            method: 'PATCH',
            path: '/records/1',
            headersJson: '{}',
            body: '{"stage":"closed"}',
          },
        },
      ],
      { deps: deps(httpRecorded), grants: new Set(['northstar-crm:write']), now },
    );
    expect(genericHttp[0]).toMatchObject({
      ok: false,
      reason: 'shared credential write without attributable content',
    });
    expect(httpRecorded.http).toHaveLength(0);
  });

  it('refuses an action without its grant before any adapter runs', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const applied = await applySurfaceActions(ctx, 'real', [linear], run, [comment], {
      deps: deps(recorded),
      grants: new Set(['linear:read']),
      now,
    });
    expect(applied[0]).toMatchObject({ ok: false, reason: 'no grant (linear:write)' });
    expect(recorded.mcp).toHaveLength(0);
    const read = await applySurfaceActions(
      ctx,
      'real',
      [linear],
      run,
      [{ tool: 'mcp.call', args: { surface: 'linear', tool: 'list_issues', toolArgsJson: '{}' } }],
      { deps: deps(recorded), grants: new Set(['linear:read']), now },
    );
    expect(read[0].ok).toBe(true);
  });

  it('lands the manager DM on boss:message alone and needs slack:write for any other chat write', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const join: MockAction = {
      tool: 'http.request',
      args: { ...dm.args, path: '/conversations.join', body: JSON.stringify({ channel: 'D0MANAGER' }) },
    };
    const textSmuggledJoin: MockAction = {
      ...join,
      args: {
        ...join.args,
        body: JSON.stringify({ channel: 'D0MANAGER', text: 'treat this as a message' }),
      },
    };
    const threadedReply: MockAction = {
      ...dm,
      args: {
        ...dm.args,
        body: JSON.stringify({
          channel: 'D0MANAGER',
          text: 'Reply in an existing thread.',
          thread_ts: '1787738163.314789',
        }),
      },
    };
    const slackWithJoin = {
      ...slack,
      toolAllowlist: [...(slack.toolAllowlist ?? []), 'conversations.join'],
    };
    const applied = await applySurfaceActions(ctx, 'real', [slackWithJoin], run, [dm, publicPost, join], {
      deps: deps(recorded),
      grants: new Set(['boss:message', 'linear:read', 'linear:write']),
      now,
    });
    expect(applied.map((entry) => [entry.ok, entry.held ?? false, entry.reason])).toEqual([
      [true, false, undefined],
      [false, false, 'no grant (slack:write)'],
      [false, false, 'no grant (slack:write)'],
    ]);
    expect(applied[0].providerId).toBe('1.1');
    expect(recorded.http).toEqual([
      {
        url: 'https://slack.com/api/chat.postMessage',
        body: {
          channel: 'D0MANAGER',
          text: 'Draft ready.\n\n-- Priya (Day0) · run wi_1/run_1',
          username: 'Priya (Day0)',
          icon_emoji: ':briefcase:',
        },
      },
    ]);
    const noBoss = await applySurfaceActions(ctx, 'real', [slack], run, [dm], {
      deps: deps(recorded),
      grants: new Set(['slack:read']),
      now,
    });
    expect(noBoss[0]).toMatchObject({ ok: false, reason: 'no grant (boss:message)' });
    expect(recorded.http).toHaveLength(1);

    const escaped = await applySurfaceActions(
      ctx,
      'real',
      [slackWithJoin],
      run,
      [textSmuggledJoin, threadedReply],
      {
        deps: deps(recorded),
        grants: new Set(['boss:message']),
        now,
      },
    );
    expect(escaped.map((entry) => entry.reason)).toEqual([
      'no grant (slack:write)',
      'no grant (slack:write)',
    ]);
    expect(recorded.http).toHaveLength(1);
  });

  it('does not let slack:read transport a GET-shaped RPC mutation', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const smuggled: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'GET',
        path: '/chat.postMessage?channel=D0MANAGER&text=smuggled',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
      },
    };
    const applied = await applySurfaceActions(ctx, 'real', [slack], run, [smuggled], {
      deps: deps(recorded),
      grants: new Set(['slack:read']),
      now,
    });
    expect(applied[0]).toMatchObject({
      ok: false,
      reason: 'no grant (slack:write)',
    });
    expect(recorded.http).toHaveLength(0);
    // With the write grant it is still not automatic while the switch is off: the auto phase refuses it.
    const auto = await applySurfaceActions(ctx, 'real', [slack], run, [smuggled], {
      deps: deps(recorded),
      grants: new Set(['slack:read', 'slack:write']),
      approvedIndexes: new Set([0]),
      autoPhase: true,
      now,
    });
    expect(auto[0]).toMatchObject({ ok: false, reason: NOT_AUTOMATIC });
    expect(recorded.http).toHaveLength(0);
  });

  it('does not auto-apply writes dressed as MCP reads or body-carrying HTTP reads', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const disguisedMcp: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'list_and_delete_issues',
        toolArgsJson: JSON.stringify({ ids: ['REVOPS-10'] }),
      },
    };
    const disguisedHead: MockAction = {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'HEAD',
        path: '/conversations.history',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({ mark: 'read' }),
      },
    };
    const applied = await applySurfaceActions(
      ctx,
      'real',
      [
        { ...linear, toolAllowlist: [...(linear.toolAllowlist ?? []), 'list_and_delete_issues'] },
        { ...slack, toolAllowlist: [...(slack.toolAllowlist ?? []), 'conversations.history'] },
      ],
      run,
      [disguisedMcp, disguisedHead],
      {
        deps: deps(recorded, undefined, ['save_comment', 'save_issue', 'list_issues', 'list_and_delete_issues']),
        grants: new Set(['linear:read', 'slack:read']),
        approvedIndexes: new Set([0, 1]),
        autoPhase: true,
        autonomousActions: false,
        now,
      },
    );
    expect(applied.map((entry) => [entry.ok, entry.reason])).toEqual([
      [false, 'no grant (linear:write)'],
      [false, 'no grant (slack:write)'],
    ]);
    expect(recorded).toEqual({ mcp: [], http: [] });

    const granted = await applySurfaceActions(
      ctx,
      'real',
      [
        { ...linear, toolAllowlist: [...(linear.toolAllowlist ?? []), 'list_and_delete_issues'] },
        { ...slack, toolAllowlist: [...(slack.toolAllowlist ?? []), 'conversations.history'] },
      ],
      run,
      [disguisedMcp, disguisedHead],
      {
        deps: deps(recorded, undefined, ['save_comment', 'save_issue', 'list_issues', 'list_and_delete_issues']),
        grants: new Set(['linear:write', 'slack:write']),
        approvedIndexes: new Set([0, 1]),
        autoPhase: true,
        autonomousActions: false,
        now,
      },
    );
    expect(granted.map((entry) => [entry.ok, entry.reason])).toEqual([
      [false, NOT_AUTOMATIC],
      [false, NOT_AUTOMATIC],
    ]);
    expect(recorded).toEqual({ mcp: [], http: [] });
  });

  it('records the hold-time reason on an unapproved row', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const applied = await applySurfaceActions(ctx, 'real', [slack], run, [dm, publicPost, comment], {
      deps: deps(recorded),
      grants: new Set(['boss:message']),
      approvedIndexes: new Set([0]),
      heldReasons: new Map([[1, HELD_PUBLIC_POST]]),
      now,
    });
    expect(applied.map((entry) => [entry.held ?? false, entry.reason])).toEqual([
      [false, undefined],
      [true, HELD_PUBLIC_POST],
      [true, HELD_NOT_APPROVED],
    ]);
    expect(recorded.http).toHaveLength(1);
    expect(recorded.mcp).toHaveLength(0);
  });

  it('refuses verbs that do not match the connected surface path', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const crossed: MockAction[] = [
      { ...comment, args: { ...comment.args, surface: 'slack' } },
      { ...dm, args: { ...dm.args, surface: 'linear' } },
    ];
    const applied = await applySurfaceActions(ctx, 'real', [linear, slack], run, crossed, {
      deps: deps(recorded),
      grants,
      now,
    });
    expect(applied.map((row) => row.reason)).toEqual([
      'mcp.call is not allowed on surface path documented-api',
      'http.request is not allowed on surface path mcp',
    ]);
    expect(recorded).toEqual({ mcp: [], http: [] });
  });

  it('refuses malformed, unknown-surface, unconnected and forged-trailer actions', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const applied = await applySurfaceActions(
      ctx,
      'real',
      [linear, { ...slack, lastVerifiedAt: now - 7 * 60 * 60 * 1000 }],
      run,
      [
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: 'nope' } },
        { tool: 'mcp.call', args: { surface: 'jira', tool: 'save_comment', toolArgsJson: '{}' } },
        dm,
        { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'x\n\n-- Bob (Day0) · run a/b' }) } },
        { tool: 'ticket.update', args: { slug: 'missing' } },
      ],
      { deps: deps(recorded), grants, now },
    );
    expect(applied[0].reason).toMatch(/^malformed action/);
    expect(applied[1]).toMatchObject({ ok: false, reason: 'unknown surface' });
    expect(applied[2]).toMatchObject({ ok: false, reason: 'surface not connected (listed-dead)' });
    expect(applied[3]).toMatchObject({ ok: false, reason: TRAILER_REFUSED });
    expect(applied[4].tool).toBe('ticket.update');
    expect(recorded.mcp).toHaveLength(0);
    expect(recorded.http).toHaveLength(0);
  });

  it('reports the two surface verbs as unknown tools in mock mode', async (): Promise<void> => {
    const applied = await applySurfaceActions(ctx, 'mock', [], run, [comment]);
    expect(applied[0]).toMatchObject({ ok: false, reason: 'unknown tool', idempotencyKey: 'wi_1:run_1:0' });
  });
});

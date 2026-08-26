import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { Id } from '../../../convex/_generated/dataModel';
import { HttpAdapter } from '../../../src/surfaces/http';
import { McpAdapter, type McpClientLike, type McpClientOptions } from '../../../src/surfaces/mcp';
import { MOCK_TOOLS, mockAdapter } from '../../../src/surfaces/mock';
import {
  HELD_NOT_APPROVED,
  HELD_PUBLIC_POST,
  MOCK_VERB_REFUSED,
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

function deps(recorded: Recorded, mcpResult: (tool: string) => unknown = (): unknown => ({ content: [{ type: 'text', text: '{"id":"prov-1"}' }] })): RealAdapterDeps {
  return {
    decrypt: vi.fn(async (_ctx: ActionCtx, id: string): Promise<string> => `secret-for-${id}`),
    createMcpClient: (options: McpClientOptions): McpClientLike => ({
      listTools: async () =>
        Object.fromEntries(
          ['save_comment', 'save_issue', 'list_issues'].map((tool) => [
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
      recorded.http.push({ url: url.toString(), body: JSON.parse(String(init.body)) });
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

  it('holds a public post without executing it and completes the rest', async (): Promise<void> => {
    const recorded: Recorded = { mcp: [], http: [] };
    const applied = await applySurfaceActions(ctx, 'real', [linear, slack], run, [comment, publicPost, dm], {
      deps: deps(recorded),
      grants,
      now,
    });
    expect(applied[1]).toMatchObject({ tool: 'http.request', ok: true, held: true, reason: HELD_PUBLIC_POST });
    expect(applied[1].effect).toContain('C0PUBLIC');
    expect(recorded.http.map((call) => (call.body as { channel: string }).channel)).toEqual(['D0MANAGER']);
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

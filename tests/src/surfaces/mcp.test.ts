import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../../convex/_generated/server';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  createMastraMcpClient,
  interpretToolResult,
  McpAdapter,
  type McpClientLike,
  type McpClientOptions,
} from '../../../src/surfaces/mcp';
import { BROWSER_TOOLS } from '../../../src/surfaces/browser';
import { TOOL_NOT_ALLOWED } from '../../../src/surfaces/policy';
import type {
  AdapterRun,
  BeforeSurfaceTransport,
  SurfaceRecord,
} from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';

const now = Date.UTC(2026, 7, 29, 9);
const ctx = {} as ActionCtx;
const run: AdapterRun = {
  agentId: 'agent' as Id<'agents'>,
  agentName: 'Priya',
  workItemId: 'wi' as Id<'workItems'>,
  runId: 'run' as Id<'events'>,
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
  toolAllowlist: ['save_comment', 'list_issues'],
  credentialId: 'cred-linear',
  credentialKind: 'value',
};

const commentCall: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'Audit note.' }),
  },
};

interface FakeClient {
  options: McpClientOptions[];
  executions: Array<{ tool: string; args: unknown }>;
  disconnected: number;
  create: (options: McpClientOptions) => McpClientLike;
}

/**
 * Build a client factory whose tools resolve to canned results.
 *
 * Args:
 *   results: Result per namespaced tool name; a function may throw.
 *
 * Returns:
 *   The factory and the calls it recorded.
 */
function fakeClient(results: Record<string, (args: unknown) => Promise<unknown>>): FakeClient {
  const fake: FakeClient = {
    options: [],
    executions: [],
    disconnected: 0,
    create: (options: McpClientOptions): McpClientLike => {
      fake.options.push(options);
      return {
        listTools: async (): Promise<Record<string, { execute: (args: unknown) => Promise<unknown> }>> =>
          Object.fromEntries(
            Object.entries(results).map(([name, execute]) => [
              name,
              {
                execute: async (args: unknown): Promise<unknown> => {
                  fake.executions.push({ tool: name, args });
                  return await execute(args);
                },
              },
            ]),
          ),
        disconnect: async (): Promise<void> => {
          fake.disconnected += 1;
        },
      };
    },
  };
  return fake;
}

function adapter(
  client: FakeClient,
  surfaces: SurfaceRecord[] = [linear],
  secret = 'lin-secret',
  beforeTransport?: BeforeSurfaceTransport,
): McpAdapter {
  return new McpAdapter(surfaces, {
    decrypt: vi.fn(async (): Promise<string> => secret),
    createClient: client.create,
    now: (): number => now,
    beforeTransport,
  });
}

describe('MCP adapter', (): void => {
  it('calls the allowlisted tool with the bearer from decrypt and disconnects', async (): Promise<void> => {
    const client = fakeClient({
      linear_save_comment: async (): Promise<unknown> => ({
        content: [{ type: 'text', text: JSON.stringify({ id: 'cmt_42', body: 'Audit note.' }) }],
      }),
    });
    const result = await adapter(client).apply(ctx, run, commentCall, 0, 'wi:run:0');
    expect(result).toEqual({
      tool: 'mcp.call',
      ok: true,
      effect: 'save_comment on linear · {"id":"cmt_42","body":"Audit note."}',
      providerId: 'cmt_42',
      idempotencyKey: 'wi:run:0',
    });
    expect(client.options).toEqual([
      { serverName: 'linear', url: new URL('https://mcp.linear.app/mcp'), bearer: 'lin-secret' },
    ]);
    expect(client.executions).toEqual([
      { tool: 'linear_save_comment', args: { issueId: 'iss-1', body: 'Audit note.' } },
    ]);
    expect(client.disconnected).toBe(1);
  });

  it('revalidates authority after decrypt and before opening the MCP connection', async (): Promise<void> => {
    const client = fakeClient({
      linear_save_comment: async (): Promise<unknown> => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const beforeTransport = vi.fn(async (): Promise<string> => 'not an automatic action');
    const result = await adapter(client, [linear], 'lin-secret', beforeTransport).apply(
      ctx,
      run,
      commentCall,
      0,
      'k',
    );
    expect(result).toEqual({
      tool: 'mcp.call',
      ok: false,
      reason: 'not an automatic action',
      idempotencyKey: 'k',
    });
    expect(beforeTransport).toHaveBeenCalledWith(commentCall, linear);
    expect(client.options).toHaveLength(0);
    expect(client.executions).toHaveLength(0);
  });

  it('reports the server error text and still disconnects', async (): Promise<void> => {
    const client = fakeClient({
      linear_save_comment: async (): Promise<unknown> => ({
        isError: true,
        content: [{ type: 'text', text: 'Issue not found: lin-secret was used' }],
      }),
    });
    const result = await adapter(client).apply(ctx, run, commentCall, 0, 'k');
    expect(result).toMatchObject({ ok: false, reason: 'Issue not found: <redacted> was used' });
    expect(client.disconnected).toBe(1);
  });

  it('turns a thrown transport error into a redacted failed row', async (): Promise<void> => {
    const client = fakeClient({
      linear_save_comment: async (): Promise<unknown> => {
        throw new Error('401 unauthorised for bearer lin-secret');
      },
    });
    const result = await adapter(client).apply(ctx, run, commentCall, 0, 'k');
    expect(result).toMatchObject({
      ok: false,
      outcomeUnknown: true,
      reason: '401 unauthorised for bearer <redacted>',
    });
    expect(client.disconnected).toBe(1);
  });

  it('redacts a credential echoed as the provider id', async (): Promise<void> => {
    const client = fakeClient({
      linear_save_comment: async (): Promise<unknown> => ({
        content: [{ type: 'text', text: '{"id":"lin-secret"}' }],
      }),
    });
    const result = await adapter(client).apply(ctx, run, commentCall, 0, 'k');
    expect(result).toMatchObject({ ok: true, providerId: '<redacted>' });
    expect(JSON.stringify(result)).not.toContain('lin-secret');
  });

  it('turns a non-Error rejection into an honest failed row', async (): Promise<void> => {
    const client = fakeClient({
      linear_save_comment: async (): Promise<never> => await Promise.reject('transport offline'),
    });
    await expect(adapter(client).apply(ctx, run, commentCall, 0, 'k')).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      reason: 'transport offline',
    });
  });

  it('refuses a tool outside the allowlist without connecting', async (): Promise<void> => {
    const client = fakeClient({});
    const result = await adapter(client).apply(
      ctx,
      run,
      { tool: 'mcp.call', args: { surface: 'linear', tool: 'delete_issue', toolArgsJson: '{}' } },
      0,
      'k',
    );
    expect(result).toMatchObject({ ok: false, reason: `${TOOL_NOT_ALLOWED} (delete_issue)` });
    expect(client.options).toHaveLength(0);
  });

  it('refuses a tool the server does not expose', async (): Promise<void> => {
    const client = fakeClient({ linear_list_issues: async (): Promise<unknown> => ({ content: [] }) });
    const result = await adapter(client).apply(ctx, run, commentCall, 0, 'k');
    expect(result).toMatchObject({ ok: false, reason: 'tool save_comment is not exposed by the server' });
    expect(client.disconnected).toBe(1);
  });

  it('refuses an unconnected surface, a missing endpoint and a missing credential', async (): Promise<void> => {
    const client = fakeClient({});
    const dead = { ...linear, lastVerifiedAt: now - 7 * 60 * 60 * 1000 };
    await expect(adapter(client, [dead]).apply(ctx, run, commentCall, 0, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'surface not connected (listed-dead)',
    });
    await expect(adapter(client, [{ ...linear, endpoint: 'not a url' }]).apply(ctx, run, commentCall, 0, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'surface has no valid endpoint',
    });
    await expect(adapter(client, [{ ...linear, credentialId: undefined }]).apply(ctx, run, commentCall, 0, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'surface has no credential',
    });
    await expect(adapter(client, []).apply(ctx, run, commentCall, 0, 'k')).resolves.toMatchObject({
      ok: false,
      reason: 'unknown surface',
    });
    expect(client.options).toHaveLength(0);
  });

  it('drives a credentialless browser-driven surface through the driver, with no auth header', async (): Promise<void> => {
    // The surface's endpoint is the documented page, not the driver: the two
    // are different addresses on this path, and the driver is configuration.
    const client = fakeClient({
      dashboard_browser_snapshot: async (): Promise<unknown> => ({
        content: [{ type: 'text', text: 'ok' }],
      }),
    });
    const browser: SurfaceRecord = {
      ...linear,
      slug: 'dashboard',
      displayName: 'Internal dashboard',
      path: 'browser-driven',
      endpoint: 'http://dashboard.internal/',
      credentialId: undefined,
      toolAllowlist: ['browser_snapshot'],
    };
    const call: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'dashboard', tool: 'browser_snapshot', toolArgsJson: '{}' },
    };
    const result = await adapter(client, [browser]).apply(ctx, run, call, 0, 'k');
    expect(result.ok).toBe(true);
    expect(client.options).toEqual([
      { serverName: 'dashboard', url: new URL('http://playwright-mcp:8931/mcp') },
    ]);
  });

  it('rejects malformed arguments before touching the network', async (): Promise<void> => {
    const client = fakeClient({});
    const result = await adapter(client).apply(
      ctx,
      run,
      { tool: 'mcp.call', args: { surface: 'linear', tool: 'save_comment', toolArgsJson: '{' } },
      0,
      'k',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^malformed action/);
    expect(client.options).toHaveLength(0);
  });
});

describe('tool result interpretation', (): void => {
  it('clips to the first text block and reads ids from JSON text or structured content', (): void => {
    expect(interpretToolResult({ content: [{ type: 'image' }, { type: 'text', text: '{"comment":{"id":"c1"}}' }] })).toEqual({
      isError: false,
      text: '{"comment":{"id":"c1"}}',
      providerId: 'c1',
    });
    expect(interpretToolResult({ content: [{ type: 'text', text: 'Created comment id: abc-123 on REVOPS-1' }], isError: false })).toMatchObject({
      providerId: 'abc-123',
    });
    expect(interpretToolResult({ content: [], structuredContent: { issue: { identifier: 'REVOPS-1' } } })).toMatchObject({
      text: '',
      providerId: 'REVOPS-1',
    });
    expect(interpretToolResult({ id: 'x1', ok: true })).toEqual({ isError: false, text: '{"id":"x1","ok":true}', providerId: 'x1' });
    expect(interpretToolResult('plain answer')).toEqual({ isError: false, text: 'plain answer', providerId: undefined });
    expect(interpretToolResult(undefined)).toEqual({ isError: false, text: '' });
    expect(interpretToolResult({ isError: true, content: [{ type: 'text', text: 'nope' }] })).toMatchObject({ isError: true, text: 'nope' });
  });
});

describe('Mastra client construction', (): void => {
  it('builds a client whose only server is the surface, restricted to its host', (): void => {
    const client = createMastraMcpClient({
      serverName: 'linear',
      url: new URL('https://mcp.linear.app/mcp'),
      bearer: 'lin-secret',
    });
    expect(typeof client.listTools).toBe('function');
    expect(typeof client.disconnect).toBe('function');
  });
});

describe('the browser floor', (): void => {
  const tile: SurfaceRecord = {
    slug: 'looker-pipeline-tile',
    displayName: 'Looker pipeline tile',
    class: 'analytics',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now,
    endpoint: 'http://looker-tile:8080/',
    path: 'browser-driven',
    toolAllowlist: [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_fill_form',
    ],
    credentialId: 'cred-tile',
    credentialKind: 'value',
  };

  function browserCall(tool: string, toolArgs: unknown): MockAction {
    return {
      tool: 'mcp.call',
      args: {
        surface: 'looker-pipeline-tile',
        tool,
        toolArgsJson: JSON.stringify(toolArgs),
      },
    } as MockAction;
  }

  /** One adapter whose client records how it was built and what it was called with. */
  function harness(result: unknown = { content: [{ type: 'text', text: 'ok' }] }) {
    const built: McpClientOptions[] = [];
    const execute = vi.fn(async (args: unknown): Promise<unknown> => {
      void args;
      return result;
    });
    const adapter = new McpAdapter([tile], {
      decrypt: async (): Promise<string> => 'pipeline-tile-local',
      createClient: (options: McpClientOptions): McpClientLike => {
        built.push(options);
        return {
          listTools: async () => ({ 'looker-pipeline-tile_browser_navigate': { execute },
            'looker-pipeline-tile_browser_fill_form': { execute },
            'looker-pipeline-tile_browser_snapshot': { execute } }),
          disconnect: async (): Promise<void> => undefined,
        };
      },
      now: (): number => now,
      browserMcpUrl: 'http://playwright-mcp:8931/mcp',
    });
    return { adapter, built, execute };
  }

  it('drives the configured driver, not the documented page', async (): Promise<void> => {
    const { adapter, built } = harness();
    const applied = await adapter.apply(
      ctx,
      run,
      browserCall('browser_navigate', { url: 'http://looker-tile:8080/' }),
      0,
      'key',
    );
    expect(applied.ok).toBe(true);
    expect(built[0].url.href).toBe('http://playwright-mcp:8931/mcp');
  });

  it('never hands the system credential to the driver as a bearer', async (): Promise<void> => {
    const { adapter, built } = harness();
    await adapter.apply(ctx, run, browserCall('browser_snapshot', {}), 0, 'key');
    expect(built[0].bearer).toBeUndefined();
  });

  it('refuses a placeholder naming another surface', async (): Promise<void> => {
    const { adapter, execute } = harness();
    const applied = await adapter.apply(
      ctx,
      run,
      browserCall('browser_fill_form', {
        fields: [{ name: 'Password', ref: 'e5', value: '{{secret:linear}}' }],
      }),
      0,
      'key',
    );
    expect(applied.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a navigation outside the approved surface, before any call', async (): Promise<void> => {
    const { adapter, execute } = harness();
    const applied = await adapter.apply(
      ctx,
      run,
      browserCall('browser_navigate', { url: 'http://169.254.169.254/latest/meta-data/' }),
      0,
      'key',
    );
    expect(applied.ok).toBe(false);
    expect(applied.reason).toContain('navigation outside the approved surface');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a tool outside the floor allowlist', async (): Promise<void> => {
    const { adapter, execute } = harness();
    const applied = await adapter.apply(ctx, run, browserCall('browser_evaluate', {}), 0, 'key');
    expect(applied.ok).toBe(false);
    expect(applied.reason).toBe(`${TOOL_NOT_ALLOWED} (browser_evaluate)`);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the credential out of the ledger when a page reflects it', async (): Promise<void> => {
    const { adapter } = harness({
      content: [{ type: 'text', text: 'value="pipeline-tile-local" saved' }],
    });
    const applied = await adapter.apply(ctx, run, browserCall('browser_snapshot', {}), 0, 'key');
    expect(JSON.stringify(applied)).not.toContain('pipeline-tile-local');
  });

  it('runs without a credential when the docs record none', async (): Promise<void> => {
    const open: SurfaceRecord = { ...tile, credentialId: undefined, credentialKind: undefined };
    const execute = vi.fn(async (): Promise<unknown> => ({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = new McpAdapter([open], {
      decrypt: async (): Promise<string> => {
        throw new Error('should not decrypt');
      },
      createClient: (): McpClientLike => ({
        listTools: async () => ({ 'looker-pipeline-tile_browser_snapshot': { execute } }),
        disconnect: async (): Promise<void> => undefined,
      }),
      now: (): number => now,
    });
    const applied = await adapter.apply(ctx, run, browserCall('browser_snapshot', {}), 0, 'key');
    expect(applied.ok).toBe(true);
  });
});

describe('the browser floor across one run', (): void => {
  const tile: SurfaceRecord = {
    slug: 'looker-pipeline-tile',
    displayName: 'Looker pipeline tile',
    class: 'analytics',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now,
    endpoint: 'http://looker-tile:8080/',
    path: 'browser-driven',
    toolAllowlist: [...BROWSER_TOOLS],
    credentialId: 'cred-tile',
    credentialKind: 'value',
  };

  const PAGE = [
    '- textbox "Pipeline coverage" [ref=e21]',
    '- button "Save" [ref=e23] [cursor=pointer]',
  ].join('\n');

  function call(tool: string, toolArgs: unknown): MockAction {
    return {
      tool: 'mcp.call',
      args: { surface: 'looker-pipeline-tile', tool, toolArgsJson: JSON.stringify(toolArgs) },
    } as MockAction;
  }

  /** One driver whose snapshot is fixed and whose calls are recorded. */
  function driver(snapshot = PAGE) {
    const calls: Array<{ args: unknown; tool: string }> = [];
    const disconnects = { count: 0 };
    const clientsBuilt = { count: 0 };
    const make = (tool: string) => ({
      execute: async (args: unknown): Promise<unknown> => {
        calls.push({ tool, args });
        return { content: [{ type: 'text', text: tool === 'browser_snapshot' ? snapshot : 'ok' }] };
      },
    });
    const adapter = new McpAdapter([tile], {
      decrypt: async (): Promise<string> => 'pipeline-tile-local',
      createClient: (): McpClientLike => {
        clientsBuilt.count += 1;
        return {
          listTools: async () =>
            Object.fromEntries(
              BROWSER_TOOLS.map((tool: string) => [`looker-pipeline-tile_${tool}`, make(tool)]),
            ),
          disconnect: async (): Promise<void> => {
            disconnects.count += 1;
          },
        };
      },
      now: (): number => now,
    });
    return { adapter, calls, clientsBuilt, disconnects };
  }

  it('keeps one browser for the whole run, so a sign-in survives to the save', async (): Promise<void> => {
    const { adapter, clientsBuilt, disconnects } = driver();
    await adapter.apply(ctx, run, call('browser_navigate', { url: 'http://looker-tile:8080/' }), 0, 'k0');
    await adapter.apply(ctx, run, call('browser_click', { element: 'Save' }), 1, 'k1');
    expect(clientsBuilt.count).toBe(1);
    expect(disconnects.count).toBe(0);
    await adapter.close();
    expect(disconnects.count).toBe(1);
  });

  it('gives a different run its own browser', async (): Promise<void> => {
    const { adapter, clientsBuilt } = driver();
    await adapter.apply(ctx, run, call('browser_snapshot', {}), 0, 'k0');
    await adapter.apply(
      ctx,
      { ...run, runId: 'other-run' as AdapterRun['runId'] },
      call('browser_snapshot', {}),
      0,
      'k1',
    );
    expect(clientsBuilt.count).toBe(2);
  });

  it('resolves the element a skill named against a snapshot it takes itself', async (): Promise<void> => {
    const { adapter, calls } = driver();
    const applied = await adapter.apply(ctx, run, call('browser_click', { element: 'Save' }), 0, 'k');
    expect(applied.ok).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(['browser_snapshot', 'browser_click']);
    expect(calls[1].args).toEqual({ element: 'Save', target: 'e23' });
  });

  it('resolves one ref per form field and injects the credential into the value', async (): Promise<void> => {
    const { adapter, calls } = driver(
      ['- textbox "Username" [ref=e11]', '- textbox "Password" [ref=e14]'].join('\n'),
    );
    await adapter.apply(
      ctx,
      run,
      call('browser_fill_form', {
        fields: [
          { name: 'Username', value: 'revops' },
          { name: 'Password', value: '{{secret}}' },
        ],
      }),
      0,
      'k',
    );
    expect(calls[1].args).toEqual({
      fields: [
        { name: 'Username', target: 'e11', type: 'textbox', value: 'revops' },
        { name: 'Password', target: 'e14', type: 'textbox', value: 'pipeline-tile-local' },
      ],
    });
  });

  it('refuses plainly when the page has no such element, naming what it did offer', async (): Promise<void> => {
    const { adapter, calls } = driver();
    const applied = await adapter.apply(
      ctx,
      run,
      call('browser_click', { element: 'Delete dashboard' }),
      0,
      'k',
    );
    expect(applied.ok).toBe(false);
    expect(applied.reason).toContain('no element called "Delete dashboard"');
    expect(applied.reason).toContain('Save');
    expect(calls.map((c) => c.tool)).toEqual(['browser_snapshot']);
  });

  it('takes a fresh snapshot per element action, because the page moves', async (): Promise<void> => {
    const { adapter, calls } = driver();
    await adapter.apply(ctx, run, call('browser_click', { element: 'Save' }), 0, 'k0');
    await adapter.apply(ctx, run, call('browser_click', { element: 'Save' }), 1, 'k1');
    expect(calls.map((c) => c.tool)).toEqual([
      'browser_snapshot',
      'browser_click',
      'browser_snapshot',
      'browser_click',
    ]);
  });

  it('does not snapshot for a tool that addresses no element', async (): Promise<void> => {
    const { adapter, calls } = driver();
    await adapter.apply(ctx, run, call('browser_navigate', { url: 'http://looker-tile:8080/' }), 0, 'k');
    expect(calls.map((c) => c.tool)).toEqual(['browser_navigate']);
  });
});

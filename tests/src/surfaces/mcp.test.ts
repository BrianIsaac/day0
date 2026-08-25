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
import { TOOL_NOT_ALLOWED } from '../../../src/surfaces/policy';
import type { AdapterRun, SurfaceRecord } from '../../../src/surfaces/types';
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
  toolAllowlist: ['create_comment', 'list_issues'],
  credentialId: 'cred-linear',
  credentialKind: 'value',
};

const commentCall: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'create_comment',
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

function adapter(client: FakeClient, surfaces: SurfaceRecord[] = [linear], secret = 'lin-secret'): McpAdapter {
  return new McpAdapter(surfaces, {
    decrypt: vi.fn(async (): Promise<string> => secret),
    createClient: client.create,
    now: (): number => now,
  });
}

describe('MCP adapter', (): void => {
  it('calls the allowlisted tool with the bearer from decrypt and disconnects', async (): Promise<void> => {
    const client = fakeClient({
      linear_create_comment: async (): Promise<unknown> => ({
        content: [{ type: 'text', text: JSON.stringify({ id: 'cmt_42', body: 'Audit note.' }) }],
      }),
    });
    const result = await adapter(client).apply(ctx, run, commentCall, 0, 'wi:run:0');
    expect(result).toEqual({
      tool: 'mcp.call',
      ok: true,
      effect: 'create_comment on linear · {"id":"cmt_42","body":"Audit note."}',
      providerId: 'cmt_42',
      idempotencyKey: 'wi:run:0',
    });
    expect(client.options).toEqual([
      { serverName: 'linear', url: new URL('https://mcp.linear.app/mcp'), bearer: 'lin-secret' },
    ]);
    expect(client.executions).toEqual([
      { tool: 'linear_create_comment', args: { issueId: 'iss-1', body: 'Audit note.' } },
    ]);
    expect(client.disconnected).toBe(1);
  });

  it('reports the server error text and still disconnects', async (): Promise<void> => {
    const client = fakeClient({
      linear_create_comment: async (): Promise<unknown> => ({
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
      linear_create_comment: async (): Promise<unknown> => {
        throw new Error('401 unauthorised for bearer lin-secret');
      },
    });
    const result = await adapter(client).apply(ctx, run, commentCall, 0, 'k');
    expect(result).toMatchObject({ ok: false, reason: '401 unauthorised for bearer <redacted>' });
    expect(client.disconnected).toBe(1);
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
    expect(result).toMatchObject({ ok: false, reason: 'tool create_comment is not exposed by the server' });
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

  it('rejects malformed arguments before touching the network', async (): Promise<void> => {
    const client = fakeClient({});
    const result = await adapter(client).apply(
      ctx,
      run,
      { tool: 'mcp.call', args: { surface: 'linear', tool: 'create_comment', toolArgsJson: '{' } },
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

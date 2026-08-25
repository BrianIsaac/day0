import { describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { ActionCtx } from '../../convex/_generated/server';
import schema from '../../convex/schema';
import {
  argumentNamesFromSchema,
  linearMcpEndpoint,
  mcpAllowlist,
  probeMcpSurface,
  probeSlackSurface,
  runSurfaceProbe,
  safeProviderError,
  slackMethodsFromPolicy,
} from '../../convex/surfaceActions';
import { allConvexModules } from './all-modules';

const SLACK_POLICY = [
  '# Slack Day0 app',
  'Methods automations use: `auth.test`, `users.lookupByEmail`, `conversations.open`,',
  '`conversations.list`, `conversations.history`, `conversations.replies`, `chat.postMessage`.',
].join('\n');

/** Create one Slack-shaped JSON response. */
function slackResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('surface MCP probing', (): void => {
  it('persists only class defaults and argument names discovered from schemas', (): void => {
    expect(
      mcpAllowlist(
        {
          list_issues: {
            inputSchema: {
              type: 'object',
              properties: { updatedAfter: { type: 'string' }, project: { type: 'string' } },
            },
          },
          delete_issue: {
            inputSchema: { type: 'object', properties: { issueId: { type: 'string' } } },
          },
          create_comment: { inputSchema: { type: 'object', properties: {} } },
        },
        'kanban',
      ),
    ).toEqual({
      toolAllowlist: ['list_issues', 'create_comment'],
      toolArguments: [
        { tool: 'list_issues', arguments: ['project', 'updatedAfter'] },
        { tool: 'create_comment', arguments: [] },
      ],
    });
    expect(argumentNamesFromSchema({ properties: null })).toEqual([]);
  });

  it('calls listTools, reads definitions, and disconnects without returning the bearer', async (): Promise<void> => {
    const credential = 'local-contract-value-never-persisted';
    const listTools = vi.fn(async (): Promise<Record<string, unknown>> => ({
      surface_list_issues: {},
    }));
    const listToolDefinitionsWithErrors = vi.fn(async () => ({
      definitions: {
        surface: {
          list_issues: {
            inputSchema: { properties: { team: {}, updatedAt: {} } },
          },
        },
      },
      errors: {},
    }));
    const disconnect = vi.fn(async (): Promise<void> => undefined);
    const makeClient = vi.fn(() => ({
      listTools,
      listToolDefinitionsWithErrors,
      disconnect,
    }));

    const result = await probeMcpSurface(
      'https://mcp.linear.app/mcp',
      credential,
      'kanban',
      makeClient,
    );

    expect(result).toEqual({
      toolAllowlist: ['list_issues'],
      toolArguments: [{ tool: 'list_issues', arguments: ['team', 'updatedAt'] }],
    });
    expect(listTools).toHaveBeenCalledOnce();
    expect(listToolDefinitionsWithErrors).toHaveBeenCalledWith({
      perServerTimeoutMs: 30_000,
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it('rejects wrong hosts before creating a bearer client', async (): Promise<void> => {
    const makeClient = vi.fn();
    await expect(
      probeMcpSurface('https://attacker.invalid/mcp', 'contract-value', 'kanban', makeClient),
    ).rejects.toThrow('not the approved Linear host');
    expect(makeClient).not.toHaveBeenCalled();
    expect((): URL => linearMcpEndpoint('http://mcp.linear.app/mcp')).toThrow(
      'not the approved Linear host',
    );
  });

  it('always disconnects when provider discovery fails', async (): Promise<void> => {
    const disconnect = vi.fn(async (): Promise<void> => undefined);
    await expect(
      probeMcpSurface('https://mcp.linear.app/mcp', 'contract-value', 'kanban', () => ({
        listTools: async (): Promise<Record<string, unknown>> => {
          throw new Error('timed out');
        },
        listToolDefinitionsWithErrors: async () => ({ definitions: {}, errors: {} }),
        disconnect,
      })),
    ).rejects.toThrow('timed out');
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe('Slack documented API probing', (): void => {
  it('uses the policy allowlist and derives manager DM and provider identity', async (): Promise<void> => {
    const calls: Array<{ method: string; url: string; body?: string }> = [];
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body as string | undefined });
      if (url.endsWith('/auth.test')) {
        return slackResponse({ ok: true, user_id: 'UBOT', team_id: 'TWORKSPACE' });
      }
      if (url.includes('/users.lookupByEmail')) {
        return slackResponse({ ok: true, user: { id: 'UMANAGER' } });
      }
      return slackResponse({ ok: true, channel: { id: 'DMANAGER' } });
    });

    const result = await probeSlackSurface(
      'local-slack-contract-value',
      'boss@day0.local',
      SLACK_POLICY,
      fetcher,
    );

    expect(result).toEqual({
      toolAllowlist: [
        'auth.test',
        'users.lookupByEmail',
        'conversations.open',
        'conversations.list',
        'conversations.history',
        'conversations.replies',
        'chat.postMessage',
      ],
      managerDmChannelId: 'DMANAGER',
      providerIdentityId: 'UBOT',
      providerWorkspaceId: 'TWORKSPACE',
    });
    expect(calls[1]?.url).toContain('email=boss%40day0.local');
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({ users: 'UMANAGER' });
    expect(JSON.stringify(result)).not.toContain('local-slack-contract-value');
  });

  it('treats HTTP 200 plus ok false as a failed probe', async (): Promise<void> => {
    await expect(
      probeSlackSurface('local-contract-value', 'boss@day0.local', SLACK_POLICY, async () =>
        slackResponse({ ok: false, error: 'invalid_auth' }),
      ),
    ).rejects.toThrow('invalid_auth');
  });

  it('refuses a policy missing a required method before making HTTP calls', async (): Promise<void> => {
    const fetcher = vi.fn();
    await expect(
      probeSlackSurface(
        'local-contract-value',
        'boss@day0.local',
        '`auth.test` and `conversations.open` only',
        fetcher,
      ),
    ).rejects.toThrow('users.lookupByEmail');
    expect(fetcher).not.toHaveBeenCalled();
    expect(slackMethodsFromPolicy('notauth.testimony')).toEqual([]);
  });
});

describe('probe error hygiene', (): void => {
  it('removes exact and token-shaped credentials and clips the persisted reason', (): void => {
    const credential = 'local-contract-value';
    const tokenShape = ['xoxb', '123456-secret'].join('-');
    const reason = safeProviderError(
      new Error(`${credential} Bearer ${tokenShape} ${'failure '.repeat(100)}`),
      credential,
    );
    expect(reason).not.toContain(credential);
    expect(reason).not.toContain(tokenShape);
    expect(reason).toContain('<redacted>');
    expect(reason.length).toBeLessThanOrEqual(300);
  });
});

describe('surface probe action state', (): void => {
  it('uses mocked decrypt and provider contracts without leaking the value', async (): Promise<void> => {
    const credential = 'local-test-value-held-only-by-action';
    const agentId = 'test-agent-id' as Id<'agents'>;
    const surfaceId = 'test-surface-id' as Id<'surfaces'>;
    const mutationArguments: Array<Record<string, unknown>> = [];
    const runMutation = vi.fn(
      async (_reference: unknown, args: Record<string, unknown>): Promise<unknown> => {
        mutationArguments.push(args);
        if (Object.keys(args).length === 1 && args.surfaceId === surfaceId) {
          return {
            generation: 4,
            surface: {
              _id: surfaceId,
              agentId,
              slug: 'linear',
              displayName: 'Linear',
              class: 'kanban',
              verdict: 'approved',
              path: 'mcp',
              endpoint: 'https://mcp.linear.app/mcp',
              credentialId: 'local-test-credential-id',
              credentialLanded: false,
              whereFound: [],
              request: { expiresInDays: 30 },
              createdAt: 1,
            },
          };
        }
        if (args.verifiedAt === 1_000) return true;
        return undefined;
      },
    );
    const runQuery = vi.fn(async (): Promise<unknown> => ({
      surface: { _id: surfaceId, agentId },
      agent: {
        _id: agentId,
        bossEmail: 'boss@day0.local',
        name: 'probe contract',
        state: 'active',
        createdAt: 1,
      },
    }));
    const runAction = vi.fn(async (): Promise<string> => credential);
    const ctx = { runMutation, runQuery, runAction } as unknown as ActionCtx;
    const probeMcp = vi.fn(
      async (_endpoint: string | undefined, receivedCredential: string) => {
        expect(receivedCredential).toBe(credential);
        return {
          toolAllowlist: ['list_issues'],
          toolArguments: [{ tool: 'list_issues', arguments: ['project', 'updatedAt'] }],
        };
      },
    );

    const result = await runSurfaceProbe(ctx, surfaceId, true, {
      probeMcp,
      probeSlack: vi.fn(),
      now: (): number => 1_000,
    });

    expect(runAction).toHaveBeenCalledOnce();
    expect(probeMcp).toHaveBeenCalledOnce();
    // The read grant lands inside the connected write, not as a second call.
    expect(mutationArguments).not.toContainEqual({ agentId, scope: 'linear:read' });
    expect(mutationArguments).toContainEqual({
      surfaceId,
      generation: 4,
      toolAllowlist: ['list_issues'],
      toolArguments: [{ tool: 'list_issues', arguments: ['project', 'updatedAt'] }],
      managerDmChannelId: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      verifiedAt: 1_000,
      expiresAt: 2_592_001_000,
    });
    expect(result).toEqual({
      verdict: 'connected',
      toolAllowlist: ['list_issues'],
      managerDmReady: false,
    });
    expect(JSON.stringify({ mutationArguments, result })).not.toContain(credential);
  });

  it('does not grant a scope when a newer probe supersedes provider success', async (): Promise<void> => {
    const agentId = 'test-agent-id' as Id<'agents'>;
    const surfaceId = 'test-surface-id' as Id<'surfaces'>;
    const mutationArguments: Array<Record<string, unknown>> = [];
    const ctx = {
      runMutation: async (
        _reference: unknown,
        args: Record<string, unknown>,
      ): Promise<unknown> => {
        mutationArguments.push(args);
        if (Object.keys(args).length === 1) {
          return {
            generation: 1,
            surface: {
              _id: surfaceId,
              agentId,
              slug: 'linear',
              displayName: 'Linear',
              class: 'kanban',
              verdict: 'approved',
              path: 'mcp',
              endpoint: 'https://mcp.linear.app/mcp',
              credentialId: 'local-test-credential-id',
              credentialLanded: false,
              whereFound: [],
              createdAt: 1,
            },
          };
        }
        return false;
      },
      runQuery: async (): Promise<unknown> => ({
        surface: { _id: surfaceId, agentId },
        agent: { _id: agentId, bossEmail: 'boss@day0.local' },
      }),
      runAction: async (): Promise<string> => 'local-contract-value',
    } as unknown as ActionCtx;

    await expect(
      runSurfaceProbe(ctx, surfaceId, false, {
        probeMcp: async () => ({ toolAllowlist: ['list_issues'], toolArguments: [] }),
        probeSlack: vi.fn(),
        now: (): number => 1_000,
      }),
    ).resolves.toEqual({
      verdict: 'skipped',
      reason: 'A newer surface probe superseded this result.',
    });
    expect(mutationArguments).not.toContainEqual({ agentId, scope: 'linear:read' });
  });

  it('marks a missing credential ungranted without invoking a provider', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId } = await harness.run(
      async (ctx): Promise<{ agentId: Id<'agents'>; surfaceId: Id<'surfaces'> }> => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'missing credential probe',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        const surfaceId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'approved',
          whereFound: [],
          path: 'mcp',
          endpoint: 'https://mcp.linear.app/mcp',
          credentialLocation: 'IT vault / Day0 Linear',
          credentialLanded: false,
          managerApprovedAt: 2,
          itApprovedAt: 3,
          createdAt: 1,
        });
        return { agentId, surfaceId };
      },
    );

    await expect(
      harness.action(internal.surfaceActions.probeInternal, { surfaceId }),
    ).resolves.toEqual({
      verdict: 'ungranted',
      reason: 'credential not in the docs; IT vault / Day0 Linear',
    });
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({
      verdict: 'ungranted',
      credentialLanded: false,
      reason: 'credential not in the docs; IT vault / Day0 Linear',
      probeGeneration: 1,
    });
    const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events).toMatchObject([
      {
        agentId,
        type: 'surface.probe-failed',
      },
    ]);
  });

  it('refuses a public probe from a different owner before state changes', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'owned probe',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'approved',
        whereFound: [],
        credentialLanded: false,
        createdAt: 1,
      });
    });

    await expect(
      harness.withIdentity({ subject: 'other-owner' }).action(api.surfaceActions.probe, {
        surfaceId,
      }),
    ).rejects.toThrow('forbidden');
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.probeGeneration).toBeUndefined();
  });
});

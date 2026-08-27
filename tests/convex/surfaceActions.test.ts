import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { ActionCtx } from '../../convex/_generated/server';
import schema from '../../convex/schema';
import {
  argumentNamesFromSchema,
  linearMcpEndpoint,
  managerUserId,
  mcpAllowlist,
  probeBrowserSurface,
  probeMcpSurface,
  managerDisplayName,
  probeSlackSurface,
  runSurfaceProbe,
  safeProviderError,
  slackMethodsFromPolicy,
} from '../../convex/surfaceActions';
import {
  BROWSER_DRIVER_ABSENT,
  BROWSER_DRIVER_ABSENT_REASON,
  DEFAULT_BROWSER_MCP_URL,
} from '../../src/surfaces/browser';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
  restoreSurfaceMode();
  vi.unstubAllEnvs();
});

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
          save_comment: { inputSchema: { type: 'object', properties: {} } },
        },
        'kanban',
      ),
    ).toEqual({
      toolAllowlist: ['list_issues', 'save_comment'],
      toolArguments: [
        { tool: 'list_issues', arguments: ['project', 'updatedAfter'] },
        { tool: 'save_comment', arguments: [] },
      ],
    });
    expect(argumentNamesFromSchema({ properties: null })).toEqual([]);
  });

  it('reads definitions with errors, and disconnects without returning the bearer', async (): Promise<void> => {
    const credential = 'local-contract-value-never-persisted';
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
        listToolDefinitionsWithErrors: async () => {
          throw new Error('timed out');
        },
        disconnect,
      })),
    ).rejects.toThrow('timed out');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("reports the provider's refusal rather than an empty catalogue", async (): Promise<void> => {
    // The real Linear endpoint answers a bad bearer with 401; Mastra reports it
    // in errors and returns no definitions. The reason must carry the 401.
    const refused = async () => ({
      definitions: {},
      errors: {
        surface:
          'Failed to connect to MCP server surface: SdkHttpError: Error POSTing to endpoint: {"error":"invalid_token"}\n    at StreamableHTTPClientTransport._send (/srv/index.mjs:1:1)',
      },
    });
    await expect(
      probeMcpSurface('https://mcp.linear.app/mcp', 'contract-value', 'kanban', () => ({
        listToolDefinitionsWithErrors: refused,
        disconnect: async (): Promise<void> => undefined,
      })),
    ).rejects.toThrow('invalid_token');
    await expect(
      probeMcpSurface('https://mcp.linear.app/mcp', 'contract-value', 'kanban', () => ({
        listToolDefinitionsWithErrors: async () => ({ definitions: { surface: {} }, errors: {} }),
        disconnect: async (): Promise<void> => undefined,
      })),
    ).rejects.toThrow('MCP server returned no tools.');
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
        return slackResponse({
          ok: true,
          user: { id: 'UMANAGER', real_name: 'Brian Isaac', profile: { display_name: 'brian' } },
        });
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
      channelsNotJoined: [],
      managerDmChannelId: 'DMANAGER',
      managerUserId: 'UMANAGER',
      managerName: 'Brian Isaac',
      providerIdentityId: 'UBOT',
      providerWorkspaceId: 'TWORKSPACE',
    });
    expect(calls[1]?.url).toContain('email=boss%40day0.local');
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({ users: 'UMANAGER' });
    expect(JSON.stringify(result)).not.toContain('local-slack-contract-value');
  });

  it('reads the manager display name in the order Slack prefers', (): void => {
    expect(managerDisplayName({ id: 'U1', real_name: ' Brian Isaac ' })).toBe('Brian Isaac');
    expect(managerDisplayName({ id: 'U1', profile: { display_name: 'brian', real_name: 'Brian I' } })).toBe('brian');
    expect(managerDisplayName({ id: 'U1', profile: { display_name: '', real_name: 'Brian I' } })).toBe('Brian I');
    expect(managerDisplayName({ id: 'U1', name: 'brian.isaac' })).toBe('brian.isaac');
    expect(managerDisplayName({ id: 'U1' })).toBeUndefined();
    expect(managerDisplayName(undefined)).toBeUndefined();
  });

  it('treats HTTP 200 plus ok false as a failed probe', async (): Promise<void> => {
    await expect(
      probeSlackSurface('local-contract-value', 'boss@day0.local', SLACK_POLICY, async () =>
        slackResponse({ ok: false, error: 'invalid_auth' }),
      ),
    ).rejects.toThrow('Slack auth.test failed: invalid_auth');
  });

  it('refuses to derive a manager DM without a manager email, before any call', async (): Promise<void> => {
    const fetcher = vi.fn();
    await expect(
      probeSlackSurface('local-contract-value', '   ', SLACK_POLICY, fetcher),
    ).rejects.toThrow('no manager email');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('names a manager Slack does not know, and never opens a DM with a bot or itself', async (): Promise<void> => {
    const lookupReturning = (
      user: Record<string, unknown> | undefined,
      error?: string,
    ): ((input: string | URL) => Promise<Response>) => {
      return async (input: string | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/auth.test')) return slackResponse({ ok: true, user_id: 'UBOT' });
        if (url.includes('/users.lookupByEmail')) {
          return error ? slackResponse({ ok: false, error }) : slackResponse({ ok: true, user });
        }
        throw new Error('conversations.open must not be reached');
      };
    };
    await expect(
      probeSlackSurface(
        'value',
        'nobody@day0.local',
        SLACK_POLICY,
        lookupReturning(undefined, 'users_not_found'),
      ),
    ).rejects.toThrow('nobody@day0.local is not a member of this Slack workspace');
    await expect(
      probeSlackSurface(
        'value',
        'bot@day0.local',
        SLACK_POLICY,
        lookupReturning({ id: 'UOTHERBOT', is_bot: true }),
      ),
    ).rejects.toThrow('resolves to a Slack bot');
    await expect(
      probeSlackSurface(
        'value',
        'gone@day0.local',
        SLACK_POLICY,
        lookupReturning({ id: 'UGONE', deleted: true }),
      ),
    ).rejects.toThrow('deactivated');
    await expect(
      probeSlackSurface('value', 'self@day0.local', SLACK_POLICY, lookupReturning({ id: 'UBOT' })),
    ).rejects.toThrow('own bot user');
    expect(managerUserId({ id: 'UMANAGER', is_bot: false }, 'UBOT', 'boss@day0.local')).toBe(
      'UMANAGER',
    );
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
    const runQuery = vi.fn(
      async (): Promise<unknown> => ({
        surface: { _id: surfaceId, agentId },
        agent: {
          _id: agentId,
          bossEmail: 'boss@day0.local',
          name: 'probe contract',
          state: 'active',
          createdAt: 1,
        },
      }),
    );
    const runAction = vi.fn(async (): Promise<string> => credential);
    const ctx = { runMutation, runQuery, runAction } as unknown as ActionCtx;
    const probeMcp = vi.fn(async (_endpoint: string | undefined, receivedCredential: string) => {
      expect(receivedCredential).toBe(credential);
      return {
        toolAllowlist: ['list_issues'],
        toolArguments: [{ tool: 'list_issues', arguments: ['project', 'updatedAt'] }],
      };
    });

    const result = await runSurfaceProbe(ctx, surfaceId, true, {
      probeMcp,
      probeBrowser: vi.fn(),
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
      managerUserId: undefined,
      managerName: undefined,
      providerIdentityId: undefined,
      providerWorkspaceId: undefined,
      channelsNotJoined: [],
      verifiedAt: 1_000,
      expiresAt: 2_592_001_000,
    });
    expect(result).toEqual({
      verdict: 'connected',
      toolAllowlist: ['list_issues'],
      channelsNotJoined: [],
      managerDmReady: false,
    });
    expect(JSON.stringify({ mutationArguments, result })).not.toContain(credential);
  });

  it('does not grant a scope when a newer probe supersedes provider success', async (): Promise<void> => {
    const agentId = 'test-agent-id' as Id<'agents'>;
    const surfaceId = 'test-surface-id' as Id<'surfaces'>;
    const mutationArguments: Array<Record<string, unknown>> = [];
    const ctx = {
      runMutation: async (_reference: unknown, args: Record<string, unknown>): Promise<unknown> => {
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
        probeBrowser: vi.fn(),
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

describe('credential landing from the card', (): void => {
  /**
   * Seed an owned, half-approved surface whose connect request names a method.
   *
   * Args:
   *   harness: Convex test harness.
   *   method: Credential method the orientation run recorded.
   *
   * Returns:
   *   The surface id.
   */
  async function seedLandingSurface(
    harness: TestConvex<typeof schema>,
    method: 'oauth' | 'api-key',
  ): Promise<Id<'surfaces'>> {
    return await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'landing test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: method === 'oauth' ? 'slack' : 'linear',
        displayName: method === 'oauth' ? 'Slack' : 'Linear',
        class: method === 'oauth' ? 'chat' : 'kanban',
        verdict: 'proposed',
        whereFound: [],
        request: {
          credential: {
            found: 'none',
            label: method === 'oauth' ? 'Slack bot token' : 'Linear API key',
            method,
          },
        },
        credentialLocation:
          method === 'oauth' ? 'OAuth install flow documented in the policy' : 'ask the admin',
        credentialLanded: false,
        createdAt: 1,
      });
    });
  }

  it('stores a token typed on an OAuth surface as a shared value, never as an OAuth credential', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedLandingSurface(harness, 'oauth');
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.action(liveApi.surfaceActions.landCredential, {
        surfaceId,
        label: 'xoxb-shared-token-value',
        plaintext: 'xoxb-shared-token-value',
      }),
    ).resolves.toEqual({ landed: true, probeScheduled: false });
    const stored = await harness.run(async (ctx) => {
      const surface = await ctx.db.get(surfaceId);
      const credentials = await ctx.db.query('credentials').collect();
      return { surface, credentials };
    });
    expect(stored.credentials).toHaveLength(1);
    expect(stored.credentials[0]).toMatchObject({
      kind: 'value',
      label: 'Slack bot token',
      source: 'entered',
      userId: 'owner',
    });
    expect(JSON.stringify(stored)).not.toContain('xoxb-shared-token-value');
    expect(stored.surface).toMatchObject({
      credentialId: stored.credentials[0]._id,
      credentialKind: 'value',
      credentialLanded: false,
      credentialLocation: 'OAuth install flow documented in the policy',
    });
  });

  it('stores a documented-location landing as kind location', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedLandingSurface(harness, 'api-key');
    await harness.withIdentity({ subject: 'owner' }).action(liveApi.surfaceActions.landCredential, {
      surfaceId,
      label: '',
      plaintext: ' lin_api_test_value ',
    });
    const credentials = await harness.run(async (ctx) => await ctx.db.query('credentials').collect());
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      kind: 'location',
      label: 'Linear API key',
      source: 'entered',
    });
    await expect(
      harness
        .withIdentity({ subject: 'stranger' })
        .action(liveApi.surfaceActions.landCredential, { surfaceId, label: 'x', plaintext: 'y' }),
    ).rejects.toThrow('forbidden');
  });
});

describe('a dedicated app that has not been invited to its channels', (): void => {
  const CHANNEL_POLICY = [
    '# Slack automation policy',
    '- Channels: `#revops-asks` (inbound requests), `#revops` (team channel).',
    'Methods automations use: `auth.test`, `users.lookupByEmail`, `conversations.open`,',
    '`conversations.list`, `conversations.history`, `conversations.replies`, `chat.postMessage`.',
  ].join('\n');

  /** A Slack fake that answers the probe under one dedicated bot identity. */
  function dedicatedFake(channels: Array<{ is_member: boolean; name: string }>) {
    return vi.fn(async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/auth.test')) {
        return slackResponse({ ok: true, user_id: 'UNEWBOT', team_id: 'TWORKSPACE' });
      }
      if (url.includes('/users.lookupByEmail')) {
        return slackResponse({ ok: true, user: { id: 'UMANAGER', real_name: 'Brian Isaac' } });
      }
      if (url.includes('/conversations.list')) {
        return slackResponse({ ok: true, channels });
      }
      return slackResponse({ ok: true, channel: { id: 'DNEWDM' } });
    });
  }

  it('connects under the new bot user and names the channels awaiting an invite', async (): Promise<void> => {
    const result = await probeSlackSurface(
      'xoxb-dedicated-token',
      'boss@day0.local',
      CHANNEL_POLICY,
      dedicatedFake([
        { is_member: false, name: 'revops-asks' },
        { is_member: false, name: 'revops' },
      ]),
      ['revops-asks', 'revops'],
    );
    expect(result.providerIdentityId).toBe('UNEWBOT');
    expect(result.managerDmChannelId).toBe('DNEWDM');
    expect(result.channelsNotJoined).toEqual(['#revops-asks', '#revops']);
  });

  it('reports nothing once the administrator has invited it', async (): Promise<void> => {
    const result = await probeSlackSurface(
      'xoxb-dedicated-token',
      'boss@day0.local',
      CHANNEL_POLICY,
      dedicatedFake([
        { is_member: true, name: 'revops-asks' },
        { is_member: true, name: 'revops' },
      ]),
      ['revops-asks', 'revops'],
    );
    expect(result.channelsNotJoined).toEqual([]);
  });

  it('does not list channels when the policy names none', async (): Promise<void> => {
    const fetcher = dedicatedFake([]);
    const result = await probeSlackSurface(
      'xoxb-dedicated-token',
      'boss@day0.local',
      CHANNEL_POLICY,
      fetcher,
      [],
    );
    expect(result.channelsNotJoined).toEqual([]);
    expect(
      fetcher.mock.calls.filter((call): boolean => String(call[0]).includes('conversations.list')),
    ).toHaveLength(0);
  });

  it('walks pagination before deciding a documented channel is missing', async (): Promise<void> => {
    let page = 0;
    const fetcher = vi.fn(async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/auth.test')) return slackResponse({ ok: true, user_id: 'UNEWBOT' });
      if (url.includes('/users.lookupByEmail')) {
        return slackResponse({ ok: true, user: { id: 'UMANAGER' } });
      }
      if (url.includes('/conversations.list')) {
        page += 1;
        return page === 1
          ? slackResponse({
              ok: true,
              channels: [{ is_member: true, name: 'random' }],
              response_metadata: { next_cursor: 'page-2' },
            })
          : slackResponse({ ok: true, channels: [{ is_member: true, name: 'revops' }] });
      }
      return slackResponse({ ok: true, channel: { id: 'DNEWDM' } });
    });
    const result = await probeSlackSurface(
      'xoxb-dedicated-token',
      'boss@day0.local',
      CHANNEL_POLICY,
      fetcher,
      ['revops'],
    );
    expect(page).toBe(2);
    expect(result.channelsNotJoined).toEqual([]);
  });
});

describe('probing the browser floor', (): void => {
  const TILE = 'http://looker-tile:8080/';
  const TITLE = 'Sign in - Looker';
  /** This deployment runs the browser component, at the address `--profile browser` starts. */
  const DRIVER = DEFAULT_BROWSER_MCP_URL;

  /** A driver whose catalogue and navigation result the test decides. */
  function fakeDriver(options: {
    catalogue?: Record<string, { inputSchema?: unknown }>;
    navigate?: { isError: boolean; text: string };
    error?: string;
  }) {
    const navigated: Array<{ name: string; args: Record<string, unknown> }> = [];
    const disconnect = vi.fn(async (): Promise<void> => undefined);
    const client = {
      listToolDefinitionsWithErrors: async () => ({
        definitions: {
          surface: options.catalogue ?? {
            browser_navigate: { inputSchema: { properties: { url: {} } } },
            browser_snapshot: { inputSchema: { properties: {} } },
            browser_click: { inputSchema: { properties: { ref: {} } } },
            browser_type: { inputSchema: { properties: { ref: {}, text: {} } } },
            browser_fill_form: { inputSchema: { properties: { fields: {} } } },
            browser_evaluate: { inputSchema: { properties: {} } },
            browser_run_code_unsafe: { inputSchema: { properties: {} } },
          },
        },
        errors: (options.error ? { surface: options.error } : {}) as Record<string, string>,
      }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        navigated.push({ name, args });
        return (
          options.navigate ?? {
            isError: false,
            text: `- Page URL: ${TILE}\n- Page Title: ${TITLE}`,
          }
        );
      },
      disconnect,
    };
    return { client, disconnect, navigated };
  }

  it('constrains the driver catalogue to the floor and opens the documented page', async (): Promise<void> => {
    const { client, disconnect, navigated } = fakeDriver({});
    const discovery = await probeBrowserSurface(TILE, DRIVER, () => client, TITLE);
    expect(discovery.toolAllowlist).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_fill_form',
    ]);
    expect(discovery.toolArguments).toContainEqual({ tool: 'browser_type', arguments: ['ref', 'text'] });
    expect(navigated).toEqual([{ name: 'browser_navigate', args: { url: TILE } }]);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('fails when the documented page cannot be opened, not merely when the driver is down', async (): Promise<void> => {
    const { client, disconnect } = fakeDriver({
      navigate: { isError: true, text: 'net::ERR_CONNECTION_REFUSED at http://looker-tile:8080/' },
    });
    await expect(probeBrowserSurface(TILE, DRIVER, () => client, TITLE)).rejects.toThrow(
      'the documented page could not be opened',
    );
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('fails when the page title is not the marker documented for the surface', async (): Promise<void> => {
    const { client, disconnect } = fakeDriver({
      navigate: {
        isError: false,
        text: '- Page URL: http://looker-tile:8080/\n- Page Title: Generic reverse proxy',
      },
    });
    await expect(
      probeBrowserSurface(
        TILE,
        DRIVER,
        () => client,
        TITLE,
      ),
    ).rejects.toThrow('documented page title marker');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('refuses a browser surface whose documentation gives no liveness marker', async (): Promise<void> => {
    const { client } = fakeDriver({});
    await expect(probeBrowserSurface(TILE, DRIVER, () => client)).rejects.toThrow(
      'No page title marker is documented',
    );
  });

  it('fails when the driver reports an error rather than reading it as no tools', async (): Promise<void> => {
    const { client } = fakeDriver({ error: 'Browser is already in use' });
    await expect(probeBrowserSurface(TILE, DRIVER, () => client, TITLE)).rejects.toThrow(
      'Browser is already in use',
    );
  });

  it('refuses with the absence code when no browser component is configured', async (): Promise<void> => {
    const { client, disconnect } = fakeDriver({});
    await expect(probeBrowserSurface(TILE, undefined, () => client, TITLE)).rejects.toThrow(
      BROWSER_DRIVER_ABSENT,
    );
    await expect(probeBrowserSurface(TILE, '  ', () => client, TITLE)).rejects.toThrow(
      '--profile browser',
    );
    // The driver is never dialled, so there is nothing to disconnect from.
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('refuses with the absence code when the configured driver is not listening', async (): Promise<void> => {
    const { client } = fakeDriver({ error: 'fetch failed: connect ECONNREFUSED 172.18.0.9:8931' });
    await expect(probeBrowserSurface(TILE, DRIVER, () => client, TITLE)).rejects.toThrow(
      BROWSER_DRIVER_ABSENT,
    );
  });

  it('fails when the driver exposes none of the floor tools', async (): Promise<void> => {
    const { client } = fakeDriver({ catalogue: { browser_evaluate: {} } });
    await expect(probeBrowserSurface(TILE, DRIVER, () => client, TITLE)).rejects.toThrow(
      'no tools allowed for this surface class',
    );
  });

  it('refuses a surface with no documented address', async (): Promise<void> => {
    const { client } = fakeDriver({});
    await expect(probeBrowserSurface(undefined, DRIVER, () => client, TITLE)).rejects.toThrow(
      'No web UI address is documented',
    );
    await expect(probeBrowserSurface('not-a-url', DRIVER, () => client, TITLE)).rejects.toThrow(
      'not a valid URL',
    );
  });

  /** One approved browser-driven surface whose runbook documents the marker. */
  async function tileHarness(): Promise<{
    agentId: Id<'agents'>;
    harness: TestConvex<typeof schema>;
    surfaceId: Id<'surfaces'>;
  }> {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId } = await harness.run(
      async (ctx): Promise<{ agentId: Id<'agents'>; surfaceId: Id<'surfaces'> }> => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'floor probe',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        const surfaceId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'approved',
          whereFound: [],
          path: 'browser-driven',
          endpoint: TILE,
          managerApprovedAt: 2,
          itApprovedAt: 3,
          credentialLanded: false,
          createdAt: 1,
        });
        const sourceId = await ctx.db.insert('docSources', {
          userId: 'owner',
          label: 'Tile runbook',
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert('docPages', {
          sourceId,
          ref: 'looker-pipeline-tile.md',
          title: 'Looker pipeline tile',
          markdown: `# Looker pipeline tile\n\n- Probe marker: page title \`${TITLE}\`.`,
          updatedAt: 1,
        });
        return { agentId, surfaceId };
      },
    );
    return { agentId, harness, surfaceId };
  }

  it('refuses to probe a web UI when no browser component is configured', async (): Promise<void> => {
    const { harness, surfaceId } = await tileHarness();
    const probeBrowser = vi.fn();
    const outcome = await runSurfaceProbe(
      {
        runMutation: harness.mutation.bind(harness),
        runQuery: harness.query.bind(harness),
        runAction: async (): Promise<string> => {
          throw new Error('no credential to decrypt');
        },
      } as unknown as ActionCtx,
      surfaceId,
      false,
      { probeBrowser, probeMcp: vi.fn(), probeSlack: vi.fn(), now: (): number => 1_000 },
    );
    expect(outcome.verdict).toBe('ungranted');
    expect(outcome.reason).toContain(BROWSER_DRIVER_ABSENT);
    expect(outcome.reason).toContain('--profile browser');
    // No stack trace, and nothing dialled: the driver was never asked.
    expect(probeBrowser).not.toHaveBeenCalled();
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({ verdict: 'ungranted', endpoint: TILE, path: 'browser-driven' });
  });

  it('records a configured driver that is not there as the same absence', async (): Promise<void> => {
    const { harness, surfaceId } = await tileHarness();
    vi.stubEnv('DAY0_BROWSER_MCP_URL', DRIVER);
    const probeBrowser = vi.fn(async (): Promise<never> => {
      throw new Error(BROWSER_DRIVER_ABSENT_REASON);
    });
    const outcome = await runSurfaceProbe(
      {
        runMutation: harness.mutation.bind(harness),
        runQuery: harness.query.bind(harness),
        runAction: async (): Promise<string> => {
          throw new Error('no credential to decrypt');
        },
      } as unknown as ActionCtx,
      surfaceId,
      false,
      { probeBrowser, probeMcp: vi.fn(), probeSlack: vi.fn(), now: (): number => 1_000 },
    );
    // Not `listed-dead`: the enterprise's system is not what is missing.
    expect(outcome.verdict).toBe('ungranted');
    expect(outcome.reason).toContain(BROWSER_DRIVER_ABSENT);
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({ verdict: 'ungranted', endpoint: TILE });
  });

  it('connects a browser-driven surface that documents no credential', async (): Promise<void> => {
    const { agentId, harness, surfaceId } = await tileHarness();
    const probeBrowser = vi.fn(async () => ({
      toolAllowlist: ['browser_navigate', 'browser_snapshot'],
      toolArguments: [],
    }));
    vi.stubEnv('DAY0_BROWSER_MCP_URL', DRIVER);
    await expect(
      runSurfaceProbe(
        {
          runMutation: harness.mutation.bind(harness),
          runQuery: harness.query.bind(harness),
          runAction: async (): Promise<string> => {
            throw new Error('no credential to decrypt');
          },
        } as unknown as ActionCtx,
        surfaceId,
        false,
        {
          probeBrowser,
          probeMcp: vi.fn(),
          probeSlack: vi.fn(),
          now: (): number => 1_000,
        },
      ),
    ).resolves.toMatchObject({ verdict: 'connected' });
    expect(probeBrowser).toHaveBeenCalledWith(TILE, DRIVER, undefined, TITLE);
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({ verdict: 'connected', credentialLanded: true });
    const grants = await harness.run(async (ctx) => await ctx.db.query('permissionGrants').collect());
    expect(grants.map((grant) => grant.scope)).toContain('looker-pipeline-tile:read');
    expect(grants.every((grant) => grant.agentId === agentId)).toBe(true);
  });
});

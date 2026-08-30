import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convexTest, type TestConvex } from 'convex-test';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { ActionCtx } from '../../convex/_generated/server';
import schema from '../../convex/schema';
import {
  approvedMcpEndpoint,
  argumentNamesFromSchema,
  managerUserId,
  MAX_MCP_TOOLS,
  mcpAllowlist,
  probeBrowserSurface,
  probeMcpSurface,
  managerDisplayName,
  probeSlackSurface,
  runSurfaceProbe,
  safeProviderError,
  slackMethodsFromPolicy,
  type McpDiscovery,
  type ToolDefinition,
} from '../../convex/surfaceActions';
import { actionIntent } from '../../src/surfaces/policy';
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

/** One public DNS answer, so address checks pass without touching a resolver. */
const publicDns = async (): Promise<string[]> => ['93.184.216.34'];

describe('surface MCP probing', (): void => {

  it('admits the server catalogue for any class and leaves writes to the action gate', (): void => {
    expect(
      mcpAllowlist({
        list_issues: {
          inputSchema: {
            type: 'object',
            properties: { updatedAfter: { type: 'string' }, project: { type: 'string' } },
          },
        },
        delete_issue: {
          inputSchema: { type: 'object', properties: { issueId: { type: 'string' } } },
        },
        sync_workspace: { inputSchema: { type: 'object', properties: {} } },
      }),
    ).toEqual({
      toolAllowlist: ['list_issues', 'delete_issue', 'sync_workspace'],
      toolArguments: [
        { tool: 'list_issues', arguments: ['project', 'updatedAfter'] },
        { tool: 'delete_issue', arguments: ['issueId'] },
        { tool: 'sync_workspace', arguments: [] },
      ],
    });
    expect(
      actionIntent({ kind: 'mcp.call', surface: 'jira', tool: 'list_issues', toolArgs: {} }),
    ).toBe('read');
    expect(
      actionIntent({
        kind: 'mcp.call',
        surface: 'jira',
        tool: 'list_and_delete_issues',
        toolArgs: {},
      }),
    ).toBe('write');
    expect(
      actionIntent({
        kind: 'mcp.call',
        surface: 'jira',
        tool: 'list_and_modify_issues',
        toolArgs: {},
      }),
    ).toBe('write');
    expect(
      actionIntent({ kind: 'mcp.call', surface: 'jira', tool: 'sync_workspace', toolArgs: {} }),
    ).toBe('write');
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
      'https://mcp.atlassian.example/mcp',
      credential,
      makeClient,
      publicDns,
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

  it('accepts the exact approved public HTTPS endpoint and rejects SSRF targets before bearer use', (): void => {
    expect(approvedMcpEndpoint('https://mcp.atlassian.example/mcp').href).toBe(
      'https://mcp.atlassian.example/mcp',
    );
    expect(approvedMcpEndpoint('https://mcp.example.com:8443/rpc').href).toBe(
      'https://mcp.example.com:8443/rpc',
    );
    for (const endpoint of [
      'http://mcp.example.com/mcp',
      'https://localhost/mcp',
      'https://mcp.internal/mcp',
      'https://127.0.0.1/mcp',
      'https://10.0.0.8/mcp',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/mcp',
      'https://user:pass@mcp.example.com/mcp',
      'https://mcp.example.com/mcp#other',
    ]) {
      expect((): URL => approvedMcpEndpoint(endpoint), endpoint).toThrow(
        'approved MCP endpoint must use a public HTTPS hostname',
      );
    }
  });

  it('always disconnects when provider discovery fails', async (): Promise<void> => {
    const disconnect = vi.fn(async (): Promise<void> => undefined);
    await expect(
      probeMcpSurface(
        'https://mcp.linear.app/mcp',
        'contract-value',
        () => ({
          listToolDefinitionsWithErrors: async () => {
            throw new Error('timed out');
          },
          disconnect,
        }),
        publicDns,
      ),
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
      probeMcpSurface(
        'https://mcp.linear.app/mcp',
        'contract-value',
        () => ({
          listToolDefinitionsWithErrors: refused,
          disconnect: async (): Promise<void> => undefined,
        }),
        publicDns,
      ),
    ).rejects.toThrow('invalid_token');
    await expect(
      probeMcpSurface(
        'https://mcp.linear.app/mcp',
        'contract-value',
        () => ({
          listToolDefinitionsWithErrors: async () => ({ definitions: { surface: {} }, errors: {} }),
          disconnect: async (): Promise<void> => undefined,
        }),
        publicDns,
      ),
    ).rejects.toThrow('exposed no named tools Day0 can call');
  });

  it('keeps Day0 browser-floor names and oversized catalogues out of discovery', (): void => {
    // `browser_navigate` and `browser_snapshot` are exempt from the write
    // default by name alone. A discovered server must not be able to claim that
    // exemption: its `browser_navigate` means whatever it wants, and it would
    // run unattended and outside the floor's origin bound.
    const discovered = mcpAllowlist({
      browser_navigate: { inputSchema: { properties: { url: {} } } },
      browser_snapshot: { inputSchema: {} },
      list_issues: { inputSchema: { properties: { project: {} } } },
    });
    expect(discovered.toolAllowlist).toEqual(['list_issues']);
    expect((): McpDiscovery => mcpAllowlist({ browser_navigate: { inputSchema: {} } })).toThrow(
      'exposed no named tools Day0 can call',
    );
    const oversized = Object.fromEntries(
      Array.from({ length: MAX_MCP_TOOLS + 1 }, (_unused, index): [string, ToolDefinition] => [
        `list_thing_${index}`,
        { inputSchema: {} },
      ]),
    );
    expect((): McpDiscovery => mcpAllowlist(oversized)).toThrow('Day0 capacity limit');
  });

  it('refuses private DNS answers before constructing a bearer client', async (): Promise<void> => {
    const makeClient = vi.fn();

    await expect(
      probeMcpSurface(
        'https://mcp.example.com/mcp',
        'contract-value',
        makeClient,
        async (): Promise<string[]> => ['93.184.216.34', '169.254.169.254'],
      ),
    ).rejects.toThrow('resolved to a private, loopback, link-local, reserved');
    await expect(
      probeMcpSurface(
        'https://mcp.example.com/mcp',
        'contract-value',
        makeClient,
        async (): Promise<string[]> => ['fd00::1'],
      ),
    ).rejects.toThrow('resolved to a private, loopback, link-local, reserved');
    // A denylist of IPv6 ranges cannot be finished. 6to4 reaches 127.0.0.1
    // through a relay, NAT64 reaches it through a gateway, and site-local and
    // IPv4-compatible addresses were simply never listed.
    for (const address of [
      '2002:7f00:1::1',
      '64:ff9b::7f00:1',
      'fec0::1',
      '::7f00:1',
      '::ffff:127.0.0.1',
      '2001:0:5ef5:79fd::1',
    ]) {
      await expect(
        probeMcpSurface(
          'https://mcp.example.com/mcp',
          'contract-value',
          makeClient,
          async (): Promise<string[]> => [address],
        ),
        address,
      ).rejects.toThrow('resolved to a private, loopback, link-local, reserved');
    }
    expect(makeClient).not.toHaveBeenCalled();
    // A globally routable answer still reaches the client.
    const reached = vi.fn(() => ({
      listToolDefinitionsWithErrors: async () => ({
        definitions: { surface: { list_issues: {} } },
        errors: {},
      }),
      disconnect: async (): Promise<void> => undefined,
    }));
    await expect(
      probeMcpSurface(
        'https://mcp.example.com/mcp',
        'contract-value',
        reached,
        async (): Promise<string[]> => ['2606:4700:4700::1111'],
      ),
    ).resolves.toMatchObject({ toolAllowlist: ['list_issues'] });
  });

  it('separates a resolver that would not answer from a name that does not exist', async (): Promise<void> => {
    const makeClient = vi.fn();
    const failing = (code: string) => async (): Promise<string[]> => {
      throw Object.assign(new Error(`getaddrinfo ${code} mcp.example.com`), { code });
    };
    await expect(
      probeMcpSurface('https://mcp.example.com/mcp', 'value', makeClient, failing('ENOTFOUND')),
    ).rejects.toThrow('does not resolve');
    await expect(
      probeMcpSurface('https://mcp.example.com/mcp', 'value', makeClient, failing('EAI_AGAIN')),
    ).rejects.toThrow('its own resolver did not answer');
    expect(makeClient).not.toHaveBeenCalled();
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
    expect(
      managerDisplayName({ id: 'U1', profile: { display_name: 'brian', real_name: 'Brian I' } }),
    ).toBe('brian');
    expect(
      managerDisplayName({ id: 'U1', profile: { display_name: '', real_name: 'Brian I' } }),
    ).toBe('Brian I');
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
  it('refuses a route that no longer matches the ladder frozen at approval', async (): Promise<void> => {
    const surfaceId = 'test-surface-id' as Id<'surfaces'>;
    const agentId = 'test-agent-id' as Id<'agents'>;
    const probeMcp = vi.fn();
    const surface = {
      _id: surfaceId,
      agentId,
      slug: 'jira',
      displayName: 'Jira',
      class: 'kanban',
      verdict: 'approved',
      path: 'mcp',
      endpoint: 'https://changed-after-approval.example/mcp',
      pathCandidates: [{ path: 'mcp', endpoint: 'https://approved.example/mcp' }],
      credentialId: 'test-credential-id',
      credentialLanded: false,
      managerApprovedAt: 2,
      itApprovedAt: 3,
      whereFound: [],
      createdAt: 1,
    };
    const failures: Array<Record<string, unknown>> = [];
    const outcome = await runSurfaceProbe(
      {
        runMutation: async (
          _reference: unknown,
          args: Record<string, unknown>,
        ): Promise<unknown> => {
          if (Object.keys(args).length === 1) return { surface, generation: 1 };
          if ('verdict' in args) {
            failures.push(args);
            return true;
          }
          return null;
        },
        runQuery: async (): Promise<unknown> => ({
          surface,
          agent: { _id: agentId, bossEmail: 'boss@day0.local' },
        }),
        runAction: vi.fn(),
      } as unknown as ActionCtx,
      surfaceId,
      false,
      {
        probeMcp,
        probeBrowser: vi.fn(),
        probeSlack: vi.fn(),
        now: (): number => 1_000,
      },
    );

    expect(outcome).toEqual({
      verdict: 'ungranted',
      reason: 'Current surface route does not match the evidence-backed ladder frozen at approval.',
    });
    expect(probeMcp).not.toHaveBeenCalled();
    expect(failures).toContainEqual(expect.objectContaining({ verdict: 'ungranted' }));
  });

  it.each([
    {
      label: 'an unsupported documented API',
      surface: {
        class: 'chat',
        path: 'documented-api',
        endpoint: 'https://graph.microsoft.com/v1.0/',
        displayName: 'Microsoft Teams',
      },
      probeMcp: vi.fn(),
      expectedVerdict: 'ungranted',
      expectedReason: 'limitation of this Day0 deployment, not evidence that Microsoft Teams is unavailable',
    },
    {
      label: 'a live MCP server refusing its credential',
      surface: {
        class: 'kanban',
        path: 'mcp',
        endpoint: 'https://mcp.jira.example/mcp',
        displayName: 'Jira',
      },
      probeMcp: vi.fn(async (): Promise<never> => {
        throw new Error('HTTP 401 invalid_token');
      }),
      expectedVerdict: 'ungranted',
      expectedReason: 'HTTP 401 invalid_token',
    },
    {
      label: 'a provider that does not answer',
      surface: {
        class: 'kanban',
        path: 'mcp',
        endpoint: 'https://mcp.jira.example/mcp',
        displayName: 'Jira',
      },
      probeMcp: vi.fn(async (): Promise<never> => {
        throw new Error('connect ETIMEDOUT');
      }),
      expectedVerdict: 'listed-dead',
      expectedReason: 'connect ETIMEDOUT',
    },
  ])('keeps the verdict honest for $label', async ({
    surface: partialSurface,
    probeMcp,
    expectedVerdict,
    expectedReason,
  }): Promise<void> => {
    const agentId = 'test-agent-id' as Id<'agents'>;
    const surfaceId = 'test-surface-id' as Id<'surfaces'>;
    const failures: Array<Record<string, unknown>> = [];
    const surface = {
      _id: surfaceId,
      agentId,
      slug: 'work-system',
      verdict: 'approved',
      credentialId: 'test-credential-id',
      credentialLanded: false,
      managerApprovedAt: 2,
      itApprovedAt: 3,
      pathCandidates: [{ path: partialSurface.path, endpoint: partialSurface.endpoint }],
      whereFound: [],
      createdAt: 1,
      ...partialSurface,
    };
    const ctx = {
      runMutation: async (_reference: unknown, args: Record<string, unknown>): Promise<unknown> => {
        if (Object.keys(args).length === 1) return { surface, generation: 1 };
        if ('verdict' in args) {
          failures.push(args);
          return true;
        }
        return null;
      },
      runQuery: async (): Promise<unknown> => ({
        surface,
        agent: { _id: agentId, bossEmail: 'boss@day0.local' },
      }),
      runAction: async (): Promise<string> => 'provider-contract-value',
    } as unknown as ActionCtx;

    const outcome = await runSurfaceProbe(ctx, surfaceId, false, {
      probeMcp,
      probeBrowser: vi.fn(),
      probeSlack: vi.fn(),
      now: (): number => 1_000,
    });

    expect(outcome).toMatchObject({ verdict: expectedVerdict });
    expect(outcome.reason).toContain(expectedReason);
    expect(failures).toContainEqual(
      expect.objectContaining({ verdict: expectedVerdict, attemptedAt: 1_000 }),
    );
  });

  it.each(['https://slack.com/api/', 'https://slack.com/api'])(
    'reaches the Slack probe for a documented base written as %s',
    async (endpoint: string): Promise<void> => {
      const agentId = 'test-agent-id' as Id<'agents'>;
      const surfaceId = 'test-surface-id' as Id<'surfaces'>;
      // The endpoint is evidence, copied out of the enterprise's page. An exact
      // string match turned the trailing-slash-less spelling into "Day0 has no
      // probe for this", and then descended the ladder past a system it probes.
      const surface = {
        _id: surfaceId,
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'approved',
        path: 'documented-api',
        endpoint,
        pathCandidates: [{ path: 'documented-api', endpoint }],
        credentialId: 'test-credential-id',
        credentialLanded: false,
        managerApprovedAt: 2,
        itApprovedAt: 3,
        whereFound: [],
        createdAt: 1,
      };
      const probeSlack = vi.fn(async () => ({
        toolAllowlist: ['auth.test'],
        channelsNotJoined: [],
        managerDmChannelId: 'DMANAGER',
        managerUserId: 'UMANAGER',
        providerIdentityId: 'UBOT',
      }));
      const outcome = await runSurfaceProbe(
        {
          runMutation: async (
            _reference: unknown,
            args: Record<string, unknown>,
          ): Promise<unknown> => {
            if (Object.keys(args).length === 1) return { surface, generation: 1 };
            if ('verifiedAt' in args) return true;
            return null;
          },
          runQuery: async (
            _reference: unknown,
            args: Record<string, unknown>,
          ): Promise<unknown> =>
            'surfaceId' in args
              ? { surface, agent: { _id: agentId, bossEmail: 'boss@day0.local' } }
              : [],
          runAction: async (): Promise<string> => 'slack-contract-value',
        } as unknown as ActionCtx,
        surfaceId,
        false,
        { probeBrowser: vi.fn(), probeMcp: vi.fn(), probeSlack, now: (): number => 1_000 },
      );
      expect(outcome).toMatchObject({ verdict: 'connected' });
      expect(probeSlack).toHaveBeenCalledOnce();
    },
  );

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
    const credentials = await harness.run(
      async (ctx) => await ctx.db.query('credentials').collect(),
    );
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
    expect(discovery.toolArguments).toContainEqual({
      tool: 'browser_type',
      arguments: ['ref', 'text'],
    });
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
    await expect(probeBrowserSurface(TILE, DRIVER, () => client, TITLE)).rejects.toThrow(
      'title did not match the approved marker',
    );
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
      'no tools allowed for the browser floor',
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
    const grants = await harness.run(
      async (ctx) => await ctx.db.query('permissionGrants').collect(),
    );
    expect(grants.map((grant) => grant.scope)).toContain('looker-pipeline-tile:read');
    expect(grants.every((grant) => grant.agentId === agentId)).toBe(true);
  });

  it('calls a server that answers with no tools ungranted, not listed-dead', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Jira employee',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'location',
        label: 'Jira automation credential',
        ciphertext: 'not-read-by-this-contract',
        iv: 'not-read-by-this-contract',
        source: 'entered',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'jira',
        displayName: 'Jira',
        class: 'kanban',
        verdict: 'approved',
        whereFound: [],
        path: 'mcp',
        fallbackPath: 'escalate',
        pathCandidates: [{ path: 'mcp', endpoint: 'https://mcp.jira.example/mcp' }],
        endpoint: 'https://mcp.jira.example/mcp',
        credentialId,
        credentialKind: 'location',
        credentialLanded: false,
        managerApprovedAt: 2,
        itApprovedAt: 3,
        createdAt: 1,
      });
    });
    // The real probe decides, so the verdict is the code's and not the test's.
    const outcome = await runSurfaceProbe(
      {
        runMutation: harness.mutation.bind(harness),
        runQuery: harness.query.bind(harness),
        runAction: async (): Promise<string> => 'jira-contract-credential',
      } as unknown as ActionCtx,
      surfaceId,
      false,
      {
        probeBrowser: vi.fn(),
        probeMcp: (endpoint: string | undefined, credential: string): Promise<McpDiscovery> =>
          probeMcpSurface(
            endpoint,
            credential,
            () => ({
              listToolDefinitionsWithErrors: async () => ({
                definitions: { surface: {} },
                errors: {},
              }),
              disconnect: async (): Promise<void> => undefined,
            }),
            publicDns,
          ),
        probeSlack: vi.fn(),
        now: (): number => 1_000,
      },
    );
    expect(outcome.verdict).toBe('ungranted');
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({
      verdict: 'ungranted',
      endpoint: 'https://mcp.jira.example/mcp',
      probeAttempts: [{ path: 'mcp', outcome: 'ungranted' }],
    });
  });

  it('reads the probe marker from the surface\'s own documentation', async (): Promise<void> => {
    const { harness } = await tileHarness();
    // A second browser-driven system on the same agent. Read across every page,
    // one marker would serve both: this system would be checked against the
    // tile's page title, which is what a shared marker means now that a public
    // web UI reaches the browser rung without a login.
    const reportsId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const source = await ctx.db.query('docSources').first();
      const agent = await ctx.db.query('agents').first();
      if (!source || !agent) throw new Error('no documentation source');
      await ctx.db.insert('docPages', {
        sourceId: source._id,
        ref: 'forecast-reports.md',
        title: 'Forecast reports',
        markdown: '# Forecast reports\n\n- Probe marker: page title `Forecast - Home`.',
        updatedAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId: agent._id,
        slug: 'forecast-reports',
        displayName: 'Forecast reports',
        class: 'analytics',
        verdict: 'approved',
        whereFound: [],
        path: 'browser-driven',
        endpoint: 'https://reports.example.test/forecast',
        pathCandidates: [
          { path: 'browser-driven', endpoint: 'https://reports.example.test/forecast' },
        ],
        managerApprovedAt: 2,
        itApprovedAt: 3,
        credentialLanded: false,
        createdAt: 2,
      });
    });
    vi.stubEnv('DAY0_BROWSER_MCP_URL', DRIVER);
    const probeBrowser = vi.fn(async () => ({
      toolAllowlist: ['browser_navigate', 'browser_snapshot'],
      toolArguments: [],
    }));
    await expect(
      runSurfaceProbe(
        {
          runMutation: harness.mutation.bind(harness),
          runQuery: harness.query.bind(harness),
          runAction: async (): Promise<string> => {
            throw new Error('no credential to decrypt');
          },
        } as unknown as ActionCtx,
        reportsId,
        false,
        { probeBrowser, probeMcp: vi.fn(), probeSlack: vi.fn(), now: (): number => 1_000 },
      ),
    ).resolves.toMatchObject({ verdict: 'connected' });
    expect(probeBrowser).toHaveBeenCalledWith(
      'https://reports.example.test/forecast',
      DRIVER,
      undefined,
      'Forecast - Home',
    );
  });

  it('keeps a withdrawn credential from descending to a credentialless rung', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Jira employee',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'location',
        label: 'Jira automation credential',
        ciphertext: 'not-read-by-this-contract',
        iv: 'not-read-by-this-contract',
        source: 'entered',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'jira',
        displayName: 'Jira',
        class: 'kanban',
        verdict: 'approved',
        whereFound: [],
        path: 'mcp',
        fallbackPath: 'browser-driven',
        pathCandidates: [
          { path: 'mcp', endpoint: 'https://mcp.jira.example/mcp' },
          { path: 'browser-driven', endpoint: 'https://jira.example/issues' },
        ],
        endpoint: 'https://mcp.jira.example/mcp',
        credentialId,
        credentialKind: 'location',
        credentialLanded: false,
        managerApprovedAt: 2,
        itApprovedAt: 3,
        createdAt: 1,
      });
    });
    vi.stubEnv('DAY0_BROWSER_MCP_URL', DEFAULT_BROWSER_MCP_URL);
    const probeBrowser = vi.fn();
    // Revoking the credential is the rollback the surface request itself
    // offers. Descending to a rung that needs none would leave the connection
    // standing after the authority it was approved on was taken away.
    const outcome = await runSurfaceProbe(
      {
        runMutation: harness.mutation.bind(harness),
        runQuery: harness.query.bind(harness),
        runAction: async (): Promise<never> => {
          throw new Error('credential row is gone');
        },
      } as unknown as ActionCtx,
      surfaceId,
      false,
      { probeBrowser, probeMcp: vi.fn(), probeSlack: vi.fn(), now: (): number => 1_000 },
    );
    expect(outcome).toMatchObject({
      verdict: 'ungranted',
      reason: 'credential is unavailable or revoked',
    });
    expect(probeBrowser).not.toHaveBeenCalled();
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({
      verdict: 'ungranted',
      path: 'mcp',
      endpoint: 'https://mcp.jira.example/mcp',
      probeAttempts: [{ path: 'mcp', outcome: 'ungranted' }],
    });
  });

  it('falls from a failed generic MCP route to the approved browser floor', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await harness.run(
      async (ctx): Promise<{ surfaceId: Id<'surfaces'> }> => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'Jira employee',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        const credentialId = await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'location',
          label: 'Jira automation credential',
          ciphertext: 'not-read-by-this-contract',
          iv: 'not-read-by-this-contract',
          source: 'entered',
          createdAt: 1,
        });
        const surfaceId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'jira',
          displayName: 'Jira',
          class: 'kanban',
          verdict: 'approved',
          whereFound: [],
          path: 'mcp',
          fallbackPath: 'browser-driven',
          pathCandidates: [
            { path: 'mcp', endpoint: 'https://mcp.jira.example/mcp' },
            { path: 'browser-driven', endpoint: 'https://jira.example/issues' },
          ],
          endpoint: 'https://mcp.jira.example/mcp',
          credentialId,
          credentialKind: 'location',
          credentialLanded: false,
          managerApprovedAt: 2,
          itApprovedAt: 3,
          request: { expiresInDays: 30 },
          createdAt: 1,
        });
        const sourceId = await ctx.db.insert('docSources', {
          userId: 'owner',
          label: 'Jira runbook',
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert('docPages', {
          sourceId,
          ref: 'jira.md',
          title: 'Jira',
          markdown: '# Jira\n\n- Probe marker: page title `Jira - Issues`.',
          updatedAt: 1,
        });
        return { surfaceId };
      },
    );
    vi.stubEnv('DAY0_BROWSER_MCP_URL', DEFAULT_BROWSER_MCP_URL);
    const probeMcp = vi.fn(async (): Promise<never> => {
      throw new Error('MCP server returned HTTP 503');
    });
    const probeBrowser = vi.fn(async () => ({
      toolAllowlist: ['browser_navigate', 'browser_snapshot'],
      toolArguments: [],
    }));

    const outcome = await runSurfaceProbe(
      {
        runMutation: harness.mutation.bind(harness),
        runQuery: harness.query.bind(harness),
        runAction: async (): Promise<string> => 'jira-contract-credential',
      } as unknown as ActionCtx,
      surfaceId,
      false,
      { probeBrowser, probeMcp, probeSlack: vi.fn(), now: (): number => 1_000 },
    );

    expect(outcome).toMatchObject({ verdict: 'connected' });
    expect(probeMcp).toHaveBeenCalledOnce();
    expect(probeBrowser).toHaveBeenCalledWith(
      'https://jira.example/issues',
      DEFAULT_BROWSER_MCP_URL,
      undefined,
      'Jira - Issues',
    );
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({
      verdict: 'connected',
      path: 'browser-driven',
      endpoint: 'https://jira.example/issues',
      fallbackPath: 'escalate',
      toolAllowlist: ['browser_navigate', 'browser_snapshot'],
      probeAttempts: [
        {
          path: 'mcp',
          endpoint: 'https://mcp.jira.example/mcp',
          outcome: 'demoted',
          reason: 'MCP server returned HTTP 503',
        },
      ],
    });
  });
});

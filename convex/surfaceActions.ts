'use node';

import { randomUUID } from 'node:crypto';
import { MCPClient } from '@mastra/mcp';
import { v } from 'convex/values';
import type { GenericId } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { assertOwnsAgentAction } from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';

const MCP_CLASS_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  kanban: ['list_issues', 'get_issue', 'list_comments', 'create_comment', 'save_issue'],
  'browser-driven': ['browser_navigate', 'browser_snapshot'],
};

const SLACK_METHOD_DEFAULTS = [
  'auth.test',
  'users.lookupByEmail',
  'conversations.open',
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'chat.postMessage',
] as const;

const REQUIRED_SLACK_METHODS = [
  'auth.test',
  'users.lookupByEmail',
  'conversations.open',
] as const;

interface ToolDefinition {
  inputSchema?: unknown;
}

interface McpProbeClient {
  listTools(): Promise<Record<string, unknown>>;
  listToolDefinitionsWithErrors(options?: { perServerTimeoutMs?: number }): Promise<{
    definitions: Record<string, Record<string, ToolDefinition>>;
    errors: Record<string, string>;
  }>;
  disconnect(): Promise<void>;
}

interface McpDiscovery {
  toolAllowlist: string[];
  toolArguments: Array<{ tool: string; arguments: string[] }>;
}

interface SlackProbeResult {
  toolAllowlist: string[];
  managerDmChannelId: string;
  providerIdentityId: string;
  providerWorkspaceId?: string;
}

interface ProbeDependencies {
  probeMcp: typeof probeMcpSurface;
  probeSlack: typeof probeSlackSurface;
  now(): number;
}

export interface ProbeOutcome {
  verdict: 'connected' | 'ungranted' | 'listed-dead' | 'skipped';
  reason?: string;
  toolAllowlist?: string[];
  managerDmReady?: boolean;
}

type McpClientFactory = (endpoint: URL, credential: string) => McpProbeClient;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CredentialId = GenericId<'credentials'>;

const credentialInternal = internal as unknown as {
  credentials: {
    decrypt: FunctionReference<
      'action',
      'internal',
      { credentialId: CredentialId },
      string
    >;
    store: FunctionReference<
      'action',
      'internal',
      {
        userId: string;
        kind: 'value' | 'location' | 'oauth';
        label: string;
        plaintext?: string;
        source: { sourceId: Id<'docSources'>; ref: string } | 'entered';
        appId?: string;
      },
      CredentialId
    >;
  };
};

const probeDependencies: ProbeDependencies = {
  probeMcp: probeMcpSurface,
  probeSlack: probeSlackSurface,
  now: (): number => Date.now(),
};

/**
 * Read top-level argument names from a provider-discovered JSON schema.
 *
 * Args:
 *   schema: Untrusted MCP input schema.
 *
 * Returns:
 *   Sorted top-level property names, or an empty array for an invalid schema.
 */
export function argumentNamesFromSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties).sort((left: string, right: string): number =>
    left.localeCompare(right),
  );
}

/**
 * Intersect provider-discovered tools with the immutable class allowlist.
 *
 * Args:
 *   definitions: Tool definitions returned by MCP discovery.
 *   surfaceClass: Charter class used to select the maximum capability set.
 *
 * Returns:
 *   Persistable tool and argument metadata.
 *
 * Raises:
 *   Error: If the class has no MCP defaults or the provider exposes no allowed tool.
 */
export function mcpAllowlist(
  definitions: Record<string, ToolDefinition>,
  surfaceClass: string,
): McpDiscovery {
  const defaults = MCP_CLASS_DEFAULTS[surfaceClass];
  if (!defaults) throw new Error(`MCP probing is not supported for class ${surfaceClass}.`);
  const toolAllowlist = defaults.filter((name: string): boolean => definitions[name] !== undefined);
  if (toolAllowlist.length === 0) {
    throw new Error('MCP server returned no tools allowed for this surface class.');
  }
  return {
    toolAllowlist,
    toolArguments: toolAllowlist.map(
      (tool: string): { tool: string; arguments: string[] } => ({
        tool,
        arguments: argumentNamesFromSchema(definitions[tool]?.inputSchema),
      }),
    ),
  };
}

/**
 * Extract only approved Slack Web API methods named in the policy pages.
 *
 * Args:
 *   markdown: Combined policy markdown.
 *
 * Returns:
 *   Methods named by the policy, in the fixed least-privilege order.
 */
export function slackMethodsFromPolicy(markdown: string): string[] {
  return SLACK_METHOD_DEFAULTS.filter((method: string): boolean =>
    new RegExp(`(^|[^A-Za-z0-9_.])${method.replace('.', '\\.')}(?=$|[^A-Za-z0-9_.])`).test(
      markdown,
    ),
  );
}

/**
 * Convert an arbitrary provider failure into safe, bounded surface metadata.
 *
 * Args:
 *   error: Provider or client failure.
 *   credential: Decrypted credential that must be removed exactly.
 *
 * Returns:
 *   One flattened, clipped and token-redacted error message.
 */
export function safeProviderError(error: unknown, credential: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutExactValue = credential ? raw.replaceAll(credential, '<redacted>') : raw;
  const withoutTokenShapes = withoutExactValue
    .replace(/\b(?:lin_api_|xox[baprs]-|ntn_|secret_)[A-Za-z0-9_-]+\b/gi, '<redacted>')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return (withoutTokenShapes || 'Provider probe failed.').slice(0, 300);
}

/**
 * Validate the one remote MCP endpoint supported in this lane.
 *
 * Args:
 *   endpoint: Evidence-derived surface endpoint.
 *
 * Returns:
 *   The exact Linear Streamable HTTP endpoint.
 *
 * Raises:
 *   Error: If the URL, scheme, host, or path is not the approved endpoint.
 */
export function linearMcpEndpoint(endpoint: string | undefined): URL {
  if (!endpoint) throw new Error('No MCP endpoint is documented for this surface.');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('The documented MCP endpoint is not a valid URL.');
  }
  if (parsed.href !== 'https://mcp.linear.app/mcp') {
    throw new Error('The documented MCP endpoint is not the approved Linear host.');
  }
  return parsed;
}

/**
 * Create the production MCP client with a bearer bound to one exact host.
 *
 * Args:
 *   endpoint: Validated Linear endpoint.
 *   credential: Decrypted provider bearer.
 *
 * Returns:
 *   A client exposing only the discovery methods used by probing.
 */
function createMcpClient(endpoint: URL, credential: string): McpProbeClient {
  return new MCPClient({
    id: `day0-surface-probe-${randomUUID()}`,
    servers: {
      surface: {
        url: endpoint,
        allowedHosts: [endpoint.host],
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      },
    },
    timeout: 30_000,
  });
}

/**
 * Discover and constrain the tools exposed by one MCP surface.
 *
 * Args:
 *   endpoint: Surface endpoint.
 *   credential: Decrypted bearer kept inside the Node action.
 *   surfaceClass: Class whose defaults cap the discovered tools.
 *   makeClient: Client factory, replaceable by behavioural tests.
 *
 * Returns:
 *   Allowlisted names and provider-discovered argument names.
 */
export async function probeMcpSurface(
  endpoint: string | undefined,
  credential: string,
  surfaceClass: string,
  makeClient: McpClientFactory = createMcpClient,
): Promise<McpDiscovery> {
  const url = linearMcpEndpoint(endpoint);
  const client = makeClient(url, credential);
  try {
    const executableTools = await client.listTools();
    if (Object.keys(executableTools).length === 0) throw new Error('MCP server returned no tools.');
    const { definitions, errors } = await client.listToolDefinitionsWithErrors({
      perServerTimeoutMs: 30_000,
    });
    if (errors.surface) throw new Error(errors.surface);
    const catalog = definitions.surface;
    if (!catalog) throw new Error('MCP server returned no tool definitions.');
    return mcpAllowlist(catalog, surfaceClass);
  } finally {
    await client.disconnect();
  }
}

/**
 * Call one Slack Web API method and enforce its in-band success contract.
 *
 * Args:
 *   fetcher: HTTP implementation.
 *   credential: Decrypted bot token.
 *   method: Fixed Slack method name.
 *   query: Optional GET query values.
 *   body: Optional POST JSON values.
 *
 * Returns:
 *   Parsed successful response.
 *
 * Raises:
 *   Error: If HTTP or Slack reports failure.
 */
async function callSlack(
  fetcher: Fetcher,
  credential: string,
  method: string,
  query?: Record<string, string>,
  body?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  const response = await fetcher(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${credential}`,
      ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      typeof payload.error === 'string' ? payload.error : `Slack returned HTTP ${response.status}.`,
    );
  }
  return payload;
}

/**
 * Verify Slack identity and derive the manager's dedicated DM channel.
 *
 * Args:
 *   credential: Decrypted bot token.
 *   bossEmail: Manager email stored on the agent.
 *   policyMarkdown: Owner-visible policy pages naming allowed methods.
 *   fetcher: HTTP implementation, replaceable by behavioural tests.
 *
 * Returns:
 *   Constrained methods and safe provider identifiers.
 */
export async function probeSlackSurface(
  credential: string,
  bossEmail: string,
  policyMarkdown: string,
  fetcher: Fetcher = fetch,
): Promise<SlackProbeResult> {
  const toolAllowlist = slackMethodsFromPolicy(policyMarkdown);
  const missing = REQUIRED_SLACK_METHODS.filter(
    (method: string): boolean => !toolAllowlist.includes(method),
  );
  if (missing.length > 0) {
    throw new Error(`Slack policy does not allow required methods: ${missing.join(', ')}.`);
  }
  const auth = await callSlack(fetcher, credential, 'auth.test');
  if (typeof auth.user_id !== 'string') throw new Error('Slack auth.test returned no bot identity.');
  const lookup = await callSlack(fetcher, credential, 'users.lookupByEmail', {
    email: bossEmail,
  });
  const managerId = (lookup.user as { id?: unknown } | undefined)?.id;
  if (typeof managerId !== 'string') {
    throw new Error('Slack users.lookupByEmail returned no manager identity.');
  }
  const opened = await callSlack(fetcher, credential, 'conversations.open', undefined, {
    users: managerId,
  });
  const channelId = (opened.channel as { id?: unknown } | undefined)?.id;
  if (typeof channelId !== 'string') {
    throw new Error('Slack conversations.open returned no DM channel.');
  }
  return {
    toolAllowlist,
    managerDmChannelId: channelId,
    providerIdentityId: auth.user_id,
    providerWorkspaceId: typeof auth.team_id === 'string' ? auth.team_id : undefined,
  };
}

/**
 * Execute one generation-fenced provider probe.
 *
 * Args:
 *   ctx: Convex Node action context.
 *   surfaceId: Surface being verified.
 *   renewExpiry: Whether a deliberate manual probe renews the approved lease.
 *
 * Returns:
 *   Safe connection outcome containing no credential or provider response body.
 */
export async function runSurfaceProbe(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
  renewExpiry: boolean,
  dependencies: ProbeDependencies = probeDependencies,
): Promise<ProbeOutcome> {
  const claimed = await ctx.runMutation(internal.surfaces.beginProbe, { surfaceId });
  if (!claimed) return { verdict: 'skipped', reason: 'Surface is not ready to probe.' };
  const { surface, generation } = claimed;
  const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, { surfaceId });
  if (!context) return { verdict: 'skipped', reason: 'Surface no longer exists.' };
  if (!surface.credentialId) {
    const reason = `credential not in the docs; ${surface.credentialLocation ?? 'location not documented'}`;
    await ctx.runMutation(internal.surfaces.recordProbeFailure, {
      surfaceId,
      generation,
      verdict: 'ungranted',
      reason,
    });
    return { verdict: 'ungranted', reason };
  }

  let credential: string;
  try {
    credential = await ctx.runAction(credentialInternal.credentials.decrypt, {
      credentialId: surface.credentialId,
    });
  } catch {
    const reason = 'credential is unavailable or revoked';
    await ctx.runMutation(internal.surfaces.recordProbeFailure, {
      surfaceId,
      generation,
      verdict: 'ungranted',
      reason,
    });
    return { verdict: 'ungranted', reason };
  }

  try {
    let toolAllowlist: string[];
    let toolArguments: Array<{ tool: string; arguments: string[] }> = [];
    let managerDmChannelId: string | undefined;
    let providerIdentityId: string | undefined;
    let providerWorkspaceId: string | undefined;
    if (surface.path === 'mcp') {
      const discovery = await dependencies.probeMcp(
        surface.endpoint,
        credential,
        surface.class,
      );
      toolAllowlist = discovery.toolAllowlist;
      toolArguments = discovery.toolArguments;
    } else if (surface.path === 'documented-api' && surface.class === 'chat') {
      if (!surface.endpoint?.startsWith('https://slack.com/api/')) {
        throw new Error('The documented Slack API endpoint is not the approved Slack host.');
      }
      const pages: Doc<'docPages'>[] = await ctx.runQuery(
        internal.orientationData.pagesForAgent,
        { agentId: surface.agentId },
      );
      const slack = await dependencies.probeSlack(
        credential,
        context.agent.bossEmail,
        pages.map((page: Doc<'docPages'>): string => page.markdown).join('\n\n'),
      );
      toolAllowlist = slack.toolAllowlist;
      managerDmChannelId = slack.managerDmChannelId;
      providerIdentityId = slack.providerIdentityId;
      providerWorkspaceId = slack.providerWorkspaceId;
    } else {
      throw new Error(`Surface path ${surface.path ?? 'unknown'} cannot be probed.`);
    }
    const verifiedAt = dependencies.now();
    const expiresInDays = Number(
      (surface.request as { expiresInDays?: unknown } | undefined)?.expiresInDays,
    );
    const expiresAt =
      renewExpiry && Number.isFinite(expiresInDays) && expiresInDays > 0
        ? verifiedAt + expiresInDays * 24 * 60 * 60 * 1_000
        : undefined;
    const recorded = await ctx.runMutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation,
      toolAllowlist,
      toolArguments,
      managerDmChannelId,
      providerIdentityId,
      providerWorkspaceId,
      verifiedAt,
      expiresAt,
    });
    if (!recorded) {
      return { verdict: 'skipped', reason: 'A newer surface probe superseded this result.' };
    }
    await ctx.runMutation(internal.agents.grantScope, {
      agentId: surface.agentId,
      scope: `${surface.slug}:read`,
    });
    return {
      verdict: 'connected',
      toolAllowlist,
      managerDmReady: managerDmChannelId !== undefined,
    };
  } catch (error) {
    const reason = safeProviderError(error, credential);
    await ctx.runMutation(internal.surfaces.recordProbeFailure, {
      surfaceId,
      generation,
      verdict: 'listed-dead',
      reason,
    });
    return { verdict: 'listed-dead', reason };
  } finally {
    credential = '';
  }
}

/** Owner-checked shell and UI entry point for a deliberate probe. */
export const probe = action({
  args: { surfaceId: v.id('surfaces') },
  handler: async (ctx, args): Promise<ProbeOutcome> => {
    const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, args);
    if (!context) throw new Error('Surface not found.');
    await assertOwnsAgentAction(ctx, context.surface.agentId);
    assertRealMode('Surface probing');
    return await ctx.runAction(internal.surfaceActions.probeInternal, {
      surfaceId: args.surfaceId,
      renewExpiry: true,
    });
  },
});

/** Internal approval and maintenance entry point for one isolated probe. */
export const probeInternal = internalAction({
  args: { surfaceId: v.id('surfaces'), renewExpiry: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ProbeOutcome> =>
    await runSurfaceProbe(ctx, args.surfaceId, args.renewExpiry ?? false),
});

/**
 * Store a write-only credential landed by the owner and schedule its probe.
 *
 * The plaintext is passed directly to Lane A's encrypted store action and is
 * never returned or persisted on the surface.
 */
export const landCredential = action({
  args: { surfaceId: v.id('surfaces'), label: v.string(), plaintext: v.string() },
  handler: async (ctx, args): Promise<{ landed: true; probeScheduled: boolean }> => {
    const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, {
      surfaceId: args.surfaceId,
    });
    if (!context) throw new Error('Surface not found.');
    await assertOwnsAgentAction(ctx, context.surface.agentId);
    assertRealMode('Credential landing');
    if (!context.agent.userId) throw new Error('Agent has no owner.');
    const plaintext = args.plaintext.trim();
    if (!plaintext) throw new Error('Credential value is required.');
    const method = (context.surface.request as { credential?: { method?: unknown } } | undefined)
      ?.credential?.method;
    const kind = method === 'oauth' ? 'oauth' : 'location';
    const credentialId: CredentialId = await ctx.runAction(credentialInternal.credentials.store, {
      userId: context.agent.userId,
      kind,
      label: args.label.trim() || `${context.surface.displayName} credential`,
      plaintext,
      source: 'entered',
    });
    await ctx.runMutation(internal.surfaces.attachCredential, {
      surfaceId: context.surface._id,
      credentialId,
      credentialLocation: context.surface.credentialLocation,
    });
    const probeScheduled =
      context.surface.managerApprovedAt !== undefined && context.surface.itApprovedAt !== undefined;
    if (probeScheduled) {
      await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
        surfaceId: context.surface._id,
        renewExpiry: true,
      });
    }
    return { landed: true, probeScheduled };
  },
});

/** Expire due leases and isolate hourly re-probes by surface. */
export const reprobeAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ expired: number; scheduled: number }> => {
    if (SURFACE_MODE === 'mock') return { expired: 0, scheduled: 0 };
    const now = Date.now();
    const surfaces: Doc<'surfaces'>[] = await ctx.runQuery(
      internal.orientationData.connectedForReprobe,
      {},
    );
    let expired = 0;
    let scheduled = 0;
    for (const surface of surfaces) {
      if (surface.expiresAt !== undefined && surface.expiresAt <= now) {
        await ctx.runMutation(internal.surfaces.recordExpired, { surfaceId: surface._id, now });
        expired += 1;
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
        surfaceId: surface._id,
      });
      scheduled += 1;
    }
    return { expired, scheduled };
  },
});

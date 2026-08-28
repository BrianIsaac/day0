'use node';

import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { v } from 'convex/values';
import type { GenericId } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { assertOwnsAgentAction } from './ownership';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { createSecretMcpClient } from '../src/surfaces/mcp-client';
import {
  browserComponent,
  browserComponentRefusal,
  BROWSER_DRIVER_ABSENT,
  BROWSER_DRIVER_ABSENT_REASON,
  isDriverUnreachable,
  browserPageTitle,
  browserTitleMarker,
  BROWSER_TOOLS,
  navigationResultRefusal,
} from '../src/surfaces/browser';
import { interpretToolResult } from '../src/surfaces/mcp';
import {
  channelsAwaitingInvite,
  documentedChannelNames,
  type ChannelMembership,
} from '../src/surfaces/slack-policy';
import { safeFailureMessage } from '../src/surfaces/redact';
import { SLACK_API_ENDPOINT, slackApiUrl } from '../src/surfaces/slack-endpoint';
import { actionIntent } from '../src/surfaces/policy';

const SLACK_METHOD_DEFAULTS = [
  'auth.test',
  'users.lookupByEmail',
  'conversations.open',
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'chat.postMessage',
] as const;

const REQUIRED_SLACK_METHODS = ['auth.test', 'users.lookupByEmail', 'conversations.open'] as const;

export interface ToolDefinition {
  inputSchema?: unknown;
}

interface McpProbeClient {
  listToolDefinitionsWithErrors(options?: { perServerTimeoutMs?: number }): Promise<{
    definitions: Record<string, Record<string, ToolDefinition>>;
    errors: Record<string, string>;
  }>;
  disconnect(): Promise<void>;
}

/** The browser driver additionally has to open a page for the liveness check. */
interface BrowserProbeClient extends McpProbeClient {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }>;
}

export interface McpDiscovery {
  toolAllowlist: string[];
  toolArguments: Array<{ tool: string; arguments: string[] }>;
}

interface SlackProbeResult {
  toolAllowlist: string[];
  channelsNotJoined: string[];
  managerDmChannelId: string;
  managerUserId: string;
  managerName?: string;
  providerIdentityId: string;
  providerWorkspaceId?: string;
}

/** How many `conversations.list` pages the membership check will read. */
const MAX_CHANNEL_PAGES = 5;

interface ProbeDependencies {
  probeBrowser: typeof probeBrowserSurface;
  probeMcp: typeof probeMcpSurface;
  probeSlack: typeof probeSlackSurface;
  now(): number;
}

export interface ProbeOutcome {
  verdict: 'connected' | 'ungranted' | 'listed-dead' | 'skipped';
  reason?: string;
  toolAllowlist?: string[];
  /** Documented channels the app still has to be invited to, hash-prefixed. */
  channelsNotJoined?: string[];
  managerDmReady?: boolean;
}

type McpClientFactory = (endpoint: URL, credential: string) => McpProbeClient;
type HostResolver = (hostname: string) => Promise<string[]>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CredentialId = GenericId<'credentials'>;

const NON_PUBLIC_MCP_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_MCP_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_MCP_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

/** A refusal caused by Day0's deployment or protocol support, not provider liveness. */
class Day0ProbeLimitation extends Error {}

/**
 * Run one Day0-side step so its failure is never read as provider liveness.
 *
 * Reading the agent's pages and writing the connected row are Day0's own
 * database, not the enterprise's endpoint. They sit inside the same `try` as
 * the provider call, so without this an oversized catalogue or a failed write
 * would be recorded as `listed-dead` - a claim about the enterprise's system
 * that a Day0 failure does not support.
 *
 * Args:
 *   what: What Day0 was doing, for the card.
 *   step: The Day0-side operation.
 *
 * Returns:
 *   Whatever the step resolved with.
 *
 * Raises:
 *   Day0ProbeLimitation: If the step failed.
 */
async function day0Step<T>(what: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new Day0ProbeLimitation(
      `Day0 could not ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function probeFailureVerdict(
  error: unknown,
  safeReason: string,
): 'ungranted' | 'listed-dead' {
  if (error instanceof Day0ProbeLimitation || safeReason.includes(BROWSER_DRIVER_ABSENT)) {
    return 'ungranted';
  }
  if (
    /\b(?:HTTP\s+)?(?:401|403)\b|\bunauthori[sz]ed\b|\bforbidden\b|invalid[_ -]?(?:auth|token|credential)|token[_ -]?expired|missing[_ -]?scope|not[_ -]?authed|not a member|no manager email|deactivated|own bot user/i.test(
      safeReason,
    )
  ) {
    return 'ungranted';
  }
  return 'listed-dead';
}

const credentialInternal = internal as unknown as {
  credentials: {
    decrypt: FunctionReference<'action', 'internal', { credentialId: CredentialId }, string>;
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
  probeBrowser: probeBrowserSurface,
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

/** How many discovered tools one surface row may carry. */
export const MAX_MCP_TOOLS = 250;

/**
 * Names reserved for Day0's own browser floor.
 *
 * The floor's tools are exempt from the write default - `browser_navigate` and
 * `browser_snapshot` carry no read verb but only look at a page - and that
 * exemption is keyed on the name alone. A discovered catalogue must not be able
 * to claim it: a third party's `browser_navigate` means whatever that server
 * wants, and it would run unattended and without the floor's origin bound.
 */
const BROWSER_FLOOR_NAME = /^browser[_-]/i;

/**
 * Admit the catalogue exposed by an approved MCP endpoint.
 *
 * Args:
 *   definitions: Tool definitions returned by MCP discovery.
 * Returns:
 *   Persistable tool and argument metadata.
 *
 * Raises:
 *   Day0ProbeLimitation: If the provider exposes no tool Day0 can name, or more
 *     than one surface row can carry.
 */
export function mcpAllowlist(definitions: Record<string, ToolDefinition>): McpDiscovery {
  const named = Object.keys(definitions).filter(
    (tool: string): boolean => tool.trim().length > 0 && !BROWSER_FLOOR_NAME.test(tool.trim()),
  );
  if (named.length > MAX_MCP_TOOLS) {
    throw new Day0ProbeLimitation(
      `The MCP server exposed ${named.length} tools; Day0 records at most ${MAX_MCP_TOOLS} on one surface. ` +
        'This is a Day0 capacity limit, not evidence that the system is unavailable.',
    );
  }
  const classified = named
    .map((tool: string) => ({
      tool,
      intent: actionIntent({ kind: 'mcp.call', surface: 'probe', tool, toolArgs: {} }),
    }))
    .sort((left, right): number => {
      if (left.intent !== right.intent) return left.intent === 'read' ? -1 : 1;
      return left.tool.localeCompare(right.tool);
    });
  const toolAllowlist = classified.map(({ tool }): string => tool);
  if (toolAllowlist.length === 0) {
    throw new Day0ProbeLimitation(
      'The MCP server answered but exposed no named tools Day0 can call. This is a protocol capability gap, not evidence that the system is unavailable.',
    );
  }
  return {
    toolAllowlist,
    toolArguments: toolAllowlist.map((tool: string): { tool: string; arguments: string[] } => ({
      tool,
      arguments: argumentNamesFromSchema(definitions[tool]?.inputSchema),
    })),
  };
}

/** Keep Day0's browser driver on its fixed floor capability set. */
function browserAllowlist(definitions: Record<string, ToolDefinition>): McpDiscovery {
  const admitted = Object.fromEntries(
    BROWSER_TOOLS.filter((tool: string): boolean => definitions[tool] !== undefined).map(
      (tool: string): [string, ToolDefinition] => [tool, definitions[tool]],
    ),
  );
  if (Object.keys(admitted).length === 0) {
    throw new Day0ProbeLimitation(
      'Day0 browser component returned no tools allowed for the browser floor.',
    );
  }
  return {
    toolAllowlist: Object.keys(admitted),
    toolArguments: Object.keys(admitted).map(
      (tool: string): { tool: string; arguments: string[] } => ({
        tool,
        arguments: argumentNamesFromSchema(admitted[tool]?.inputSchema),
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
  return safeFailureMessage(error, credential, 'Provider probe failed.');
}

/**
 * Validate the exact evidence-backed MCP endpoint stored on the approved row.
 *
 * Args:
 *   endpoint: Evidence-derived surface endpoint.
 *
 * Returns:
 *   The exact public HTTPS endpoint.
 *
 * Raises:
 *   Error: If the URL could address this deployment or another private network.
 */
export function approvedMcpEndpoint(endpoint: string | undefined): URL {
  const refusal = (): never => {
    throw new Day0ProbeLimitation(
      'The approved MCP endpoint must use a public HTTPS hostname. Day0 refused the address before creating a credential-bearing client.',
    );
  };
  if (!endpoint) return refusal();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return refusal();
  }
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const privateName =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.localdomain') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.lan') ||
    !hostname.includes('.');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    hostname === '' ||
    isIP(hostname) !== 0 ||
    privateName
  ) {
    return refusal();
  }
  return parsed;
}

/** Resolve the approved hostname immediately before creating a bearer client. */
async function resolveMcpHostname(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
}

/** Refuse a hostname if any current DNS answer can address a non-public network. */
async function assertPublicMcpAddresses(
  hostname: string,
  resolveHostname: HostResolver,
): Promise<void> {
  const addresses = await resolveHostname(hostname);
  if (addresses.length === 0) throw new Error('The approved MCP endpoint hostname did not resolve.');
  const hasNonPublicAddress = addresses.some((address: string): boolean => {
    const family = isIP(address);
    if (family === 4) return NON_PUBLIC_MCP_ADDRESSES.check(address, 'ipv4');
    if (family === 6) {
      if (address.toLowerCase().startsWith('::ffff:')) return true;
      return NON_PUBLIC_MCP_ADDRESSES.check(address, 'ipv6');
    }
    return true;
  });
  if (hasNonPublicAddress) {
    throw new Day0ProbeLimitation(
      'The approved MCP hostname resolved to a private, loopback, link-local, reserved or otherwise non-public address. Day0 refused the address before creating a credential-bearing client.',
    );
  }
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
  return createSecretMcpClient({
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
 * Create the probe client for the browser driver, which takes no credential.
 *
 * The driver is Day0's own service on the compose network, not the system
 * being reached, so it is never handed the system's credential.
 */
function createBrowserProbeClient(endpoint: URL): BrowserProbeClient {
  const client = createSecretMcpClient({
    id: `day0-browser-probe-${randomUUID()}`,
    servers: { surface: { url: endpoint, allowedHosts: [endpoint.host] } },
    timeout: 30_000,
  });
  return {
    listToolDefinitionsWithErrors: async (options?: { perServerTimeoutMs?: number }) =>
      await client.listToolDefinitionsWithErrors(options),
    callTool: async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; text: string }> => {
      const tools = await client.listTools();
      const tool = tools[`surface_${name}`];
      if (!tool?.execute) throw new Error(`the browser driver does not expose ${name}.`);
      return interpretToolResult(await tool.execute(args, {}));
    },
    disconnect: async (): Promise<void> => await client.disconnect(),
  };
}

/**
 * Verify the browser floor can reach one documented web UI.
 *
 * Two things have to be true before a `browser-driven` surface is connected,
 * and they are separate: the driver must be up and expose the tools the floor
 * needs, and the documented page must actually answer. Checking only the first
 * would connect a surface whose system is gone - presence is not liveness, and
 * on this path the driver's presence says nothing at all about the system's.
 *
 * Args:
 *   endpoint: The documented web UI address from the surface row.
 *   driverUrl: Configured browser driver address.
 *   makeClient: Client factory, replaceable by behavioural tests.
 *
 * Returns:
 *   Allowlisted browser tools and their provider-discovered argument names.
 *
 * Raises:
 *   Error: If the driver is unreachable, exposes none of the floor's tools, or
 *     cannot open the documented page.
 */
export async function probeBrowserSurface(
  endpoint: string | undefined,
  driverUrl: string | undefined,
  makeClient: (url: URL) => BrowserProbeClient = createBrowserProbeClient,
  titleMarker?: string,
): Promise<McpDiscovery> {
  if (!endpoint) {
    throw new Day0ProbeLimitation('No web UI address is documented for this surface.');
  }
  if (!titleMarker?.trim()) {
    throw new Day0ProbeLimitation(
      'No page title marker is documented for this browser surface, so Day0 cannot verify the page safely.',
    );
  }
  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    throw new Day0ProbeLimitation('The documented web UI address is not a valid URL.');
  }
  const component = browserComponent(driverUrl);
  if (!component.present) throw new Error(component.reason);
  const client = makeClient(component.url);
  try {
    const { definitions, errors } = await client.listToolDefinitionsWithErrors({
      perServerTimeoutMs: 30_000,
    });
    if (errors.surface) {
      // A driver that is not listening is the component being absent, and the
      // probe says so with the code rather than with the transport's own words.
      if (isDriverUnreachable(errors.surface)) throw new Error(BROWSER_DRIVER_ABSENT_REASON);
      throw new Day0ProbeLimitation(`Day0 browser component failed: ${errors.surface}`);
    }
    const catalog = definitions.surface;
    if (!catalog || Object.keys(catalog).length === 0) {
      throw new Day0ProbeLimitation('Day0 browser component returned no tools.');
    }
    const discovery = browserAllowlist(catalog);
    const opened = await client.callTool('browser_navigate', { url: target.href });
    if (opened.isError) {
      throw new Error(`the documented page could not be opened: ${opened.text.slice(0, 160)}`);
    }
    const outside = navigationResultRefusal('browser_navigate', opened.text, endpoint);
    if (outside) throw new Day0ProbeLimitation(outside);
    if (browserPageTitle(opened.text) !== titleMarker.trim()) {
      throw new Day0ProbeLimitation(
        `The documented page answered, but its title did not match the approved marker (${titleMarker.trim()}).`,
      );
    }
    return discovery;
  } catch (error) {
    if (isDriverUnreachable(error)) throw new Error(BROWSER_DRIVER_ABSENT_REASON);
    throw error;
  } finally {
    await client.disconnect();
  }
}

/**
 * Discover and constrain the tools exposed by one MCP surface.
 *
 * Args:
 *   endpoint: Surface endpoint.
 *   credential: Decrypted bearer kept inside the Node action.
 *   makeClient: Client factory, replaceable by behavioural tests.
 *   resolveHostname: DNS resolver, replaceable by behavioural tests.
 *
 * Returns:
 *   Allowlisted names and provider-discovered argument names.
 */
export async function probeMcpSurface(
  endpoint: string | undefined,
  credential: string,
  makeClient: McpClientFactory = createMcpClient,
  resolveHostname: HostResolver = resolveMcpHostname,
): Promise<McpDiscovery> {
  const url = approvedMcpEndpoint(endpoint);
  await assertPublicMcpAddresses(url.hostname, resolveHostname);
  const client = makeClient(url, credential);
  try {
    // Discovery with errors first: `listTools()` returns an empty map for a
    // server that refused the bearer, which would read as "no tools" on the
    // card when the provider actually answered 401.
    const { definitions, errors } = await client.listToolDefinitionsWithErrors({
      perServerTimeoutMs: 30_000,
    });
    if (errors.surface) throw new Error(errors.surface);
    const catalog = definitions.surface;
    // A server that answers with an empty catalogue has answered: it is alive
    // and Day0 has nothing to call on it. `mcpAllowlist` says so as a Day0
    // capability gap, and this branch has to agree - a plain error here would
    // be recorded as `listed-dead`, which is a claim about the enterprise's
    // system that an empty tool list does not support.
    if (!catalog || Object.keys(catalog).length === 0) {
      return mcpAllowlist({});
    }
    return mcpAllowlist(catalog);
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
  const url = slackApiUrl(method);
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
      typeof payload.error === 'string'
        ? `Slack ${method} failed: ${payload.error}`
        : `Slack ${method} returned HTTP ${response.status}.`,
    );
  }
  return payload;
}

/**
 * Check that a looked-up Slack user can be the manager the bot will DM.
 *
 * Args:
 *   user: The `user` object from `users.lookupByEmail`.
 *   botUserId: The bot's own user id from `auth.test`.
 *   bossEmail: The email that was looked up, for the message.
 *
 * Returns:
 *   The manager's Slack user id.
 *
 * Raises:
 *   Error: If the user is missing, is a bot, is deactivated, or is the bot itself.
 */
export function managerUserId(user: unknown, botUserId: string, bossEmail: string): string {
  const record = user && typeof user === 'object' ? (user as Record<string, unknown>) : undefined;
  const id = record?.id;
  if (typeof id !== 'string')
    throw new Error('Slack users.lookupByEmail returned no manager identity.');
  if (record?.is_bot === true || record?.is_app_user === true) {
    throw new Error(`the manager email ${bossEmail} resolves to a Slack bot, not a person.`);
  }
  if (record?.deleted === true) {
    throw new Error(`the manager email ${bossEmail} resolves to a deactivated Slack user.`);
  }
  if (id === botUserId) {
    throw new Error(`the manager email ${bossEmail} resolves to this automation's own bot user.`);
  }
  return id;
}

/**
 * The name Slack shows for the manager, for the approval card's DM line.
 *
 * Args:
 *   user: The `user` object from `users.lookupByEmail`.
 *
 * Returns:
 *   The real name, else the profile's display or real name, else the handle; undefined when none is set.
 */
export function managerDisplayName(user: unknown): string | undefined {
  const record = user && typeof user === 'object' ? (user as Record<string, unknown>) : undefined;
  if (!record) return undefined;
  const profile =
    record.profile && typeof record.profile === 'object'
      ? (record.profile as Record<string, unknown>)
      : {};
  for (const value of [record.real_name, profile.display_name, profile.real_name, record.name]) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
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
export async function probeChannelMembership(
  fetcher: Fetcher,
  credential: string,
  documented: readonly string[],
): Promise<string[]> {
  if (documented.length === 0) return [];
  const visible: ChannelMembership[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
    const payload = await callSlack(fetcher, credential, 'conversations.list', {
      exclude_archived: 'true',
      limit: '200',
      types: 'public_channel',
      ...(cursor ? { cursor } : {}),
    });
    for (const item of Array.isArray(payload.channels) ? payload.channels : []) {
      const channel =
        item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
      if (typeof channel?.name !== 'string') continue;
      visible.push({ isMember: channel.is_member === true, name: channel.name });
    }
    const metadata = payload.response_metadata as { next_cursor?: unknown } | undefined;
    cursor =
      typeof metadata?.next_cursor === 'string' && metadata.next_cursor.trim()
        ? metadata.next_cursor.trim()
        : undefined;
    if (!cursor) break;
  }
  return channelsAwaitingInvite(documented, visible);
}

export async function probeSlackSurface(
  credential: string,
  bossEmail: string,
  policyMarkdown: string,
  fetcher: Fetcher = fetch,
  documentedChannels: readonly string[] = [],
): Promise<SlackProbeResult> {
  const toolAllowlist = slackMethodsFromPolicy(policyMarkdown);
  const missing = REQUIRED_SLACK_METHODS.filter(
    (method: string): boolean => !toolAllowlist.includes(method),
  );
  if (missing.length > 0) {
    throw new Error(`Slack policy does not allow required methods: ${missing.join(', ')}.`);
  }
  const email = bossEmail.trim();
  if (!email) {
    throw new Error('the agent has no manager email, so the manager DM cannot be derived.');
  }
  const auth = await callSlack(fetcher, credential, 'auth.test');
  if (typeof auth.user_id !== 'string')
    throw new Error('Slack auth.test returned no bot identity.');
  let lookup: Record<string, unknown>;
  try {
    lookup = await callSlack(fetcher, credential, 'users.lookupByEmail', { email });
  } catch (error) {
    if (error instanceof Error && /users_not_found/.test(error.message)) {
      throw new Error(
        `the manager email ${email} is not a member of this Slack workspace (users_not_found).`,
      );
    }
    throw error;
  }
  const managerId = managerUserId(lookup.user, auth.user_id, email);
  const opened = await callSlack(fetcher, credential, 'conversations.open', undefined, {
    users: managerId,
  });
  const channelId = (opened.channel as { id?: unknown } | undefined)?.id;
  if (typeof channelId !== 'string') {
    throw new Error('Slack conversations.open returned no DM channel.');
  }
  // A dedicated app is a member of nothing until an administrator invites it,
  // and only they can. That is a fact about the workspace rather than a probe
  // failure - the DM works either way - so it is reported on the card and the
  // connection stands.
  const channelsNotJoined = toolAllowlist.includes('conversations.list')
    ? await probeChannelMembership(fetcher, credential, documentedChannels)
    : [];
  return {
    toolAllowlist,
    channelsNotJoined,
    managerDmChannelId: channelId,
    managerUserId: managerId,
    managerName: managerDisplayName(lookup.user),
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
  const claimed: { surface: Doc<'surfaces'>; generation: number } | null = await ctx.runMutation(
    internal.surfaces.beginProbe,
    { surfaceId },
  );
  if (!claimed) return { verdict: 'skipped', reason: 'Surface is not ready to probe.' };
  let { surface, generation } = claimed;
  const context = await ctx.runQuery(internal.orientationData.surfaceForOrientation, { surfaceId });
  if (!context) return { verdict: 'skipped', reason: 'Surface no longer exists.' };

  const failOrDemote = async (
    reason: string,
    verdict: 'ungranted' | 'listed-dead',
  ): Promise<ProbeOutcome | undefined> => {
    const attemptedAt = dependencies.now();
    const demoted: { surface: Doc<'surfaces'>; generation: number } | null = await ctx.runMutation(
      internal.surfaces.demoteAfterProbeFailure,
      { surfaceId, generation, reason, attemptedAt },
    );
    if (demoted) {
      surface = demoted.surface;
      generation = demoted.generation;
      return undefined;
    }
    const recorded: boolean | undefined = await ctx.runMutation(
      internal.surfaces.recordProbeFailure,
      { surfaceId, generation, verdict, reason, attemptedAt },
    );
    return recorded === false
      ? { verdict: 'skipped', reason: 'A newer surface probe superseded this result.' }
      : { verdict, reason };
  };

  // The route list is capped to the three actual rungs when orientation stores
  // it. This loop is capped independently so a malformed legacy row can never
  // turn a provider failure into an unbounded action.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      surface.pathCandidates?.length &&
      !surface.pathCandidates.some(
        (candidate): boolean =>
          candidate.path === surface.path && candidate.endpoint === surface.endpoint,
      )
    ) {
      const outcome = await failOrDemote(
        'Current surface route does not match the evidence-backed ladder frozen at approval.',
        'ungranted',
      );
      return outcome ?? { verdict: 'skipped', reason: 'The approved surface route changed.' };
    }
    if (surface.path === 'browser-driven') {
      const component = browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL);
      if (component) {
        const outcome = await failOrDemote(component, 'ungranted');
        if (outcome) return outcome;
        continue;
      }
    }
    if (!surface.credentialId && surface.path !== 'browser-driven') {
      const reason = `credential not in the docs; ${surface.credentialLocation ?? 'location not documented'}`;
      const outcome = await failOrDemote(reason, 'ungranted');
      if (outcome) return outcome;
      continue;
    }

    let credential = '';
    try {
      if (surface.credentialId) {
        try {
          credential = await ctx.runAction(credentialInternal.credentials.decrypt, {
            credentialId: surface.credentialId,
          });
        } catch {
          const outcome = await failOrDemote('credential is unavailable or revoked', 'ungranted');
          if (outcome) return outcome;
          continue;
        }
      }

      let toolAllowlist: string[];
      let toolArguments: Array<{ tool: string; arguments: string[] }> = [];
      let channelsNotJoined: string[] = [];
      let managerDmChannelId: string | undefined;
      let managerUserId: string | undefined;
      let managerName: string | undefined;
      let providerIdentityId: string | undefined;
      let providerWorkspaceId: string | undefined;
      if (surface.path === 'mcp') {
        const discovery = await dependencies.probeMcp(surface.endpoint, credential);
        toolAllowlist = discovery.toolAllowlist;
        toolArguments = discovery.toolArguments;
      } else if (surface.path === 'browser-driven') {
        const pages: Doc<'docPages'>[] = await day0Step(
          'read the linked documentation',
          (): Promise<Doc<'docPages'>[]> =>
            ctx.runQuery(internal.orientationData.pagesForAgent, { agentId: surface.agentId }),
        );
        const titleMarker = browserTitleMarker(
          pages.map((page: Doc<'docPages'>): string => page.markdown).join('\n\n'),
        );
        const discovery = await dependencies.probeBrowser(
          surface.endpoint,
          process.env.DAY0_BROWSER_MCP_URL,
          undefined,
          titleMarker,
        );
        toolAllowlist = discovery.toolAllowlist;
        toolArguments = discovery.toolArguments;
      } else if (surface.path === 'documented-api') {
        if (surface.class !== 'chat' || surface.endpoint !== SLACK_API_ENDPOINT) {
          throw new Day0ProbeLimitation(
            `Day0 does not yet have a documented-API probe for ${surface.displayName}. ` +
              `This is a limitation of this Day0 deployment, not evidence that ${surface.displayName} is unavailable. ` +
              'The approved endpoint remains on the card.',
          );
        }
        const pages: Doc<'docPages'>[] = await day0Step(
          'read the linked documentation',
          (): Promise<Doc<'docPages'>[]> =>
            ctx.runQuery(internal.orientationData.pagesForAgent, { agentId: surface.agentId }),
        );
        const slack = await dependencies.probeSlack(
          credential,
          context.agent.bossEmail,
          pages.map((page: Doc<'docPages'>): string => page.markdown).join('\n\n'),
          undefined,
          documentedChannelNames(pages),
        );
        toolAllowlist = slack.toolAllowlist;
        channelsNotJoined = slack.channelsNotJoined;
        managerDmChannelId = slack.managerDmChannelId;
        managerUserId = slack.managerUserId;
        managerName = slack.managerName;
        providerIdentityId = slack.providerIdentityId;
        providerWorkspaceId = slack.providerWorkspaceId;
      } else {
        throw new Day0ProbeLimitation(
          `Day0 has no probe for surface path ${surface.path ?? 'unknown'}. ` +
            `This is a limitation of this Day0 deployment, not evidence that ${surface.displayName} is unavailable.`,
        );
      }
      const verifiedAt = dependencies.now();
      const expiresInDays = Number(
        (surface.request as { expiresInDays?: unknown } | undefined)?.expiresInDays,
      );
      const expiresAt =
        renewExpiry && Number.isFinite(expiresInDays) && expiresInDays > 0
          ? verifiedAt + expiresInDays * 24 * 60 * 60 * 1_000
          : undefined;
      const recorded = await day0Step(
        'record the connected surface',
        (): Promise<boolean> =>
          ctx.runMutation(internal.surfaces.recordConnected, {
            surfaceId,
            generation,
            toolAllowlist,
            toolArguments,
            managerDmChannelId,
            managerUserId,
            managerName,
            providerIdentityId,
            providerWorkspaceId,
            channelsNotJoined,
            verifiedAt,
            expiresAt,
          }),
      );
      if (!recorded) {
        return { verdict: 'skipped', reason: 'A newer surface probe superseded this result.' };
      }
      return {
        verdict: 'connected',
        toolAllowlist,
        channelsNotJoined,
        managerDmReady: managerDmChannelId !== undefined,
      };
    } catch (error) {
      const reason = safeProviderError(error, credential);
      const verdict = probeFailureVerdict(error, reason);
      const outcome = await failOrDemote(reason, verdict);
      if (outcome) return outcome;
    } finally {
      credential = '';
    }
  }
  return { verdict: 'skipped', reason: 'The approved surface ladder was exhausted.' };
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
    // A value typed into the card is never the product of an OAuth install:
    // on an `oauth` surface it is the shared bot token landed as the fallback,
    // a shared credential like any other, so writes through it carry
    // provenance. Only the install flow itself stores kind `oauth`.
    const method = (context.surface.request as { credential?: { method?: unknown } } | undefined)
      ?.credential?.method;
    const kind = method === 'oauth' ? 'value' : 'location';
    const documentedLabel = (
      context.surface.request as { credential?: { label?: unknown } } | undefined
    )?.credential?.label;
    const label =
      typeof documentedLabel === 'string' && documentedLabel.trim()
        ? documentedLabel.trim().slice(0, 160)
        : `${context.surface.displayName} credential`;
    const credentialId: CredentialId = await ctx.runAction(credentialInternal.credentials.store, {
      userId: context.agent.userId,
      kind,
      label,
      plaintext,
      source: 'entered',
    });
    await ctx.runMutation(internal.surfaces.attachCredential, {
      surfaceId: context.surface._id,
      credentialId,
      credentialKind: kind,
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

/**
 * Expire due leases and isolate hourly re-probes by surface.
 *
 * Connected surfaces are re-verified; a surface the last probe left
 * `listed-dead` with its credential and approvals intact is retried, so a
 * transient provider failure does not stay dead until a human clicks Probe.
 */
export const reprobeAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ expired: number; scheduled: number }> => {
    if (SURFACE_MODE === 'mock') return { expired: 0, scheduled: 0 };
    const now = Date.now();
    const surfaces: Doc<'surfaces'>[] = await ctx.runQuery(
      internal.orientationData.reprobeCandidates,
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

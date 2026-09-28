'use node';

import { randomUUID } from 'node:crypto';
import { ConvexError, v } from 'convex/values';
import type { GenericId } from 'convex/values';
import type { FunctionReference } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { assertOwnsAgentAction } from './ownership';
import { relevantSystemText } from './orientationActions';
import { assertRealMode, SURFACE_MODE } from '../src/lib/surface-mode';
import { createSecretMcpClient } from '../src/surfaces/mcp-client';
import {
  checkMcpAddress,
  McpAddressRefusal,
  pinnedFetch,
  resolveHostname as resolveMcpHostname,
  type CheckedMcpAddress,
  type HostResolver,
} from '../src/surfaces/mcp-address';
import {
  browserComponent,
  browserComponentRefusal,
  BROWSER_DRIVER_ABSENT,
  BROWSER_DRIVER_ABSENT_REASON,
  isDriverUnreachable,
  browserPageTitle,
  browserPageUrl,
  browserSignedInMarker,
  browserTitleMarker,
  BROWSER_TOOLS,
  documentedUsername,
  loginForm,
  navigationResultRefusal,
  pageShowsElement,
  refFieldFor,
  withinDocumentedSurface,
  withResolvedRefs,
  type LoginForm,
  type SnapshotElement,
} from '../src/surfaces/browser';
import { interpretToolResult } from '../src/surfaces/mcp';
import {
  channelsAwaitingInvite,
  documentedChannelNames,
  type ChannelMembership,
} from '../src/surfaces/slack-policy';
import { approvedChannelNames } from '../src/surfaces/intake-scope';
import { safeFailureMessage } from '../src/surfaces/redact';
import { ownerKnownValues } from '../src/redaction/known-values';
import { isSlackApiEndpoint, slackApiUrl } from '../src/surfaces/slack-endpoint';
import { actionIntent } from '../src/surfaces/policy';
import { DocumentedApiLimitation, probeDocumentedApi } from '../src/surfaces/http';
import {
  PROVIDER_BACKOFF,
  TransientProviderError,
  transientFromResponse,
} from '../src/lib/transport-error';

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
  /** The `bot_id` on everything this token posts; absent for a token that is not a bot's. */
  providerBotId?: string;
  providerWorkspaceId?: string;
}

/** How many `conversations.list` pages the membership check will read. */
const MAX_CHANNEL_PAGES = 5;

interface ProbeDependencies {
  probeBrowser: typeof probeBrowserSurface;
  probeMcp: typeof probeMcpSurface;
  probeSlack: typeof probeSlackSurface;
  /** The documented-API probe for a system that is not Slack; the network one unless a test replaces it. */
  probeApi?: typeof probeDocumentedApi;
  now(): number;
  /** The pause before a probe's one retry; real time unless a test replaces it. */
  wait?(milliseconds: number): Promise<void>;
}

export interface ProbeOutcome {
  verdict: 'connected' | 'ungranted' | 'listed-dead' | 'skipped';
  reason?: string;
  toolAllowlist?: string[];
  /** Documented channels the app still has to be invited to, hash-prefixed. */
  channelsNotJoined?: string[];
  managerDmReady?: boolean;
}

type McpClientFactory = (checked: CheckedMcpAddress, credential: string) => McpProbeClient;
type EndpointInspector = (endpoint: URL) => Promise<string>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CredentialId = GenericId<'credentials'>;

/** A refusal caused by Day0's deployment or protocol support, not provider liveness. */
class Day0ProbeLimitation extends Error {}

/**
 * A web UI that answered but did not let the credential in: the signed-in
 * page never showed its documented element. The password may have been
 * rotated or the login redesigned; either is the manager's or IT's to fix,
 * and neither says the system is down.
 */
class BrowserSignInRefused extends Error {}

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

/** A provider refusing the authority it was shown: the manager's or IT's to fix. */
const ACCESS_REFUSAL =
  /\b(?:HTTP\s+)?(?:401|403)\b|\bunauthori[sz]ed\b|\bforbidden\b|invalid[_ -]?(?:auth|token|credential)|token[_ -]?expired|missing[_ -]?scope|not[_ -]?authed|not a member|no manager email|deactivated|own bot user/i;

function probeFailureVerdict(error: unknown, safeReason: string): 'ungranted' | 'listed-dead' {
  if (
    error instanceof Day0ProbeLimitation ||
    error instanceof BrowserSignInRefused ||
    safeReason.includes(BROWSER_DRIVER_ABSENT)
  ) {
    return 'ungranted';
  }
  if (ACCESS_REFUSAL.test(safeReason)) return 'ungranted';
  return 'listed-dead';
}

/** The verdicts `beginProbe` admits; a row that left them is no longer this probe's to call. */
const PROBEABLE_VERDICTS: ReadonlyArray<Doc<'surfaces'>['verdict']> = [
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
];

/** How long a probe waits before its one retry. */
export const PROBE_RETRY_WAIT_MS = 5_000;

/**
 * A provider saying "not now": HTTP 429, Slack's `ratelimited`, or the words
 * an MCP server or a gateway uses for either. It is an answer about pace, not
 * about the system or the key, so it never marks a surface dead (Q13).
 */
const RATE_LIMITED =
  /\bratelimited\b|\brate[ _-]?limit(?:ed|ing)?\b|too many requests|\b(?:HTTP|status)\W{0,3}429\b/i;

/** Whether a failed probe call was the provider limiting its rate. */
function isRateLimited(error: unknown, safeReason: string): boolean {
  if (error instanceof TransientProviderError && error.status === 429) return true;
  return RATE_LIMITED.test(safeReason);
}

/** The wait a rate-limited provider asked for, when it named one. */
function askedWait(error: unknown): number | undefined {
  return error instanceof TransientProviderError ? error.retryAfterMs : undefined;
}

/** The fewest and most milliseconds before a rate-limited card that no hourly sweep covers is probed again. */
const RATE_LIMITED_REPROBE_MS = { min: 5 * 60_000, max: 60 * 60_000 } as const;

/** A probe the provider rate-limited on its retry as well; the verdict is left as it was. */
class ProbeRateLimited extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
  }
}

/**
 * A connection that never completed, or a provider answering 5xx.
 *
 * The first alternative is the fixed message the MCP client raises when both
 * of its HTTP transports failed, which is all it says about a reset or a
 * timeout; the Cloudflare 1xxx family is how a fronted provider's own failure
 * arrives, with no HTTP status in the text.
 */
const TRANSIENT_FAILURE =
  /any available HTTP transport|fetch failed|socket hang up|network error|\bE(?:CONN(?:RESET|REFUSED|ABORTED)|TIMEDOUT|PIPE|AI_AGAIN|HOSTUNREACH|NETUNREACH)\b|\bUND_ERR_|timed? ?out|\btimeout\b|net::ERR_(?:CONNECTION|TIMED_OUT|NETWORK|INTERNET|EMPTY_RESPONSE|SOCKET|ADDRESS_UNREACHABLE)|\b(?:HTTP|status)\W{0,3}5\d\d\b|bad gateway|service unavailable|gateway time-?out|internal server error|cloudflare-1xxx|\bError 1\d{3}\b/i;

/** An MCP probe failure that remembers whether the unclipped text was transient. */
class McpProbeFailure extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

/**
 * Whether one more call could change a failed probe's answer.
 *
 * Only a failure that would otherwise be recorded as `listed-dead` qualifies:
 * a refused key and a Day0 limitation are answers, and a second call returns
 * the same one.
 *
 * Args:
 *   error: The failure as thrown.
 *   safeReason: Its redacted, clipped text.
 *
 * Returns:
 *   True for a connection-level failure, a provider 5xx or a rate limit.
 */
function isTransientProbeFailure(error: unknown, safeReason: string): boolean {
  if (probeFailureVerdict(error, safeReason) !== 'listed-dead') return false;
  if (error instanceof McpProbeFailure && error.transient) return true;
  if (error instanceof TransientProviderError) return true;
  return TRANSIENT_FAILURE.test(safeReason) || isRateLimited(error, safeReason);
}

/** A newer probe, or a withdrawn approval, took the surface away while this probe waited to retry. */
class ProbeSuperseded extends Error {}

/**
 * Name the transport failure behind a fetch that never got a response.
 *
 * `fetch` rejects with "fetch failed" and keeps what happened on its cause.
 *
 * Args:
 *   error: What the fetch rejected with.
 *
 * Returns:
 *   The cause's code, else the error's own name, else a plain phrase.
 */
function transportErrorDetail(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  if (error instanceof Error && error.name !== 'Error' && error.name !== 'TypeError') {
    return error.name;
  }
  return 'no connection';
}

/** Real-time pause between a probe's first call and its retry. */
async function waitRealTime(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
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
export function safeProviderError(
  error: unknown,
  credential: string,
  known: readonly string[] = [],
): string {
  return safeFailureMessage(error, credential, 'Provider probe failed.', 300, known);
}

/**
 * Create the production MCP client with a bearer bound to one exact host,
 * dialling only the addresses the probe checked.
 *
 * Args:
 *   checked: The approved endpoint and its checked public addresses.
 *   credential: Decrypted provider bearer.
 *
 * Returns:
 *   A client exposing only the discovery methods used by probing.
 */
function createMcpClient(checked: CheckedMcpAddress, credential: string): McpProbeClient {
  return createSecretMcpClient({
    id: `day0-surface-probe-${randomUUID()}`,
    servers: {
      surface: {
        url: checked.url,
        allowedHosts: [checked.url.host],
        fetch: pinnedFetch(checked),
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

/** What the documentation says a browser probe should see. */
export interface BrowserProbeMarkers {
  /** The page title the documented page shows when it opens (`Probe marker: page title`). */
  readonly title?: string;
  /** An element the page shows once signed in (`Probe marker: after sign-in, element`). */
  readonly afterSignIn?: string;
}

/** The login a browser probe signs in with. */
export interface BrowserProbeLogin {
  /** The surface's decrypted credential, typed only into the page's credential field. */
  readonly credential: string;
  /** The documented account name, for a form that asks for one. */
  readonly username?: string;
}

/** One browser probe: where the page is, the driver that reaches it, and what to check. */
export interface BrowserProbeRequest {
  readonly endpoint: string | undefined;
  readonly driverUrl: string | undefined;
  readonly markers: BrowserProbeMarkers;
  /** Absent when no credential is landed on the surface. */
  readonly login?: BrowserProbeLogin;
}

/** The argument names the driver's schema gives one browser tool. */
function argumentNamesOf(discovery: McpDiscovery, tool: string): string[] | undefined {
  return discovery.toolArguments.find((entry) => entry.tool === tool)?.arguments;
}

/**
 * Call one driver tool for the probe, refusing a tool the floor does not
 * have or a call the driver refuses. The page answered before any of these
 * calls, so a refusal here is Day0 not completing the sign-in, never the
 * system being down. The driver's text is never quoted: after a credential is
 * typed it can echo the page.
 */
async function probeCall(
  client: BrowserProbeClient,
  discovery: McpDiscovery,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!discovery.toolAllowlist.includes(tool)) {
    throw new Day0ProbeLimitation(
      `Day0 browser component does not expose ${tool}, which signing in needs.`,
    );
  }
  const result = await client.callTool(tool, args);
  if (result.isError) {
    throw new Day0ProbeLimitation(
      `The browser driver refused ${tool} while Day0 was signing in, so the credential was not checked. This is not evidence that the system is unavailable.`,
    );
  }
  return result.text;
}

/** Take a snapshot and refuse it when the page has left the documented surface. */
async function probeSnapshot(
  client: BrowserProbeClient,
  discovery: McpDiscovery,
  endpoint: string,
): Promise<string> {
  const text = await probeCall(client, discovery, 'browser_snapshot', {});
  const page = browserPageUrl(text);
  if (!page) {
    throw new Day0ProbeLimitation(
      'The browser driver reported no page address while Day0 was signing in, so the credential was not checked.',
    );
  }
  if (!withinDocumentedSurface(page, endpoint)) {
    throw new Day0ProbeLimitation(
      `The sign-in left the approved surface (${endpoint}); Day0 signs in only on the documented page.`,
    );
  }
  return text;
}

/** Click one resolved control on the probe's page. */
async function probeClick(
  client: BrowserProbeClient,
  discovery: McpDiscovery,
  control: SnapshotElement,
): Promise<void> {
  await probeCall(
    client,
    discovery,
    'browser_click',
    withResolvedRefs(
      'browser_click',
      { element: control.name },
      [control],
      refFieldFor(argumentNamesOf(discovery, 'browser_click')),
    ),
  );
}

/**
 * Sign the probe's browser in on the page it has open, and return the
 * snapshot of the page the sign-in reached.
 *
 * The form is read by the names the apply types a credential into: the
 * account field takes the documented user name, the credential field takes
 * the credential, and the sign-in control submits it. A two-page login is
 * followed through its Next control. The credential is never typed anywhere
 * else, and nothing on the page is clicked but those two controls.
 */
async function signInForProbe(
  client: BrowserProbeClient,
  discovery: McpDiscovery,
  endpoint: string,
  login: BrowserProbeLogin,
): Promise<string> {
  const fill = async (fields: ReadonlyArray<[SnapshotElement, string]>): Promise<void> => {
    await probeCall(
      client,
      discovery,
      'browser_fill_form',
      withResolvedRefs(
        'browser_fill_form',
        { fields: fields.map(([element, value]) => ({ name: element.name, value })) },
        fields.map(([element]) => element),
        refFieldFor(argumentNamesOf(discovery, 'browser_fill_form')),
      ),
    );
  };
  const account = (form: LoginForm): Array<[SnapshotElement, string]> => {
    if (!form.account) return [];
    if (!login.username) {
      throw new Day0ProbeLimitation(
        'The sign-in page asks for a user name and the documentation gives none; write it beside the credential as (username `...`).',
      );
    }
    return [[form.account, login.username]];
  };
  let form = loginForm(await probeSnapshot(client, discovery, endpoint));
  if (!form.credential && form.account && form.next) {
    await fill(account(form));
    await probeClick(client, discovery, form.next);
    form = loginForm(await probeSnapshot(client, discovery, endpoint));
    form = { ...form, account: undefined };
  }
  if (!form.credential || !form.submit) {
    throw new BrowserSignInRefused(
      'The documented page shows no sign-in form Day0 can complete (a text box named for the password and a Sign in control), so the credential was not checked.',
    );
  }
  await fill([...account(form), [form.credential, login.credential]]);
  await probeClick(client, discovery, form.submit);
  return await probeSnapshot(client, discovery, endpoint);
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
 * When the documentation names an element the signed-in page shows, the
 * probe signs in with the credential and looks for it, so a rotated password
 * or a redesigned login leaves the surface unconnected instead of being found
 * by the first write. A page that documents only its title is checked by the
 * title, and says nothing about the credential.
 *
 * @param request - The page, the driver, the documented markers and the login.
 * @param makeClient - Client factory, replaceable by behavioural tests.
 * @returns Allowlisted browser tools and their provider-discovered argument names.
 * @throws Error when the driver is unreachable, exposes none of the floor's
 *   tools or cannot open the page; BrowserSignInRefused when the signed-in
 *   page does not show the documented element.
 */
export async function probeBrowserSurface(
  request: BrowserProbeRequest,
  makeClient: (url: URL) => BrowserProbeClient = createBrowserProbeClient,
): Promise<McpDiscovery> {
  const { endpoint, markers, login } = request;
  if (!endpoint) {
    throw new Day0ProbeLimitation('No web UI address is documented for this surface.');
  }
  const title = markers.title?.trim();
  const signedIn = markers.afterSignIn?.trim();
  if (!title && !signedIn) {
    throw new Day0ProbeLimitation(
      'No probe marker (a page title, or an element after sign-in) is documented for this browser surface, so Day0 cannot verify the page safely.',
    );
  }
  if (signedIn && !login?.credential) {
    throw new Day0ProbeLimitation(
      'The documentation names an element to check after sign-in, but no credential is landed for this surface, so Day0 cannot sign in.',
    );
  }
  let target: URL;
  try {
    target = new URL(endpoint);
  } catch {
    throw new Day0ProbeLimitation('The documented web UI address is not a valid URL.');
  }
  const component = browserComponent(request.driverUrl);
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
    if (title && browserPageTitle(opened.text) !== title) {
      throw new Day0ProbeLimitation(
        `The documented page answered, but its title did not match the approved marker (${title}).`,
      );
    }
    if (signedIn && login) {
      const page = await signInForProbe(client, discovery, endpoint, login);
      if (!pageShowsElement(page, signedIn)) {
        throw new BrowserSignInRefused(
          `Day0 signed in with the stored credential, but the page did not show the documented element "${signedIn}": the credential may have been rotated or the sign-in page changed.`,
        );
      }
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
 * Ask an MCP endpoint one question without the key, after a probe failed.
 *
 * The MCP client reports a failed connection as text: the HTTP status lives on
 * an error object it flattens, and a failure of both transports becomes one
 * fixed sentence. Handing the client a fetch of Day0's own to watch the real
 * exchange would switch it from validating every redirect hop before sending
 * to checking the final response afterwards, which is too much to give up on a
 * credential-bearing client. So the reason a manager reads is completed by a
 * separate request that carries no credential and follows no redirect, to the
 * hostname whose addresses were checked a moment ago.
 *
 * A healthy endpoint refuses such a request for want of a key. That is said in
 * words, never as its status, because the verdict reads those digits in a
 * reason as the provider refusing the key Day0 was given.
 *
 * Args:
 *   endpoint: The approved endpoint the probe just failed against.
 *   fetcher: HTTP implementation, replaceable by behavioural tests.
 *
 * Returns:
 *   One sentence for the reason.
 */
export async function inspectMcpEndpoint(endpoint: URL, fetcher: Fetcher = fetch): Promise<string> {
  try {
    const response = await fetcher(endpoint, {
      method: 'GET',
      headers: { Accept: 'application/json, text/event-stream' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch((): void => undefined);
    if (response.status >= 500) {
      return `A request without the key got HTTP ${response.status} from the endpoint.`;
    }
    return 'A request without the key was answered, so the endpoint is reachable.';
  } catch (error) {
    return `A request without the key failed too: ${transportErrorDetail(error)}.`;
  }
}

/** How much of the client's own message the reason keeps ahead of the endpoint check. */
const MCP_FAILURE_LEAD = 190;

/**
 * Shorten an MCP client failure so the endpoint check survives the reason's clip.
 *
 * A fronted provider's own failure arrives as a problem document whose `type`
 * URL alone outruns the clip; its `title` is the part a manager can read.
 *
 * Args:
 *   message: The client's flattened failure text.
 *
 * Returns:
 *   One line of at most `MCP_FAILURE_LEAD` characters and an ellipsis.
 */
function mcpFailureLead(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  const title = /"title"\s*:\s*"([^"]{1,120})"/.exec(text)?.[1];
  const body = text.indexOf('{');
  const line = title && body >= 0 ? `${text.slice(0, body)}${title}.` : text;
  return line.length > MCP_FAILURE_LEAD ? `${line.slice(0, MCP_FAILURE_LEAD)}...` : line;
}

/**
 * Approve the endpoint and check its addresses once, in the probe's terms.
 *
 * Day0's own boundary or resolver refusing is a limitation (`ungranted`); a
 * name that does not exist is a fact about the system and stays a plain error.
 */
async function probeAddress(
  endpoint: string | undefined,
  resolveHostname: HostResolver,
): Promise<CheckedMcpAddress> {
  try {
    return await checkMcpAddress(endpoint, resolveHostname);
  } catch (error) {
    if (error instanceof McpAddressRefusal) {
      throw error.limitation ? new Day0ProbeLimitation(error.message) : new Error(error.message);
    }
    throw error;
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
 *   inspectEndpoint: Uncredentialed endpoint check, replaceable by behavioural tests.
 *
 * Returns:
 *   Allowlisted names and provider-discovered argument names.
 */
export async function probeMcpSurface(
  endpoint: string | undefined,
  credential: string,
  makeClient: McpClientFactory = createMcpClient,
  resolveHostname: HostResolver = resolveMcpHostname,
  inspectEndpoint: EndpointInspector = inspectMcpEndpoint,
): Promise<McpDiscovery> {
  const checked = await probeAddress(endpoint, resolveHostname);
  const url = checked.url;
  const client = makeClient(checked, credential);
  try {
    // Discovery with errors first: `listTools()` returns an empty map for a
    // server that refused the bearer, which would read as "no tools" on the
    // card when the provider actually answered 401.
    const { definitions, errors } = await client
      .listToolDefinitionsWithErrors({ perServerTimeoutMs: 30_000 })
      .catch((error: unknown) => ({
        definitions: {} as Record<string, Record<string, ToolDefinition>>,
        errors: { surface: error instanceof Error ? error.message : String(error) },
      }));
    if (errors.surface) {
      // A refusal of the key is already the whole answer; anything else is
      // text with the status flattened out of it, so the endpoint is asked.
      if (ACCESS_REFUSAL.test(errors.surface)) throw new Error(errors.surface);
      throw new McpProbeFailure(
        `${mcpFailureLead(errors.surface)} ${await inspectEndpoint(url)}`,
        TRANSIENT_FAILURE.test(errors.surface),
      );
    }
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
  }).catch((error: unknown): never => {
    throw new Error(`Slack ${method} could not be reached: ${transportErrorDetail(error)}.`);
  });
  // A rate limit or a server error is a pace answer, whatever the body says,
  // and carries the wait Slack asked for.
  const transient = transientFromResponse(response, `Slack ${method}`);
  if (transient) throw transient;
  // A gateway answering for Slack sends HTML. Parsing it would replace the
  // status with a syntax error, and the status is what the reason needs.
  const payload = (await response.json().catch((): Record<string, unknown> => ({}))) as Record<
    string,
    unknown
  >;
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
    providerBotId: typeof auth.bot_id === 'string' && auth.bot_id ? auth.bot_id : undefined,
    providerWorkspaceId: typeof auth.team_id === 'string' ? auth.team_id : undefined,
  };
}

/**
 * Execute one generation-fenced provider probe.
 *
 * Args:
 *   ctx: Convex Node action context.
 *   surfaceId: Surface being verified.
 *
 * Returns:
 *   Safe connection outcome containing no credential or provider response body.
 *   A probe never moves the access end date (Q5).
 */
export async function runSurfaceProbe(
  ctx: ActionCtx,
  surfaceId: Id<'surfaces'>,
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

  const recordFailure = async (
    reason: string,
    verdict: 'ungranted' | 'listed-dead',
    attemptedAt: number,
  ): Promise<ProbeOutcome> => {
    const recorded: boolean | undefined = await ctx.runMutation(
      internal.surfaces.recordProbeFailure,
      { surfaceId, generation, verdict, reason, attemptedAt },
    );
    return recorded === false
      ? { verdict: 'skipped', reason: 'A newer surface probe superseded this result.' }
      : { verdict, reason };
  };

  /**
   * Record one failed route, descending the approved ladder when it is a route
   * that failed. A credential that was stored and can no longer be used is not
   * a route failure: it is the manager or IT withdrawing the authority this
   * surface was approved on, and the rollback the request itself offers. Moving
   * to a rung that needs no credential would leave the connection standing
   * after the credential that carried it was taken away, so an authority
   * withdrawal stops here and says so.
   */
  const failOrDemote = async (
    reason: string,
    verdict: 'ungranted' | 'listed-dead',
    descend = true,
  ): Promise<ProbeOutcome | undefined> => {
    const attemptedAt = dependencies.now();
    if (descend) {
      const demoted: { surface: Doc<'surfaces'>; generation: number } | null =
        await ctx.runMutation(internal.surfaces.demoteAfterProbeFailure, {
          surfaceId,
          generation,
          reason,
          attemptedAt,
        });
      if (demoted) {
        surface = demoted.surface;
        generation = demoted.generation;
        return undefined;
      }
    }
    return await recordFailure(reason, verdict, attemptedAt);
  };

  /**
   * Make one provider call, and once more if the first failure was transient.
   *
   * A single dropped connection used to reach `failOrDemote`, which writes
   * `listed-dead` or, on a row with a lower rung, abandons the better route for
   * good. The retry is recorded before the wait so the card and the trail show
   * it whichever way the second call goes.
   */
  const withOneRetry = async <T>(
    credential: string,
    known: readonly string[],
    call: () => Promise<T>,
  ): Promise<T> => {
    let first: unknown;
    try {
      return await call();
    } catch (error) {
      first = error;
    }
    const reason = safeProviderError(first, credential, known);
    if (!isTransientProbeFailure(first, reason)) throw first;
    // A rate limit is waited out for as long as the provider asks, within one
    // bounded backoff; a longer ask is not waited for inside the action.
    const asked = isRateLimited(first, reason) ? askedWait(first) : undefined;
    if (asked !== undefined && asked > PROVIDER_BACKOFF.maxWaitMs) {
      throw new ProbeRateLimited(reason, asked);
    }
    const wait = asked ?? PROBE_RETRY_WAIT_MS;
    const recorded: boolean = await ctx.runMutation(internal.surfaces.recordProbeRetry, {
      surfaceId,
      generation,
      reason,
      retryAfterMs: wait,
      attemptedAt: dependencies.now(),
    });
    if (!recorded) throw new ProbeSuperseded();
    await (dependencies.wait ?? waitRealTime)(wait);
    // The second call carries the key, so it is made only for a row that is
    // still this probe's and still approved.
    const current = await ctx.runQuery(internal.orientationData.surfaceForOrientation, {
      surfaceId,
    });
    if (
      current?.surface.probeGeneration !== generation ||
      !PROBEABLE_VERDICTS.includes(current.surface.verdict)
    ) {
      throw new ProbeSuperseded();
    }
    try {
      return await call();
    } catch (error) {
      const again = safeProviderError(error, credential, known);
      if (isRateLimited(error, again)) throw new ProbeRateLimited(again, askedWait(error));
      throw error;
    }
  };

  /**
   * Leave the verdict as it was after the provider rate-limited the probe, and
   * say when Day0 asks again. A connected or dead card is asked again by the
   * hourly sweep; any other card is not in the sweep, so one probe is
   * scheduled for when the provider said it could answer, within bounds.
   */
  const leaveRateLimited = async (limited: ProbeRateLimited): Promise<ProbeOutcome> => {
    const swept = surface.verdict === 'connected' || surface.verdict === 'listed-dead';
    const next = swept
      ? RATE_LIMITED_REPROBE_MS.max
      : Math.min(
          RATE_LIMITED_REPROBE_MS.max,
          Math.max(RATE_LIMITED_REPROBE_MS.min, limited.retryAfterMs ?? 0),
        );
    const recorded: boolean = await ctx.runMutation(internal.surfaces.recordProbeRetry, {
      surfaceId,
      generation,
      reason: limited.message,
      retryAfterMs: next,
      attemptedAt: dependencies.now(),
    });
    if (!recorded) {
      return { verdict: 'skipped', reason: 'A newer surface probe superseded this result.' };
    }
    if (!swept) {
      await ctx.scheduler.runAfter(next, internal.surfaceActions.probeInternal, { surfaceId });
    }
    return {
      verdict: 'skipped',
      reason: `The provider is limiting its rate (${limited.message}); the card keeps its verdict and Day0 probes again in ${Math.round(next / 60_000)} minutes.`,
    };
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
    let known: readonly string[] = [];
    try {
      if (context.agent.userId) known = await ownerKnownValues(ctx, context.agent.userId);
      if (surface.credentialId) {
        try {
          credential = await ctx.runAction(credentialInternal.credentials.decrypt, {
            credentialId: surface.credentialId,
          });
        } catch {
          return (
            (await failOrDemote('credential is unavailable or revoked', 'ungranted', false)) ?? {
              verdict: 'ungranted',
              reason: 'credential is unavailable or revoked',
            }
          );
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
        const discovery = await withOneRetry(credential, known, () =>
          dependencies.probeMcp(surface.endpoint, credential),
        );
        toolAllowlist = discovery.toolAllowlist;
        toolArguments = discovery.toolArguments;
      } else if (surface.path === 'browser-driven') {
        const pages: Doc<'docPages'>[] = await day0Step(
          'read the linked documentation',
          (): Promise<Doc<'docPages'>[]> =>
            ctx.runQuery(internal.orientationData.pagesForAgent, { agentId: surface.agentId }),
        );
        // Scoped to this surface's own documentation. Read across every page,
        // one marker would serve every browser-driven surface the agent has,
        // and the second such surface would be checked against the first's page
        // title - which matters now that a public web UI reaches this rung
        // without a login.
        const documentation = pages
          .map((page: Doc<'docPages'>): string =>
            relevantSystemText(page.markdown, surface.displayName, page.title),
          )
          .join('\n\n');
        const username = documentedUsername(documentation);
        const discovery = await withOneRetry(credential, known, () =>
          dependencies.probeBrowser({
            endpoint: surface.endpoint,
            driverUrl: process.env.DAY0_BROWSER_MCP_URL,
            markers: {
              title: browserTitleMarker(documentation),
              afterSignIn: browserSignedInMarker(documentation),
            },
            ...(credential ? { login: { credential, ...(username ? { username } : {}) } } : {}),
          }),
        );
        toolAllowlist = discovery.toolAllowlist;
        toolArguments = discovery.toolArguments;
      } else if (
        surface.path === 'documented-api' &&
        surface.class === 'chat' &&
        !isSlackApiEndpoint(surface.endpoint)
      ) {
        // Chat intake reads every documented-API chat surface through Slack's
        // Web API with the surface's key (`intakeActions.ts` `slackGet`), so
        // another chat system connected here would have its key sent to Slack.
        throw new Day0ProbeLimitation(
          `Day0 reads chat over a documented API only through Slack's Web API, so it does not connect ${surface.displayName} at ${surface.endpoint ?? 'an undocumented address'}. ` +
            `This is a limitation of this Day0 deployment, not evidence that ${surface.displayName} is unavailable. ` +
            'The approved endpoint remains on the card.',
        );
      } else if (surface.path === 'documented-api' && surface.class !== 'chat') {
        const pages: Doc<'docPages'>[] = await day0Step(
          'read the linked documentation',
          (): Promise<Doc<'docPages'>[]> =>
            ctx.runQuery(internal.orientationData.pagesForAgent, { agentId: surface.agentId }),
        );
        // Scoped to this surface's own pages, as the browser marker is: another
        // system's documented operations are not this one's to call.
        const documentation = pages
          .map((page: Doc<'docPages'>): string =>
            relevantSystemText(page.markdown, surface.displayName, page.title),
          )
          .join('\n\n');
        const probeApi = dependencies.probeApi ?? probeDocumentedApi;
        const discovery = await withOneRetry(credential, known, () =>
          probeApi(surface.endpoint, credential, documentation).catch((error: unknown) => {
            throw error instanceof DocumentedApiLimitation
              ? new Day0ProbeLimitation(error.message)
              : error;
          }),
        );
        toolAllowlist = discovery.toolAllowlist;
        toolArguments = discovery.toolArguments;
      } else if (surface.path === 'documented-api') {
        const pages: Doc<'docPages'>[] = await day0Step(
          'read the linked documentation',
          (): Promise<Doc<'docPages'>[]> =>
            ctx.runQuery(internal.orientationData.pagesForAgent, { agentId: surface.agentId }),
        );
        const slack = await withOneRetry(credential, known, () =>
          dependencies.probeSlack(
            credential,
            context.agent.bossEmail,
            pages.map((page: Doc<'docPages'>): string => page.markdown).join('\n\n'),
            undefined,
            // The channels this employee will read are the approved ones, so
            // those are the ones whose invite the card asks for.
            surface.intakeScope
              ? approvedChannelNames(surface.intakeScope)
              : documentedChannelNames(pages),
          ),
        );
        toolAllowlist = slack.toolAllowlist;
        channelsNotJoined = slack.channelsNotJoined;
        managerDmChannelId = slack.managerDmChannelId;
        managerUserId = slack.managerUserId;
        managerName = slack.managerName;
        providerIdentityId = slack.providerIdentityId;
        providerWorkspaceId = slack.providerWorkspaceId;
        // Before the connection is recorded, so the poll a fresh connection
        // schedules already knows which posts are the app's own.
        const botIdentityRecorded = await day0Step(
          'record the app identity',
          (): Promise<boolean> =>
            ctx.runMutation(internal.intakeIdentity.recordBotIdentity, {
              surfaceId,
              generation,
              providerBotId: slack.providerBotId,
            }),
        );
        if (!botIdentityRecorded) {
          return { verdict: 'skipped', reason: 'A newer surface probe superseded this result.' };
        }
      } else {
        throw new Day0ProbeLimitation(
          `Day0 has no probe for surface path ${surface.path ?? 'unknown'}. ` +
            `This is a limitation of this Day0 deployment, not evidence that ${surface.displayName} is unavailable.`,
        );
      }
      const verifiedAt = dependencies.now();
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
      if (error instanceof ProbeSuperseded) {
        return { verdict: 'skipped', reason: 'A newer surface probe superseded this result.' };
      }
      if (error instanceof ProbeRateLimited) return await leaveRateLimited(error);
      const reason = safeProviderError(error, credential, known);
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
    });
  },
});

/**
 * Internal approval and maintenance entry point for one isolated probe.
 *
 * `renewExpiry` is retired and ignored: a probe never moves the access end
 * date (Q5). It stays accepted until the Slack install
 * (`slackProvisionActions.ts`) stops passing it.
 */
export const probeInternal = internalAction({
  args: { surfaceId: v.id('surfaces'), renewExpiry: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<ProbeOutcome> => await runSurfaceProbe(ctx, args.surfaceId),
});

/**
 * Store a write-only credential landed by the owner and schedule its probe.
 *
 * The plaintext is passed directly to Lane A's encrypted store action and is
 * never returned or persisted on the surface.
 */
/** A Slack bot token: the only token the Slack rung posts with as the employee's app. */
const SLACK_BOT_TOKEN = /^xoxb-[A-Za-z0-9-]+$/;

/**
 * Why a credential typed into the card may not be stored, or undefined when
 * it may.
 *
 * Nothing is stored before the card is approved: a credential for a system
 * nobody has agreed the employee may reach is a secret held for no purpose.
 * On Slack only a bot token is taken; a user token passes Slack's own check
 * and then posts as that person, and an app-level token posts nothing.
 *
 * @param surface - The surface the card lands the credential on.
 * @param plaintext - The trimmed value typed into the card; never echoed.
 */
export function credentialLandingRefusal(
  surface: Pick<Doc<'surfaces'>, 'managerApprovedAt' | 'itApprovedAt' | 'endpoint'>,
  plaintext: string,
): string | undefined {
  if (surface.managerApprovedAt === undefined || surface.itApprovedAt === undefined) {
    return 'Approve the card before landing its credential; nothing was stored.';
  }
  if (isSlackApiEndpoint(surface.endpoint) && !SLACK_BOT_TOKEN.test(plaintext)) {
    return "Slack takes the app's bot token here, the one that begins xoxb-; a user token would post as that person. Nothing was stored.";
  }
  return undefined;
}

/**
 * Store a credential typed into an approved card, attach it to the surface
 * and probe it at once.
 *
 * Public, owner-guarded (`assertOwnsAgentAction`), real mode only. Writes one
 * `credentials` row (encrypted) and the surface's credential fields; refuses
 * with a `ConvexError`, storing nothing, before the card is approved or when
 * Slack is given anything but a bot token (`credentialLandingRefusal`).
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
    const refusal = credentialLandingRefusal(context.surface, plaintext);
    if (refusal) throw new ConvexError(refusal);
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
    // The card is approved (the refusal above), so the credential is probed at once.
    await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
      surfaceId: context.surface._id,
    });
    return { landed: true, probeScheduled: true };
  },
});

/**
 * End what has ended, give a week's notice of what is ending, and isolate
 * hourly re-probes by surface.
 *
 * Connected surfaces are re-verified; a surface the last probe left
 * `listed-dead` with its credential and approvals intact is retried, so a
 * transient provider failure does not stay dead until a human clicks Probe.
 * The re-probe neither extends nor ends access (Q5): the end date does.
 */
export const reprobeAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ expired: number; noticed: number; scheduled: number }> => {
    if (SURFACE_MODE === 'mock') return { expired: 0, noticed: 0, scheduled: 0 };
    const now = Date.now();
    const surfaces: Doc<'surfaces'>[] = await ctx.runQuery(
      internal.orientationData.reprobeCandidates,
      {},
    );
    let expired = 0;
    let noticed = 0;
    let scheduled = 0;
    for (const surface of surfaces) {
      if (surface.expiresAt !== undefined && surface.expiresAt <= now) {
        await ctx.runMutation(internal.surfaces.recordExpired, { surfaceId: surface._id, now });
        expired += 1;
        continue;
      }
      const notice: boolean = await ctx.runMutation(internal.surfaces.recordExpiryNotice, {
        surfaceId: surface._id,
        now,
      });
      if (notice) noticed += 1;
      await ctx.scheduler.runAfter(0, internal.surfaceActions.probeInternal, {
        surfaceId: surface._id,
      });
      scheduled += 1;
    }
    return { expired, noticed, scheduled };
  },
});

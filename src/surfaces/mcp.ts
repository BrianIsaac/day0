import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import { decryptCredential, type DecryptCredential } from './credentials';
import { clipEffect, READ_EFFECT_LENGTH } from './mock';
import {
  actionIntent,
  mcpEndpointRefusal,
  parseSurfaceAction,
  surfaceRefusal,
  TOOL_NOT_ALLOWED,
  type ParsedMcpCall,
} from './policy';
import { injectSecret, redactValue } from './secrets';
import { createSecretMcpClient } from './mcp-client';
import {
  browserComponent,
  BROWSER_DRIVER_ABSENT_REASON,
  elementDescriptions,
  isDriverUnreachable,
  navigationRefusal,
  navigationResultRefusal,
  needsElementRef,
  refFieldFor,
  resolveElementRef,
  withResolvedRefs,
  type SnapshotElement,
} from './browser';
import type {
  AdapterRun,
  AppliedAction,
  BeforeSurfaceTransport,
  SurfaceAdapter,
  SurfaceRecord,
} from './types';

export const MCP_TOOLS = ['mcp.call'] as const satisfies readonly MockAction['tool'][];
export const MCP_TIMEOUT_MS = 30_000;
export const EFFECT_LENGTH = 180;

/** Keep the two human-checkable results from a long accessibility snapshot. */
export function browserSnapshotEvidence(text: string): string | undefined {
  const figure = text.match(/\b\d{1,3}(?:\.\d+)?%/)?.[0];
  const audit = text.match(/\bLast updated by[^\r\n`]{1,120}?\bUTC\b/i)?.[0];
  if (!figure && !audit) return undefined;
  return [figure ? `visible figure ${figure}` : undefined, audit]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** The subset of an MCP tool handle the adapter calls. */
export interface McpToolLike {
  execute?(args: unknown, context: unknown): Promise<unknown>;
}

/** The subset of an MCP client the adapter uses, so tests can supply one. */
export interface McpClientLike {
  listTools(): Promise<Record<string, McpToolLike>>;
  disconnect(): Promise<void>;
}

export interface McpClientOptions {
  /** The surface slug; Mastra namespaces tool names as `<serverName>_<tool>`. */
  serverName: string;
  url: URL;
  bearer?: string;
}

export type CreateMcpClient = (options: McpClientOptions) => McpClientLike;

export interface McpAdapterDeps {
  decrypt: DecryptCredential;
  createClient: CreateMcpClient;
  now: () => number;
  beforeTransport?: BeforeSurfaceTransport;
  /** The browser driver's address; only the browser floor uses it. */
  browserMcpUrl?: string;
}

/**
 * Replace `{{secret}}` placeholders anywhere in an MCP tool's arguments.
 *
 * `http.request` has always substituted the surface's credential into headers
 * and bodies. An MCP tool needs the same rule for the same reason: on the
 * browser floor the credential is typed into a form field, so it travels as a
 * tool argument rather than a header, and a skill must be able to name it
 * without ever holding it. `injectSecret` refuses a placeholder naming another
 * surface, so an action cannot borrow a credential it is not the target of.
 *
 * Args:
 *   value: A tool-argument tree as the skill supplied it.
 *   secret: The decrypted credential for the action's target surface.
 *   slug: That surface's slug, for the qualified placeholder form.
 *
 * Returns:
 *   The same tree with every placeholder resolved.
 */
export function injectSecretsDeep(value: unknown, secret: string, slug: string): unknown {
  if (typeof value === 'string') return injectSecret(value, secret, slug);
  if (Array.isArray(value)) {
    return value.map((entry: unknown): unknown => injectSecretsDeep(entry, secret, slug));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, entry]: [string, unknown]): [string, unknown] => [
          key,
          injectSecretsDeep(entry, secret, slug),
        ],
      ),
    );
  }
  return value;
}

/** What the adapter reads out of a tool result, whichever shape the server used. */
export interface InterpretedToolResult {
  isError: boolean;
  text: string;
  providerId?: string;
}

/**
 * Build a Streamable HTTP client for one surface.
 *
 * Mastra must throw tool errors: its return mode drops `isError` whenever a
 * server also returns structured content. Its default logger is disabled so
 * a provider response cannot log a reflected credential before redaction.
 *
 * Args:
 *   options: Server name, endpoint and bearer credential.
 *
 * Returns:
 *   A connected-on-demand Mastra MCP client.
 */
export function createMastraMcpClient(options: McpClientOptions): McpClientLike {
  const client = createSecretMcpClient({
    id: `day0-${options.serverName}-${globalThis.crypto.randomUUID()}`,
    servers: {
      [options.serverName]: {
        url: options.url,
        allowedHosts: [options.url.host],
        ...(options.bearer
          ? { requestInit: { headers: { Authorization: `Bearer ${options.bearer}` } } }
          : {}),
      },
    },
    timeout: MCP_TIMEOUT_MS,
  });
  return {
    listTools: async (): Promise<Record<string, McpToolLike>> => {
      const { tools, errors } = await client.listToolsWithErrors({
        perServerTimeoutMs: MCP_TIMEOUT_MS,
      });
      const error = errors[options.serverName];
      if (error) throw new Error(error);
      return tools;
    },
    disconnect: async (): Promise<void> => await client.disconnect(),
  };
}

function firstStringDeep(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (depth > 2 || typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  for (const nested of Object.values(record)) {
    const found = firstStringDeep(nested, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Read the first text block, the error flag and any provider id from a result.
 *
 * Servers answer with a `CallToolResult` (`content[]`, `isError`) or, through
 * Mastra, with the structured content alone. A provider id is looked for in
 * structured content first, then in the text when it parses as JSON, then as
 * an `id` pair inside the text.
 *
 * Args:
 *   result: Whatever the tool's `execute` resolved with.
 *
 * Returns:
 *   The interpreted result.
 */
export function interpretToolResult(result: unknown): InterpretedToolResult {
  const idKeys = ['id', 'identifier', 'commentId', 'issueId'];
  if (typeof result === 'string') {
    return { isError: false, text: result, providerId: providerIdFromText(result, idKeys) };
  }
  if (typeof result !== 'object' || result === null) {
    return { isError: false, text: result === undefined ? '' : String(result) };
  }
  const record = result as {
    content?: unknown;
    isError?: unknown;
    structuredContent?: unknown;
  };
  const blocks = Array.isArray(record.content) ? record.content : undefined;
  if (blocks) {
    const textBlock = blocks.find(
      (block): block is { type: string; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    );
    const text = textBlock?.text ?? '';
    const providerId =
      firstStringDeep(record.structuredContent, idKeys) ?? providerIdFromText(text, idKeys);
    return { isError: record.isError === true, text, providerId };
  }
  const text = JSON.stringify(result);
  return { isError: false, text, providerId: firstStringDeep(result, idKeys) };
}

function providerIdFromText(text: string, idKeys: readonly string[]): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return firstStringDeep(JSON.parse(trimmed), idKeys);
    } catch {
      // Not JSON after all; fall through to the pattern.
    }
  }
  const match = /\b(?:id|identifier)["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9_-]{3,})/i.exec(text);
  return match?.[1];
}

/** Adapter for `mcp.call` against a connected Streamable HTTP MCP surface. */
export class McpAdapter implements SurfaceAdapter {
  readonly tools = MCP_TOOLS;

  /**
   * Args:
   *   surfaces: The agent's surfaces.
   *   deps: Credential decryption, the client factory and a clock.
   */
  constructor(
    private readonly surfaces: readonly SurfaceRecord[],
    private readonly deps: McpAdapterDeps = {
      decrypt: decryptCredential,
      createClient: createMastraMcpClient,
      now: (): number => Date.now(),
    },
  ) {}

  /**
   * Real surfaces contribute nothing to the mock snapshot.
   *
   * Args:
   *   ctx: Convex action context, unused.
   *   agentId: Agent, unused.
   *
   * Returns:
   *   An empty fragment.
   */
  async read(ctx: ActionCtx, agentId: Id<'agents'>): Promise<Partial<MockSurfaceSnapshot>> {
    void ctx;
    void agentId;
    return {};
  }

  /**
   * Call one allowlisted tool on a connected surface.
   *
   * Args:
   *   ctx: Convex action context.
   *   run: Work execution identity.
   *   action: The `mcp.call` action after the registry's rules ran.
   *   index: Position in the run, unused beyond the key.
   *   idempotencyKey: Ledger key for this action.
   *
   * Returns:
   *   The ledger row: `ok` iff the server did not flag an error.
   */
  /**
   * One live browser per run, keyed by run and surface.
   *
   * The driver runs `--isolated`, so every MCP session gets its own browser
   * context - which is what an audited action set should mean, and also means a
   * session per action would throw away the page after every step. A person
   * signing in and then pressing Save does both in one tab; so does this. The
   * session is closed when the run's actions are done.
   */
  private readonly browserSessions = new Map<string, McpClientLike>();

  /**
   * Close every browser this adapter opened for the run.
   *
   * Called by the registry once the run's actions have been applied, in a
   * `finally`, so a browser is never left holding a signed-in page after the
   * run that opened it has ended.
   */
  async close(): Promise<void> {
    const open = [...this.browserSessions.values()];
    this.browserSessions.clear();
    await Promise.all(
      open.map(async (client: McpClientLike): Promise<void> => {
        try {
          await client.disconnect();
        } catch {
          // A driver that has already dropped the session is closed enough.
        }
      }),
    );
  }

  /**
   * Turn the element descriptions in one action into refs the driver accepts.
   *
   * A fresh snapshot is taken for every such action rather than once per run,
   * because the page changes underneath: the ref for "Save" after signing in is
   * not the ref for anything on the sign-in form.
   *
   * Args:
   *   client: The run's live browser session.
   *   slug: The surface slug, for the namespaced tool name.
   *   toolName: The browser tool being called.
   *   toolArgs: Its arguments, secrets already injected.
   *
   * Returns:
   *   The arguments with refs filled in, or why an element could not be found.
   */
  private async resolveRefs(
    client: McpClientLike,
    slug: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    argumentNames: readonly string[] | undefined,
  ): Promise<{ toolArgs: Record<string, unknown> } | { reason: string }> {
    const descriptions = elementDescriptions(toolName, toolArgs);
    if (descriptions.length === 0) {
      return { reason: `${toolName} names no element to act on` };
    }
    const snapshotTool = (await client.listTools())[`${slug}_browser_snapshot`];
    if (!snapshotTool?.execute) {
      return { reason: 'the browser driver does not expose browser_snapshot' };
    }
    const snapshot = interpretToolResult(await snapshotTool.execute({}, {}));
    const refs: SnapshotElement[] = [];
    for (const description of descriptions) {
      const found = resolveElementRef(snapshot.text, description);
      if (!found) {
        return {
          reason: `the page has no element called "${description}" (${
            snapshot.text
              .match(/"[^"]+"/g)
              ?.slice(0, 8)
              .join(', ') || 'nothing named on the page'
          })`,
        };
      }
      refs.push(found);
    }
    return {
      toolArgs: withResolvedRefs(toolName, toolArgs, refs, refFieldFor(argumentNames)),
    };
  }

  async apply(
    ctx: ActionCtx,
    run: AdapterRun,
    action: MockAction,
    index: number,
    idempotencyKey: string,
  ): Promise<AppliedAction> {
    void index;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || parsed.action.kind !== 'mcp.call') {
      return {
        tool: action.tool,
        ok: false,
        reason: parsed.ok ? 'not an mcp.call' : parsed.reason,
        idempotencyKey,
      };
    }
    const call: ParsedMcpCall = parsed.action;
    const surface = this.surfaces.find((row) => row.slug === call.surface);
    const refusal = surfaceRefusal(surface, this.deps.now());
    if (!surface || refusal)
      return { tool: action.tool, ok: false, reason: refusal, idempotencyKey };
    if (surface.path !== 'mcp' && surface.path !== 'browser-driven') {
      return {
        tool: action.tool,
        ok: false,
        reason: `mcp.call is not allowed on surface path ${surface.path ?? 'unknown'}`,
        idempotencyKey,
      };
    }
    if (!surface.toolAllowlist?.includes(call.tool)) {
      return {
        tool: action.tool,
        ok: false,
        reason: `${TOOL_NOT_ALLOWED} (${call.tool})`,
        idempotencyKey,
      };
    }
    // On the browser floor the transport and the target are different
    // addresses: the endpoint on the row is the system's own page, which is
    // where the browser is allowed to go, while the driver is Day0's own
    // service. Everywhere else the endpoint is both.
    const browserDriven = surface.path === 'browser-driven';
    let url: URL;
    if (browserDriven) {
      try {
        // The driver is an optional component. A deployment that never started
        // it refuses the row with the code, which is a complete answer rather
        // than a failure to configure something.
        const component = browserComponent(this.deps.browserMcpUrl);
        if (!component.present) {
          return { tool: action.tool, ok: false, reason: component.reason, idempotencyKey };
        }
        url = component.url;
      } catch (error) {
        return {
          tool: action.tool,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          idempotencyKey,
        };
      }
    } else {
      const endpointRefusal = mcpEndpointRefusal(surface);
      if (endpointRefusal) {
        return { tool: action.tool, ok: false, reason: endpointRefusal, idempotencyKey };
      }
      url = new URL(surface.endpoint ?? '');
    }
    if (browserDriven) {
      const outside = navigationRefusal(call.tool, call.toolArgs, surface.endpoint);
      if (outside) return { tool: action.tool, ok: false, reason: outside, idempotencyKey };
    }
    if (!surface.credentialId && !browserDriven) {
      return { tool: action.tool, ok: false, reason: 'surface has no credential', idempotencyKey };
    }
    let bearer = '';
    let writeAttempted = false;
    try {
      if (surface.credentialId) bearer = await this.deps.decrypt(ctx, surface.credentialId);
      const authorityRefusal = await this.deps.beforeTransport?.(action, surface);
      if (authorityRefusal) {
        return { tool: action.tool, ok: false, reason: authorityRefusal, idempotencyKey };
      }
      // A browser driver is not the system, so it is never handed the system's
      // credential as a bearer. The credential reaches the page the way a
      // person's would, typed into its own form field.
      const sessionKey = `${run.workItemId}:${run.runId}:${surface.slug}`;
      const existing = browserDriven ? this.browserSessions.get(sessionKey) : undefined;
      const client =
        existing ??
        this.deps.createClient({
          serverName: surface.slug,
          url,
          ...(bearer && !browserDriven ? { bearer } : {}),
        });
      if (browserDriven && !existing) this.browserSessions.set(sessionKey, client);
      try {
        const tools = await client.listTools();
        const tool = tools[`${surface.slug}_${call.tool}`];
        if (!tool?.execute) {
          return {
            tool: action.tool,
            ok: false,
            reason: `tool ${call.tool} is not exposed by the server`,
            idempotencyKey,
          };
        }
        writeAttempted = actionIntent(call) === 'write';
        let toolArgs = bearer
          ? (injectSecretsDeep(call.toolArgs, bearer, surface.slug) as Record<string, unknown>)
          : call.toolArgs;
        if (browserDriven && needsElementRef(call.tool)) {
          const resolved = await this.resolveRefs(
            client,
            surface.slug,
            call.tool,
            toolArgs,
            surface.toolArguments?.find(
              (entry: { arguments: string[]; tool: string }): boolean => entry.tool === call.tool,
            )?.arguments,
          );
          if ('reason' in resolved) {
            return {
              tool: action.tool,
              ok: false,
              reason: clipEffect(redactValue(resolved.reason, bearer), EFFECT_LENGTH),
              idempotencyKey,
            };
          }
          toolArgs = resolved.toolArgs;
        }
        const finalAuthorityRefusal = await this.deps.beforeTransport?.(action, surface);
        if (finalAuthorityRefusal) {
          return { tool: action.tool, ok: false, reason: finalAuthorityRefusal, idempotencyKey };
        }
        const result = interpretToolResult(await tool.execute(toolArgs, {}));
        const text = redactValue(result.text, bearer);
        if (result.isError) {
          return {
            tool: action.tool,
            ok: false,
            reason: clipEffect(text || 'the server reported an error', EFFECT_LENGTH),
            idempotencyKey,
          };
        }
        if (browserDriven) {
          const landedOutside = navigationResultRefusal(call.tool, result.text, surface.endpoint);
          if (landedOutside) {
            return { tool: action.tool, ok: false, reason: landedOutside, idempotencyKey };
          }
        }
        const evidence =
          browserDriven && call.tool === 'browser_snapshot'
            ? browserSnapshotEvidence(text)
            : undefined;
        return {
          tool: action.tool,
          ok: true,
          effect: clipEffect(
            `${call.tool} on ${surface.slug} · ${(evidence ?? text) || 'ok'}`,
            writeAttempted ? EFFECT_LENGTH : READ_EFFECT_LENGTH,
          ),
          providerId: result.providerId
            ? clipEffect(redactValue(result.providerId, bearer), EFFECT_LENGTH)
            : undefined,
          idempotencyKey,
        };
      } finally {
        // A browser session belongs to the run, not to this one action.
        if (!browserDriven) await client.disconnect();
      }
    } catch (error) {
      // A driver that was configured and has since stopped reads as the same
      // absence as one that was never configured, and says so with the same
      // code rather than with a transport error nobody can act on.
      const reason =
        browserDriven && isDriverUnreachable(error)
          ? BROWSER_DRIVER_ABSENT_REASON
          : clipEffect(
              redactValue(error instanceof Error ? error.message : String(error), bearer),
              EFFECT_LENGTH,
            );
      return {
        tool: action.tool,
        ok: false,
        reason,
        ...(writeAttempted ? { outcomeUnknown: true } : {}),
        idempotencyKey,
      };
    }
  }
}

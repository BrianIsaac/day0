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
  type ActionIntent,
  type ParsedMcpCall,
} from './policy';
import { redactOutcome } from './redact';
import { redactValue } from './secrets';
import type { SpanModel } from '../redaction/client';
import type { MCPClient } from '@mastra/mcp';
import { createSecretMcpClient } from './mcp-client';
import { log } from '../lib/logger';
import {
  checkMcpAddress,
  pinnedFetch,
  type PinnedFetch,
  resolveHostname,
  type HostResolver,
  type HttpsRequest,
} from './mcp-address';
import {
  browserComponent,
  browserPageUrl,
  carriesSecretPlaceholder,
  BROWSER_DRIVER_ABSENT_REASON,
  elementDescriptions,
  isDriverUnreachable,
  navigationRefusal,
  navigationResultRefusal,
  needsElementRef,
  refFieldFor,
  resolveElementRef,
  secretPlacementRefusal,
  unknownPlaceholderRefusal,
  withResolvedRefs,
  withSecretTyped,
  withinDocumentedSurface,
  type SnapshotElement,
} from './browser';
import type {
  ActedElement,
  ActionAuthority,
  AdapterRun,
  AppliedAction,
  BeforeSurfaceTransport,
  SessionRecipeStep,
  SessionRestoreResult,
  SessionRestoreStep,
  SurfaceAdapter,
  SurfaceRecord,
} from './types';

/** The one verb the MCP adapter serves. */
export const MCP_TOOLS = ['mcp.call'] as const satisfies readonly MockAction['tool'][];

/** How long one MCP tool call may take. */
export const MCP_TIMEOUT_MS = 30_000;
/** How much of a write's result the ledger keeps as its effect line. */
export const EFFECT_LENGTH = 180;
/** The most of one acted element's name the ledger keeps. */
const ELEMENT_NAME_LENGTH = 120;

/**
 * The most of one tool result the adapter redacts. The ledger keeps at most
 * `READ_EFFECT_LENGTH` of it, and a page or a provider decides how long the
 * result is, so the rest is never sent to the redactor.
 */
export const MCP_RESULT_TEXT_LIMIT = 64 * 1024;

/**
 * A tool result's text cut to `MCP_RESULT_TEXT_LIMIT`, with the credential and
 * every known value removed exactly before the cut, so the cut cannot split
 * one and leave a prefix no exact match would find.
 */
function boundedResultText(text: string, removals: readonly string[]): string {
  if (text.length <= MCP_RESULT_TEXT_LIMIT) return text;
  return removals
    .reduce((scrubbed: string, value: string): string => redactValue(scrubbed, value), text)
    .slice(0, MCP_RESULT_TEXT_LIMIT);
}

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
  /** Run one write so the client cannot send its tool call twice (`sendOnceFence`). */
  sendOnce?<T>(call: () => Promise<T>): Promise<T>;
}

/** Why a second send of one write was refused; the first may have landed. */
export const RESEND_REFUSAL =
  'the connection dropped after the write was sent and Day0 refused to send it a second time; the first send may have landed';

/** A fetch that lets one tool call through per fenced send, and the fence. */
export interface SendOnceFence {
  readonly fetch: PinnedFetch;
  sendOnce<T>(call: () => Promise<T>): Promise<T>;
}

/** Whether a request body is a JSON-RPC `tools/call`, alone or in a batch. */
function isToolCallBody(body: RequestInit['body']): boolean {
  return typeof body === 'string' && /"method"\s*:\s*"tools\/call"/.test(body);
}

/**
 * Fence a client's transport so a write is sent at most once.
 *
 * The Mastra MCP client reconnects after a transport error it deems
 * recoverable ("fetch failed", "connection closed", an HTTP 4xx, a session
 * error) and calls the tool again, returning only the second result (P5-5).
 * For a comment or a Save whose response was cut after the request went out,
 * that is a second write on a row marked landed. Inside `sendOnce` the second
 * `tools/call` is refused before it leaves, so the client's retry fails and
 * the row is recorded as outcome-unknown. Listing tools and reconnecting are
 * unaffected, and a read is never fenced.
 *
 * @param base - The transport the client would otherwise use.
 */
export function sendOnceFence(base: PinnedFetch): SendOnceFence {
  let fenced = false;
  let sent = 0;
  return {
    fetch: async (input: string | URL, init?: RequestInit): Promise<Response> => {
      if (fenced && isToolCallBody(init?.body)) {
        sent += 1;
        if (sent > 1) throw new Error(RESEND_REFUSAL);
      }
      return await base(input, init);
    },
    sendOnce: async <T>(call: () => Promise<T>): Promise<T> => {
      fenced = true;
      sent = 0;
      try {
        return await call();
      } finally {
        fenced = false;
      }
    },
  };
}

/**
 * Whether a thrown error is the server's own answer rather than a lost one.
 *
 * The client runs with `onToolError: 'throw'`, so a result the server marked
 * `isError` arrives as this error, after the server answered: the call was
 * refused, and nothing about its outcome is unknown (P5-4).
 */
export function isServerToolError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { id?: unknown }).id === 'MCP_CLIENT_TOOL_EXECUTION_FAILED'
  );
}

/** The code Linear's MCP answers with when Linear itself did not answer it (the walk's m1). */
const PROVIDER_UNAVAILABLE_CODE = 'upstream_unavailable';

/**
 * Whether a server's refusal is its answer that the provider behind it is unavailable, with a
 * request to try again: Linear's MCP `{"error":"upstream_unavailable","message":"Linear is
 * temporarily unavailable. Please try again.","status":502}`, as a real workspace answered an
 * approved `save_comment` on 1 October (the real-Linear walk's m1). The server answered, so the
 * call never reached the provider; every other refusal stays a refusal.
 */
export function isProviderUnavailableAnswer(error: unknown): boolean {
  if (!isServerToolError(error) || !(error instanceof Error)) return false;
  let body: unknown;
  try {
    body = JSON.parse(error.message);
  } catch {
    // Not a JSON body, so not this answer: the refusal stands.
    return false;
  }
  if (typeof body !== 'object' || body === null) return false;
  const { error: code, status } = body as { readonly error?: unknown; readonly status?: unknown };
  return code === PROVIDER_UNAVAILABLE_CODE && status === 502;
}

/**
 * Send an approved write, and send it once more when the server answered that the provider behind
 * it is unavailable (`isProviderUnavailableAnswer`). The second answer is the write's, whatever it
 * is: there is never a third send, and every other failure is the first send's.
 *
 * @param send - One fenced send of the write (`sendOnce`), so neither send is ever doubled by the
 *   client's own reconnect.
 * @param where - The surface and tool, for the log line.
 */
async function sendWriteResendingOnce(
  send: () => Promise<unknown>,
  where: { readonly surface: string; readonly tool: string },
): Promise<unknown> {
  try {
    return await send();
  } catch (error) {
    if (!isProviderUnavailableAnswer(error)) throw error;
  }
  log.warn('mcp write resent once: the provider was unavailable', where);
  return await send();
}

/** What creating an MCP client takes: the server name, its endpoint and the credential. */
export interface McpClientOptions {
  /** The surface slug; Mastra namespaces tool names as `<serverName>_<tool>`. */
  serverName: string;
  url: URL;
  bearer?: string;
}

/** The factory the adapter builds MCP clients with, so a test can hand it a double. */
export type CreateMcpClient = (options: McpClientOptions) => McpClientLike;

/** What the MCP adapter depends on: the decrypt and the client factory. */
export interface McpAdapterDeps {
  decrypt: DecryptCredential;
  createClient: CreateMcpClient;
  now: () => number;
  beforeTransport?: BeforeSurfaceTransport;
  /** The browser driver's address; only the browser floor uses it. */
  browserMcpUrl?: string;
  /** The span model outcomes are redacted with; undefined degrades to the structural floor. */
  spanModel?: SpanModel;
  /** Every value the owner stores, resolved once by the hosting action; removed exactly from every outcome. */
  knownValues?: readonly string[];
}

/**
 * Why an MCP call naming `{{secret}}` is refused. An MCP server receives the
 * surface's credential as its bearer, so no argument ever needs it; one that
 * asks for it is either a confused skill or a ticket steering the agent into
 * posting its own credential.
 */
export const MCP_SECRET_ARGUMENT_REFUSAL =
  'an MCP server receives the credential as its bearer, so {{secret}} in a tool argument is never substituted and the call was not sent';

/** What the adapter reads out of a tool result, whichever shape the server used. */
export interface InterpretedToolResult {
  isError: boolean;
  text: string;
  providerId?: string;
  /** The provider's own message when the failure was reported in the result body. */
  errorMessage?: string;
}

/**
 * Whether a `validationErrors` field carries a failure.
 *
 * A server that reports validation on every response answers a good call
 * with an empty list or object; only a populated value names a failure.
 *
 * Args:
 *   value: The field's value.
 *
 * Returns:
 *   True when at least one validation error is reported.
 */
function hasValidationErrors(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Read a failure a server reported inside the result body rather than through
 * the protocol's `isError` flag.
 *
 * Linear's MCP answers an argument validation failure as a JSON object with
 * `error: true` and a `message`, flag unset; other servers put a top-level
 * `validationErrors` list in the body. Either is a failure. A string-valued
 * `error` field is data (an error category on a record, say) and is left alone.
 *
 * Args:
 *   text: The first text block of the result, or the serialised body.
 *
 * Returns:
 *   The provider's message, or undefined when the body reports no failure.
 */
export function providerErrorMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const flagged = record.error === true;
  const validation = hasValidationErrors(record.validationErrors);
  if (!flagged && !validation) return undefined;
  for (const key of ['message', 'detail', 'reason']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  if (validation) return `validation failed: ${JSON.stringify(record.validationErrors)}`;
  return 'the server reported an error';
}

/** How a credential-bearing client checks and reaches its server; a test supplies its own. */
export interface McpConnection {
  readonly resolveHostname: HostResolver;
  readonly request?: HttpsRequest;
}

/**
 * Build a Streamable HTTP client for one surface.
 *
 * Mastra must throw tool errors: its return mode drops `isError` whenever a
 * server also returns structured content. Its default logger is disabled so
 * a provider response cannot log a reflected credential before redaction.
 *
 * A client that carries a bearer resolves the endpoint's hostname once, before
 * its first request, refuses it unless every answer is public, and then dials
 * only those answers: the probe's check holds for every connection a write or
 * a manager message makes, not only for the probe. A client with no bearer is
 * Day0's own browser driver on the compose network and is not checked.
 *
 * Args:
 *   options: Server name, endpoint and bearer credential.
 *   connection: The resolver and transport a bearer client uses.
 *
 * Returns:
 *   A connected-on-demand Mastra MCP client.
 */
export function createMastraMcpClient(
  options: McpClientOptions,
  connection: McpConnection = { resolveHostname },
): McpClientLike {
  let created: Promise<MCPClient> | undefined;
  let fence: SendOnceFence | undefined;
  const create = async (): Promise<MCPClient> => {
    const pinned = options.bearer
      ? pinnedFetch(
          await checkMcpAddress(options.url, connection.resolveHostname),
          connection.request,
        )
      : undefined;
    // The plain fetch is read at call time, not captured, so the global in
    // force when the request is made is the one that makes it.
    fence = sendOnceFence(
      pinned ?? (async (input: string | URL, init?: RequestInit) => await fetch(input, init)),
    );
    return createSecretMcpClient({
      id: `day0-${options.serverName}-${globalThis.crypto.randomUUID()}`,
      servers: {
        [options.serverName]: {
          url: options.url,
          allowedHosts: [options.url.host],
          fetch: fence.fetch,
          ...(options.bearer
            ? { requestInit: { headers: { Authorization: `Bearer ${options.bearer}` } } }
            : {}),
        },
      },
      timeout: MCP_TIMEOUT_MS,
    });
  };
  const client = (): Promise<MCPClient> => (created ??= create());
  return {
    listTools: async (): Promise<Record<string, McpToolLike>> => {
      const { tools, errors } = await (
        await client()
      ).listToolsWithErrors({
        perServerTimeoutMs: MCP_TIMEOUT_MS,
      });
      const error = errors[options.serverName];
      if (error) throw new Error(error);
      return tools;
    },
    disconnect: async (): Promise<void> => {
      if (!created) return;
      // A client whose address check refused it never connected, so there is nothing to close.
      const connected = await created.catch((): undefined => undefined);
      await connected?.disconnect();
    },
    sendOnce: async <T>(call: () => Promise<T>): Promise<T> => {
      await client();
      return fence ? await fence.sendOnce(call) : await call();
    },
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
    return withBodyError({
      isError: false,
      text: result,
      providerId: providerIdFromText(result, idKeys),
    });
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
    const textBlocks = blocks.filter(
      (block): block is { type: string; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    );
    const text = textBlocks[0]?.text ?? '';
    const errorMessage =
      providerErrorMessage(JSON.stringify(record.structuredContent) ?? '') ??
      textBlocks
        .map((block) => providerErrorMessage(block.text))
        .find((message) => message !== undefined);
    const providerId =
      firstStringDeep(record.structuredContent, idKeys) ?? providerIdFromText(text, idKeys);
    return withBodyError({
      isError: record.isError === true || errorMessage !== undefined,
      text,
      providerId,
      errorMessage,
    });
  }
  const text = JSON.stringify(result);
  const errorMessage = providerErrorMessage(JSON.stringify(record.structuredContent) ?? '');
  return withBodyError({
    isError: record.isError === true || errorMessage !== undefined,
    text,
    providerId: firstStringDeep(result, idKeys),
    errorMessage,
  });
}

/** Mark a result whose body reports a failure the flag did not. */
function withBodyError(interpreted: InterpretedToolResult): InterpretedToolResult {
  if (interpreted.isError) return interpreted;
  const errorMessage = providerErrorMessage(interpreted.text);
  if (errorMessage === undefined) return interpreted;
  return { ...interpreted, isError: true, errorMessage };
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
   * One live browser per run and surface for the life of this adapter.
   *
   * The driver runs `--isolated`, so every MCP session gets its own browser
   * context - which is what an audited action set should mean, and also means a
   * session per action would throw away the page after every step. A person
   * signing in and then pressing Save does both in one tab; so does this.
   *
   * The adapter lives for one apply invocation, and a run's phases are
   * separate invocations, so the session is closed when this invocation's
   * actions are done. The next invocation's first action on the surface finds
   * a new, blank browser, which the registry signs in again first through
   * `restoreSession`.
   */
  private readonly browserSessions = new Map<string, McpClientLike>();

  /**
   * Close every browser this adapter opened for the invocation.
   *
   * Called by the registry once the invocation's actions have been applied, in
   * a `finally`, so a browser is never left holding a signed-in page after the
   * invocation that opened it has ended.
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
   * The elements a browser call is about to act on, as the ledger names them:
   * each accessible name with the credential and the owner's stored values
   * removed, since a name is page content and can quote anything on the page.
   *
   * @param refs - The elements resolution picked, in the action's order.
   * @param bearer - The surface's credential, removed wherever it appears.
   * @returns The elements, and the redaction flag when the span model was not consulted.
   */
  private async actedElements(
    refs: readonly SnapshotElement[],
    bearer: string,
  ): Promise<{ elements?: ActedElement[]; redaction?: 'structural-only' }> {
    if (refs.length === 0) return {};
    // One redaction call for every name: a snapshot line never holds a line
    // break, and a redacted span never adds one, so the names split back apart.
    const redacted = await redactOutcome(
      refs.map((element: SnapshotElement): string => element.name).join('\n'),
      bearer,
      this.deps.spanModel,
      this.deps.knownValues,
    );
    const names = redacted.text.split('\n');
    return {
      elements: refs.map(
        (element: SnapshotElement, index: number): ActedElement => ({
          ref: element.ref,
          name: clipEffect(names[index] ?? '', ELEMENT_NAME_LENGTH),
          role: element.role,
        }),
      ),
      ...(redacted.redaction ? { redaction: redacted.redaction } : {}),
    };
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
   *   toolArgs: Its arguments, placeholders not yet substituted.
   *   argumentNames: The driver's argument names for the tool, which name the ref field.
   *   intent: Whether the call reads or writes; a write resolves only to a control.
   *   pageBound: When set, the documented address the current page must be within.
   *
   * Returns:
   *   The arguments with refs filled in and the elements they name, or why an
   *   element could not be found or the page is not the surface's.
   */
  private async resolveRefs(
    client: McpClientLike,
    slug: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    argumentNames: readonly string[] | undefined,
    intent: ActionIntent,
    pageBound?: string,
  ): Promise<{ toolArgs: Record<string, unknown>; refs: SnapshotElement[] } | { reason: string }> {
    const descriptions = elementDescriptions(toolName, toolArgs);
    if (descriptions.length === 0) {
      return { reason: `${toolName} names no element to act on` };
    }
    const snapshotTool = (await client.listTools())[`${slug}_browser_snapshot`];
    if (!snapshotTool?.execute) {
      return { reason: 'the browser driver does not expose browser_snapshot' };
    }
    const snapshot = interpretToolResult(await snapshotTool.execute({}, {}));
    if (snapshot.isError) return { reason: 'browser_snapshot failed before element resolution' };
    if (pageBound) {
      const page = browserPageUrl(snapshot.text);
      if (!page) return { reason: 'the browser driver reported no current page URL' };
      if (!withinDocumentedSurface(page, pageBound)) {
        return { reason: `the page is outside the approved surface (${pageBound})` };
      }
    }
    const refs: SnapshotElement[] = [];
    for (const description of descriptions) {
      const found = resolveElementRef(snapshot.text, description, intent);
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
      refs,
    };
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
  async apply(
    ctx: ActionCtx,
    run: AdapterRun,
    action: MockAction,
    index: number,
    idempotencyKey: string,
    transportAuthority?: ActionAuthority,
  ): Promise<AppliedAction> {
    void index;
    return await this.send(
      ctx,
      run,
      action,
      idempotencyKey,
      transportAuthority ? { authority: transportAuthority } : undefined,
    );
  }

  /**
   * Sign the run's browser for a surface in again, in this invocation's
   * session, by replaying the run's own landed rows.
   *
   * Each step goes through exactly the path `apply` does - the surface and
   * allowlist checks, the navigation bound, the credential typed from its
   * placeholder, element resolution against a fresh snapshot, and the
   * transport check before and after resolution - with the check run under
   * the replayed row's own authority. The first step that does not land stops
   * the replay: nothing further is typed into a page that is not the one the
   * run left.
   *
   * Args:
   *   ctx: Convex action context.
   *   run: Work execution identity; its browser for the surface is the one used.
   *   surface: The browser-driven surface.
   *   recipe: The calls to replay, from `sessionRecipe`.
   *   baseKey: The key of the row that needs the page; step n is `<baseKey>.session-<n>`.
   *
   * Returns:
   *   Every step attempted, and why the replay stopped if it did.
   */
  async restoreSession(
    ctx: ActionCtx,
    run: AdapterRun,
    surface: SurfaceRecord,
    recipe: readonly SessionRecipeStep[],
    baseKey: string,
  ): Promise<SessionRestoreResult> {
    const steps: SessionRestoreStep[] = [];
    for (const [n, step] of recipe.entries()) {
      const parsed = parseSurfaceAction(step.action);
      const onSurface =
        parsed.ok && parsed.action.kind === 'mcp.call' && parsed.action.surface === surface.slug;
      const outcome = onSurface
        ? await this.send(ctx, run, step.action, `${baseKey}.session-${n}`, {
            authority: step.authority,
          })
        : {
            tool: step.action.tool,
            ok: false,
            reason: `a replayed call must target ${surface.slug}`,
            idempotencyKey: `${baseKey}.session-${n}`,
          };
      const landed = outcome.ok && outcome.held !== true;
      steps.push({
        ...outcome,
        ...(landed && step.authority ? { authority: step.authority } : {}),
        ...(step.replayOf ? { replayOf: step.replayOf } : {}),
        action: step.action,
      });
      if (!landed) {
        const tool =
          parsed.ok && parsed.action.kind === 'mcp.call' ? parsed.action.tool : step.action.tool;
        return {
          ok: false,
          steps,
          reason: `browser session could not be re-established: ${tool} ${outcome.reason ?? 'the call did not land'}`,
        };
      }
    }
    return { ok: true, steps };
  }

  /** The transport check, told the replayed authority only when the call is a replay. */
  private async transportRefusal(
    action: MockAction,
    surface: SurfaceRecord,
    replay: { authority?: ActionAuthority } | undefined,
  ): Promise<string | undefined> {
    const check = this.deps.beforeTransport;
    if (!check) return undefined;
    return replay ? await check(action, surface, replay) : await check(action, surface);
  }

  /**
   * Send one `mcp.call`, on the run's browser for a browser-driven surface.
   *
   * Args:
   *   ctx: Convex action context.
   *   run: Work execution identity.
   *   action: The `mcp.call` action.
   *   idempotencyKey: Ledger key for the row.
   *   replay: Set for a replayed browser call: the authority its row landed under.
   *
   * Returns:
   *   The ledger row.
   */
  private async send(
    ctx: ActionCtx,
    run: AdapterRun,
    action: MockAction,
    idempotencyKey: string,
    replay?: { authority?: ActionAuthority },
  ): Promise<AppliedAction> {
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
    const unfilled = unknownPlaceholderRefusal(call.toolArgs);
    if (unfilled) return { tool: action.tool, ok: false, reason: unfilled, idempotencyKey };
    const carriesSecret = carriesSecretPlaceholder(call.toolArgs);
    if (carriesSecret) {
      const refusal = !browserDriven
        ? MCP_SECRET_ARGUMENT_REFUSAL
        : !surface.credentialId
          ? 'the surface has no credential to type'
          : !surface.endpoint
            ? 'the surface has no documented address to check the page against'
            : secretPlacementRefusal(call.tool, call.toolArgs, surface.slug);
      if (refusal) return { tool: action.tool, ok: false, reason: refusal, idempotencyKey };
    }
    if (!surface.credentialId && !browserDriven) {
      return { tool: action.tool, ok: false, reason: 'surface has no credential', idempotencyKey };
    }
    let bearer = '';
    let writeAttempted = false;
    try {
      if (surface.credentialId) bearer = await this.deps.decrypt(ctx, surface.credentialId);
      const authorityRefusal = await this.transportRefusal(action, surface, replay);
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
        let toolArgs = call.toolArgs;
        let resolvedElements: readonly SnapshotElement[] = [];
        if (browserDriven && needsElementRef(call.tool)) {
          const resolved = await this.resolveRefs(
            client,
            surface.slug,
            call.tool,
            toolArgs,
            surface.toolArguments?.find(
              (entry: { arguments: string[]; tool: string }): boolean => entry.tool === call.tool,
            )?.arguments,
            actionIntent(call),
            // The page is checked before any action that carries the
            // credential, on every run: a click or a script can have moved
            // the browser since the last navigation was checked.
            replay || carriesSecret ? surface.endpoint : undefined,
          );
          if ('reason' in resolved) {
            const redacted = await redactOutcome(
              resolved.reason,
              bearer,
              this.deps.spanModel,
              this.deps.knownValues,
            );
            return {
              tool: action.tool,
              ok: false,
              reason: clipEffect(redacted.text, EFFECT_LENGTH),
              ...(redacted.redaction ? { redaction: redacted.redaction } : {}),
              idempotencyKey,
            };
          }
          toolArgs = resolved.toolArgs;
          resolvedElements = resolved.refs;
          if (carriesSecret) {
            const misplaced = secretPlacementRefusal(
              call.tool,
              toolArgs,
              surface.slug,
              resolved.refs,
            );
            if (misplaced) {
              return { tool: action.tool, ok: false, reason: misplaced, idempotencyKey };
            }
            toolArgs = withSecretTyped(call.tool, toolArgs, resolved.refs, bearer, surface.slug);
          }
        }
        const finalAuthorityRefusal = await this.transportRefusal(action, surface, replay);
        if (finalAuthorityRefusal) {
          return { tool: action.tool, ok: false, reason: finalAuthorityRefusal, idempotencyKey };
        }
        // Named on every row for a call that was sent to the resolved elements.
        const actedOn = await this.actedElements(resolvedElements, bearer);
        const send = async (): Promise<unknown> => await tool.execute?.(toolArgs, {});
        const sendFenced = async (): Promise<unknown> =>
          client.sendOnce ? await client.sendOnce(send) : await send();
        const result = interpretToolResult(
          writeAttempted
            ? await sendWriteResendingOnce(sendFenced, { surface: surface.slug, tool: call.tool })
            : await send(),
        );
        const removals = [bearer, ...(this.deps.knownValues ?? [])];
        const redacted = await redactOutcome(
          boundedResultText(result.text, removals),
          bearer,
          this.deps.spanModel,
          this.deps.knownValues,
        );
        const text = redacted.text;
        const redaction = redacted.redaction ? { redaction: redacted.redaction } : {};
        if (result.isError) {
          const errorResult = result.errorMessage
            ? await redactOutcome(
                boundedResultText(result.errorMessage, removals),
                bearer,
                this.deps.spanModel,
                this.deps.knownValues,
              )
            : redacted;
          const reason = errorResult.text;
          return {
            tool: action.tool,
            ok: false,
            reason: clipEffect(reason || 'the server reported an error', EFFECT_LENGTH),
            ...actedOn,
            ...redaction,
            ...(errorResult.redaction ? { redaction: errorResult.redaction } : {}),
            idempotencyKey,
          };
        }
        if (browserDriven) {
          const landedOutside = navigationResultRefusal(call.tool, result.text, surface.endpoint);
          if (landedOutside) {
            return { tool: action.tool, ok: false, reason: landedOutside, idempotencyKey };
          }
          // Every click is followed to the page it left the browser on, not
          // only a replayed one: a first-run click can navigate too (P6-16).
          if (call.tool === 'browser_click') {
            // The click was sent: a page check that cannot run says nothing
            // about whether it landed, so a Retry must not click it again.
            const unknownOutcome = {
              ...actedOn,
              ...(writeAttempted ? { outcomeUnknown: true } : {}),
            };
            let page = browserPageUrl(result.text);
            if (!page) {
              const snapshotTool = (await client.listTools())[`${surface.slug}_browser_snapshot`];
              if (!snapshotTool?.execute) {
                return {
                  tool: action.tool,
                  ok: false,
                  reason: 'the browser driver does not expose browser_snapshot',
                  ...unknownOutcome,
                  idempotencyKey,
                };
              }
              let snapshot: InterpretedToolResult | undefined;
              try {
                snapshot = interpretToolResult(await snapshotTool.execute({}, {}));
              } catch (error) {
                // The driver refusing the snapshot answers the snapshot, not
                // the click; any other error reaches the catch below, which
                // keeps the outcome unknown itself.
                if (!isServerToolError(error)) throw error;
              }
              if (!snapshot || snapshot.isError) {
                return {
                  tool: action.tool,
                  ok: false,
                  reason: 'browser_snapshot failed after the click',
                  ...unknownOutcome,
                  idempotencyKey,
                };
              }
              page = browserPageUrl(snapshot.text);
            }
            if (!page) {
              return {
                tool: action.tool,
                ok: false,
                reason: 'the browser driver reported no final page URL',
                ...unknownOutcome,
                idempotencyKey,
              };
            }
            if (!surface.endpoint || !withinDocumentedSurface(page, surface.endpoint)) {
              return {
                tool: action.tool,
                ok: false,
                reason: `the page is outside the approved surface (${surface.endpoint ?? 'no documented address'})`,
                // The click was sent and did something; whether it landed a
                // change before the page left is not known.
                ...unknownOutcome,
                idempotencyKey,
              };
            }
          }
        }
        const evidence =
          browserDriven && call.tool === 'browser_snapshot'
            ? browserSnapshotEvidence(text)
            : undefined;
        const identifier = result.providerId
          ? await redactOutcome(
              result.providerId,
              bearer,
              this.deps.spanModel,
              this.deps.knownValues,
            )
          : undefined;
        return {
          tool: action.tool,
          ok: true,
          effect: clipEffect(
            `${call.tool} on ${surface.slug} · ${(evidence ?? text) || 'ok'}`,
            writeAttempted ? EFFECT_LENGTH : READ_EFFECT_LENGTH,
          ),
          providerId: identifier ? clipEffect(identifier.text, EFFECT_LENGTH) : undefined,
          ...actedOn,
          ...redaction,
          ...(identifier?.redaction ? { redaction: identifier.redaction } : {}),
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
      const failure =
        browserDriven && isDriverUnreachable(error)
          ? undefined
          : await redactOutcome(
              error instanceof Error ? error.message : String(error),
              bearer,
              this.deps.spanModel,
              this.deps.knownValues,
            );
      const reason = failure
        ? clipEffect(failure.text, EFFECT_LENGTH)
        : BROWSER_DRIVER_ABSENT_REASON;
      return {
        tool: action.tool,
        ok: false,
        reason,
        ...(writeAttempted && !isServerToolError(error) ? { outcomeUnknown: true } : {}),
        ...(failure?.redaction ? { redaction: failure.redaction } : {}),
        idempotencyKey,
      };
    }
  }
}

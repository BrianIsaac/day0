import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import type { DecryptCredential } from './credentials';
import { transientFromResponse } from '../lib/transport-error';
import { checkMcpAddress, McpAddressRefusal, pinnedFetch } from './mcp-address';
import { clipEffect, READ_EFFECT_LENGTH } from './mock';
import {
  actionIntent,
  allowlistEntry,
  canonicalOperation,
  documentedRpcRead,
  operationRefusal,
  operationUnderBase,
  parseSurfaceAction,
  resolveRequestUrl,
  surfaceRefusal,
  type HttpMethod,
  type ParsedHttpRequest,
} from './policy';
import {
  hasPlaceholder,
  httpSecretPlacementRefusal,
  injectSecret,
  SecretTemplateError,
} from './secrets';
import { redactOutcome } from './redact';
import type { SpanModel } from '../redaction/client';
import { isSlackApiEndpoint, slackApiBaseUrl } from './slack-endpoint';
import type {
  ActionAuthority,
  AdapterRun,
  AppliedAction,
  BeforeSurfaceTransport,
  SurfaceAdapter,
  SurfaceRecord,
} from './types';
import { errorMessage } from '../lib/errors';

/** The one verb the documented-API adapter serves. */
export const HTTP_TOOLS = ['http.request'] as const satisfies readonly MockAction['tool'][];
/** How long one documented-API request may take. */
export const HTTP_TIMEOUT_MS = 20_000;
/** How much of a response the ledger keeps as a write's effect line. */
export const EFFECT_LENGTH = 180;
const RESPONSE_READ_LIMIT = 64 * 1024;

/** The transport the adapter sends through, so a test can hand it a double. */
export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/** What the documented-API adapter depends on: the token store's read and the two transports. */
export interface HttpAdapterDeps {
  /**
   * The card's live access token from the token store (`accessTokenFor` in
   * `token-store.ts`, refreshed first when due), the one value the rung puts in
   * the documented header. The rung never reads a refresh token, so there is no
   * default: a plain decrypt would send a Nango-held row's pointer, or a token
   * past its expiry.
   */
  decrypt: DecryptCredential;
  /** The transport to Slack's fixed Web API base, which the code names and no page can move. */
  fetch: FetchLike;
  /**
   * How a documented API's base address is checked and reached on every
   * request, as the probe reached it; `connectCheckedApi` unless a test
   * replaces it.
   */
  connect?: ApiConnector;
  now: () => number;
  beforeTransport?: BeforeSurfaceTransport;
  /** The span model outcomes are redacted with; undefined degrades to the structural floor. */
  spanModel?: SpanModel;
  /** Every value the owner stores, resolved once by the hosting action; removed exactly from every outcome. */
  knownValues?: readonly string[];
}

/**
 * Resolve a runbook path against the surface endpoint without leaving it.
 *
 * `path` is relative to the endpoint, so `/chat.postMessage` against
 * `https://slack.com/api/` is `https://slack.com/api/chat.postMessage`. A
 * path that resolves to another origin, or above the endpoint's own path, is
 * refused: the credential injected below must only ever reach the host the
 * documentation named.
 *
 * Args:
 *   endpoint: The surface's documented API base.
 *   path: The action's path.
 *
 * Returns:
 *   The absolute target URL.
 *
 * Raises:
 *   Error: If the endpoint is not a URL or the path escapes it.
 */
export { resolveRequestUrl };

const CONTENT_TYPE = 'Content-Type';
/** The content type a JSON body goes with when its action names none. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Whether the headers already name a content type, in any case. */
function namesContentType(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === CONTENT_TYPE.toLowerCase());
}

/**
 * Whether a body the action sends is a JSON object or array. Without a content type `fetch` sends
 * a string body as `text/plain`, which Slack refuses with `invalid_arguments` (the first walk's
 * row 19), so a JSON body is labelled JSON when its action names no type of its own.
 */
function isJsonText(body: string): boolean {
  const text = body.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    // Not JSON after all: the body goes as the action wrote it.
    return false;
  }
}

/**
 * Move a documented RPC read's body parameters into the query.
 *
 * Slack's read methods take their parameters from the query string or a form
 * body and do not read a JSON one, and a GET's body is never sent at all, so a
 * read whose parameters the model wrote in a body, as JSON or as a form, lands
 * with none of them and is answered `channel_not_found`. The
 * adapter, not the model, puts them where the provider reads them: a parameter
 * already in the query stands, an empty one is skipped, a list is
 * comma-joined as Slack's `types` is, and `conversations.replies` takes the
 * `thread_ts` a model tends to write as the `ts` Slack asks for. The
 * credential never goes in a URL, so a placeholder among them is refused and
 * a `token` argument is left behind.
 *
 * Args:
 *   request: The parsed request.
 *   url: The resolved request URL, mutated in place.
 *
 * Returns:
 *   True when the body was moved and must not be sent.
 *
 * Raises:
 *   SecretTemplateError: If a parameter carries a placeholder.
 */
function moveReadBodyIntoQuery(request: ParsedHttpRequest, url: URL): boolean {
  const method = documentedRpcRead(request);
  if (method === undefined || request.body === undefined || request.body.trim() === '')
    return false;
  const given: Array<[string, unknown]> = request.bodyJson
    ? Object.entries(request.bodyJson)
    : [...new URLSearchParams(request.body.trim())];
  for (const [name, value] of given) {
    if (value === null || value === undefined || url.searchParams.has(name)) continue;
    // Slack still reads a `token` argument; the bearer header is the only place one goes.
    if (name.toLowerCase() === 'token') continue;
    const text = Array.isArray(value)
      ? value.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(',')
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
    if (text === '') continue;
    if (hasPlaceholder(name) || hasPlaceholder(text)) {
      throw new SecretTemplateError("secret placeholders are not allowed in a read's parameters");
    }
    url.searchParams.set(name, text);
  }
  const threadTs = url.searchParams.get('thread_ts');
  if (method === 'conversations.replies' && threadTs !== null && !url.searchParams.has('ts')) {
    url.searchParams.set('ts', threadTs);
  }
  return true;
}

/**
 * Read at most the response evidence limit without treating truncation as JSON.
 *
 * Args:
 *   response: Provider response to read.
 *
 * Returns:
 *   Decoded evidence and whether the provider exceeded the limit.
 */
async function readBoundedResponse(
  response: Response,
): Promise<{ text: string; exceeded: boolean }> {
  if (!response.body) return { text: '', exceeded: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      parts.push(decoder.decode());
      return { text: parts.join(''), exceeded: false };
    }
    const remaining = RESPONSE_READ_LIMIT - bytesRead;
    if (value.byteLength > remaining) {
      if (remaining > 0) parts.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
      await reader.cancel('response evidence limit reached');
      parts.push(decoder.decode());
      return { text: parts.join(''), exceeded: true };
    }
    bytesRead += value.byteLength;
    parts.push(decoder.decode(value, { stream: true }));
  }
}

/**
 * Pick the provider's identifier for what a request created.
 *
 * Args:
 *   payload: The parsed JSON response, if any.
 *
 * Returns:
 *   `ts`, `id` or `message.ts`, whichever the response carries first.
 */
export function providerIdFrom(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as { ts?: unknown; id?: unknown; message?: { ts?: unknown } };
  for (const candidate of [record.ts, record.id, record.message?.ts]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    if (typeof candidate === 'number') return String(candidate);
  }
  return undefined;
}

/** A verb and path the documentation gives for one operation, as `` `GET /issues` ``. */
const DOCUMENTED_OPERATION = /`\s*(GET|HEAD|POST|PUT|PATCH|DELETE)\s+([^\s`]+)\s*`/g;

/** The read a page names for the probe: `` Probe read: `GET /me` ``. */
const DOCUMENTED_PROBE_READ = /\bProbe read:\s*`\s*GET\s+([^\s`]+)\s*`/gi;

/**
 * A header the documentation shows the credential in: `` `X-Api-Key: {{secret}}` ``,
 * `` `Authorization: Token {{secret}}` `` or, without the placeholder,
 * `` `Authorization: Bearer` ``.
 */
const DOCUMENTED_CREDENTIAL_HEADER =
  /`\s*([A-Za-z0-9-]+)\s*:\s*(?:([A-Za-z]+)\s*)?(\{\{\s*secret\s*\}\})?\s*`/g;

/** One operation a surface's documentation names on its API. */
export interface DocumentedApiOperation {
  readonly method: HttpMethod;
  /** The path under the documented base, as the HTTP rung and the gate compare it with the allowlist. */
  readonly operation: string;
}

/** Where a documented API takes its credential. */
export interface CredentialHeader {
  readonly name: string;
  /** The word before the credential in the header value, such as `Bearer`; absent when the value is the credential alone. */
  readonly scheme?: string;
}

/** A documented API's checked base address and the fetch that reaches only it. */
export interface CheckedApi {
  readonly url: URL;
  readonly fetch: FetchLike;
}

/** Check a documented API's base address and return the one way to reach it. */
export type ApiConnector = (endpoint: string) => Promise<CheckedApi>;

/** What a documented-API probe found: the operations the rung may call on the surface. */
export interface DocumentedApiDiscovery {
  readonly toolAllowlist: string[];
  readonly toolArguments: Array<{ tool: string; arguments: string[] }>;
}

/**
 * A documented-API probe that stopped for want of something Day0 needs, not
 * because the system failed: no documented address, operation or read, or an
 * address Day0's boundary refuses.
 */
export class DocumentedApiLimitation extends Error {}

/**
 * The path of one documented address under the API's base, or undefined when
 * the address is on another host, above the base, or not an address at all.
 */
function operationUnder(base: URL, written: string): string | undefined {
  let target: URL;
  try {
    target = /^https?:\/\//i.test(written)
      ? new URL(written)
      : resolveRequestUrl(base.href, written);
  } catch {
    // Not an address under this API, so not one of its operations.
    return undefined;
  }
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return undefined;
  return target.pathname.slice(base.pathname.length).replace(/^\/+/, '');
}

/** The documented base as the operations are read under it, or undefined when it is not a URL. */
function documentedBase(endpoint: string): URL | undefined {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    // An endpoint that is not a URL names no operation; the probe says so.
    return undefined;
  }
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  return base;
}

/**
 * Read the operations a surface's documentation names on its API.
 *
 * An operation is a backticked verb and path, written relative to the
 * documented base (`` `GET /issues` ``) or as an address under it. A segment
 * that stands for a value (`{id}`, `:id` or `<id>`) is kept as `{id}` and
 * matches any one segment of a request, so `GET /issues/{id}` admits
 * `GET /issues/ENG-12` and nothing longer. The query is not part of an
 * operation.
 *
 * @param documentation - The surface's own documentation.
 * @param endpoint - The documented API base the surface was approved with.
 * @returns Each documented operation once, in the order the page gives them.
 */
export function documentedApiOperations(
  documentation: string,
  endpoint: string,
): DocumentedApiOperation[] {
  const base = documentedBase(endpoint);
  if (!base) return [];
  const found = new Map<string, DocumentedApiOperation>();
  for (const match of documentation.matchAll(DOCUMENTED_OPERATION)) {
    const written = match[2].split(/[?#]/, 1)[0];
    const operation = operationUnder(base, written);
    if (!operation) continue;
    const method = match[1] as HttpMethod;
    const entry = { method, operation: canonicalOperation(operation) };
    const key = allowlistEntry(entry.method, entry.operation);
    if (!found.has(key)) found.set(key, entry);
  }
  return [...found.values()];
}

/**
 * Read the one request the page names for checking the credential:
 * `` Probe read: `GET /me` ``.
 *
 * Only a line written for the purpose is taken: a documented `GET` is not a
 * read because its words miss a list of mutation verbs (`GET /auth/logout`
 * reads as one and signs the key out), so the page's author names the read,
 * and a page that names none is not guessed at. The read must be a plain
 * path under the base with no value segment, and the gate must class it a
 * read as well; the first line that is both is the one used.
 *
 * @param documentation - The surface's own documentation.
 * @param endpoint - The documented API base the surface was approved with.
 * @returns The probe's read, or undefined when the page names none it may send.
 */
export function documentedProbeRead(
  documentation: string,
  endpoint: string,
): DocumentedApiOperation | undefined {
  const base = documentedBase(endpoint);
  if (!base) return undefined;
  for (const match of documentation.matchAll(DOCUMENTED_PROBE_READ)) {
    const operation = operationUnder(base, match[1].split(/[?#]/, 1)[0]);
    if (!operation || canonicalOperation(operation).includes('{')) continue;
    const request: ParsedHttpRequest = {
      kind: 'http.request',
      surface: '',
      method: 'GET',
      path: operation,
      headers: {},
    };
    if (actionIntent(request) === 'read') return { method: 'GET', operation };
  }
  return undefined;
}

/**
 * Read the header a documented API takes its credential in. What it carries is
 * the token store's live access token for the card, never a refresh token.
 *
 * @param documentation - The surface's own documentation.
 * @returns The first header the page shows carrying `{{secret}}`, or an
 *   `Authorization` header with a scheme; a bearer token when it shows neither.
 */
export function documentedCredentialHeader(documentation: string): CredentialHeader {
  for (const match of documentation.matchAll(DOCUMENTED_CREDENTIAL_HEADER)) {
    const [, name, scheme, placeholder] = match;
    if (placeholder === undefined && (name.toLowerCase() !== 'authorization' || !scheme)) continue;
    return scheme ? { name, scheme } : { name };
  }
  return { name: 'Authorization', scheme: 'Bearer' };
}

/**
 * Check a documented API's base address the way a credential-bearing MCP
 * client's is checked, and reach it only through the addresses checked.
 *
 * @param endpoint - The documented API base the surface was approved with.
 * @returns The checked base and a fetch pinned to it.
 * @throws DocumentedApiLimitation when Day0's boundary refuses the address.
 */
export async function connectCheckedApi(endpoint: string): Promise<CheckedApi> {
  try {
    const checked = await checkMcpAddress(endpoint);
    return { url: checked.url, fetch: pinnedFetch(checked) };
  } catch (error) {
    if (!(error instanceof McpAddressRefusal)) throw error;
    // The address rules are the MCP client's; only the noun on the card differs.
    const message = error.message.replace(/\bMCP\b/g, 'API');
    throw error.limitation ? new DocumentedApiLimitation(message) : new Error(message);
  }
}

/**
 * Verify a documented API that is not Slack: check the credential with one
 * documented read and admit every operation the documentation names, each
 * with its verb.
 *
 * The read is the one the page names for the probe (`documentedProbeRead`),
 * so checking the credential never changes anything on the system. It is sent
 * with the credential in the documented header, follows no redirect, and a
 * 2xx answer without an `ok: false` envelope connects the surface. A 429 or a
 * 5xx is a `TransientProviderError` carrying the wait the answer asked for,
 * so the probe tries again rather than marking the system dead.
 *
 * @param endpoint - The documented API base the surface was approved with.
 * @param credential - The surface's decrypted credential.
 * @param documentation - The surface's own documentation, scoped to it.
 * @param connect - How the base address is checked and reached.
 * @returns The documented operations, as the surface's allowlist.
 * @throws DocumentedApiLimitation when the page gives Day0 nothing to check or
 *   call, or its address is refused; Error when the system answers otherwise.
 */
export async function probeDocumentedApi(
  endpoint: string | undefined,
  credential: string,
  documentation: string,
  connect: ApiConnector = connectCheckedApi,
): Promise<DocumentedApiDiscovery> {
  if (!endpoint)
    throw new DocumentedApiLimitation('No API base address is documented for this surface.');
  const operations = documentedApiOperations(documentation, endpoint);
  if (operations.length === 0) {
    throw new DocumentedApiLimitation(
      `The documentation names no operation on ${endpoint} in the form \`GET /path\`, so Day0 has nothing it may call there. This is not evidence that the system is unavailable.`,
    );
  }
  const read = documentedProbeRead(documentation, endpoint);
  if (!read) {
    throw new DocumentedApiLimitation(
      `The documentation names no read for Day0 to check the credential with on ${endpoint} (a line \`Probe read: GET /path\`), so Day0 does not guess one that could change something. This is not evidence that the system is unavailable.`,
    );
  }
  const api = await connect(endpoint);
  const header = documentedCredentialHeader(documentation);
  const label = `GET ${read.operation}`;
  let response: Response;
  try {
    response = await api.fetch(resolveRequestUrl(api.url.href, read.operation), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        [header.name]: header.scheme ? `${header.scheme} ${credential}` : credential,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const transient = transientFromResponse(response, label);
  if (transient) {
    await response.body?.cancel();
    throw transient;
  }
  const bounded = await readBoundedResponse(response);
  if (!response.ok) {
    const redirect = response.status >= 300 && response.status < 400;
    throw new Error(
      `${label} answered HTTP ${response.status}${redirect ? ', a redirect Day0 does not follow with a credential' : ''}.`,
    );
  }
  let payload: unknown;
  try {
    payload = bounded.exceeded ? undefined : JSON.parse(bounded.text);
  } catch {
    // A body that is not JSON carries no envelope; the 2xx is the answer.
    payload = undefined;
  }
  const envelope = payload as { ok?: unknown; error?: unknown } | undefined;
  if (envelope?.ok === false) {
    const detail = typeof envelope.error === 'string' ? ` (${envelope.error})` : '';
    throw new Error(`${label} answered ok: false${detail}.`);
  }
  return {
    toolAllowlist: operations.map((entry: DocumentedApiOperation): string =>
      allowlistEntry(entry.method, entry.operation),
    ),
    toolArguments: [],
  };
}

/** The start of an HTML document, after any leading whitespace. */
const HTML_DOCUMENT = /^\s*(?:<!doctype\s+html\b|<html\b)/i;

/**
 * Whether a response is an HTML page rather than an API's answer: by its
 * declared type, or by a body that opens an HTML document whatever the type
 * says.
 */
function isHtmlPage(response: Response, body: string): boolean {
  const type = response.headers.get('content-type') ?? '';
  return /^\s*text\/html\b/i.test(type) || HTML_DOCUMENT.test(body);
}

/** Adapter for `http.request` against a documented HTTP API surface. */
export class HttpAdapter implements SurfaceAdapter {
  readonly tools = HTTP_TOOLS;

  /**
   * Args:
   *   surfaces: The agent's surfaces.
   *   deps: The token store's read, the fetch implementation and a clock.
   */
  constructor(
    private readonly surfaces: readonly SurfaceRecord[],
    private readonly deps: HttpAdapterDeps,
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
   * The fetch one request goes out on. Slack's base is fixed by the code, so
   * it is reached directly; any other documented API's base is resolved,
   * checked and pinned on every request, as the probe checked it, so a name
   * that resolved to a permitted address at the probe cannot be re-pointed
   * at a private or metadata address before a write.
   *
   * @throws DocumentedApiLimitation or Error when the address is refused.
   */
  private async transportFor(
    surface: SurfaceRecord,
    transportEndpoint: string,
  ): Promise<FetchLike> {
    if (isSlackApiEndpoint(surface.endpoint)) return this.deps.fetch;
    const checked = await (this.deps.connect ?? connectCheckedApi)(transportEndpoint);
    return checked.fetch;
  }

  /**
   * Send one request to a connected surface with its credential injected.
   *
   * The request headers are never written to the ledger; the effect is the
   * status and the first 180 characters of the response with the credential
   * value removed.
   *
   * Args:
   *   ctx: Convex action context.
   *   run: Work execution identity.
   *   action: The `http.request` action after the registry's rules ran.
   *   index: Position in the run, unused beyond the key.
   *   idempotencyKey: Ledger key for this action.
   *
   * Returns:
   *   The ledger row: `ok` iff the response is 2xx and any `ok` envelope is true.
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
    void run;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || parsed.action.kind !== 'http.request') {
      return {
        tool: action.tool,
        ok: false,
        reason: parsed.ok ? 'not an http.request' : parsed.reason,
        idempotencyKey,
      };
    }
    const request: ParsedHttpRequest = parsed.action;
    const surface = this.surfaces.find((row) => row.slug === request.surface);
    const refusal = surfaceRefusal(surface, this.deps.now());
    if (!surface || refusal)
      return { tool: action.tool, ok: false, reason: refusal, idempotencyKey };
    if (surface.path !== 'documented-api') {
      return {
        tool: action.tool,
        ok: false,
        reason: `http.request is not allowed on surface path ${surface.path ?? 'unknown'}`,
        idempotencyKey,
      };
    }
    // The same predicate decides Slack's probe and Slack's transport. Matching
    // one exact spelling here would send a row documented as `.../api` past the
    // isolated local proof service and out to slack.com.
    const transportEndpoint =
      surface.slug === 'slack' && isSlackApiEndpoint(surface.endpoint)
        ? slackApiBaseUrl().href
        : (surface.endpoint ?? '');
    let url: URL;
    try {
      url = resolveRequestUrl(transportEndpoint, request.path);
    } catch (error) {
      return { tool: action.tool, ok: false, reason: errorMessage(error), idempotencyKey };
    }
    const unlisted = operationRefusal(
      surface.toolAllowlist,
      request.method,
      operationUnderBase(url, transportEndpoint),
    );
    if (unlisted) return { tool: action.tool, ok: false, reason: unlisted, idempotencyKey };
    // A documented RPC read's body travels in the query, where every
    // parameter is checked and a `token` is left behind, and a GET or HEAD
    // sends none; only a body that is sent can carry the credential away.
    const bodySent =
      documentedRpcRead(request) === undefined &&
      request.method !== 'GET' &&
      request.method !== 'HEAD';
    const misplaced = httpSecretPlacementRefusal({
      path: request.path,
      headers: request.headers,
      ...(bodySent && request.body !== undefined ? { body: request.body } : {}),
    });
    if (misplaced) return { tool: action.tool, ok: false, reason: misplaced, idempotencyKey };
    if (hasPlaceholder(request.path)) {
      return {
        tool: action.tool,
        ok: false,
        reason:
          'the path carries a placeholder: a value was left unfilled, so the call was not sent',
        idempotencyKey,
      };
    }
    if (!surface.credentialId) {
      return { tool: action.tool, ok: false, reason: 'surface has no credential', idempotencyKey };
    }
    let secret = '';
    let writeAttempted = false;
    try {
      secret = await this.deps.decrypt(ctx, surface.credentialId);
      const bodyMoved = moveReadBodyIntoQuery(request, url);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (hasPlaceholder(key)) {
          throw new SecretTemplateError('secret placeholders are not allowed in header names');
        }
        // The content type described the body that is no longer sent.
        if (bodyMoved && key.toLowerCase() === 'content-type') continue;
        headers[key] = injectSecret(value, secret, surface.slug);
      }
      // The placement rule kept `{{secret}}` out of the body, so this only
      // refuses a placeholder the skill left unfilled.
      const body =
        bodyMoved ||
        request.body === undefined ||
        request.method === 'GET' ||
        request.method === 'HEAD'
          ? undefined
          : injectSecret(request.body, secret, surface.slug);
      if (body !== undefined && !namesContentType(headers) && isJsonText(body)) {
        headers[CONTENT_TYPE] = JSON_CONTENT_TYPE;
      }
      const authorityRefusal = transportAuthority
        ? await this.deps.beforeTransport?.(action, surface, { authority: transportAuthority })
        : await this.deps.beforeTransport?.(action, surface);
      if (authorityRefusal) {
        return { tool: action.tool, ok: false, reason: authorityRefusal, idempotencyKey };
      }
      const transport = await this.transportFor(surface, transportEndpoint);
      writeAttempted = actionIntent(request) === 'write';
      const response = await transport(url, {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'manual',
      });
      const bounded = await readBoundedResponse(response);
      const raw = bounded.text;
      if (bounded.exceeded) {
        return {
          tool: action.tool,
          ok: false,
          reason: `HTTP ${response.status} · response exceeded ${RESPONSE_READ_LIMIT} bytes`,
          ...(response.ok && writeAttempted ? { outcomeUnknown: true } : {}),
          idempotencyKey,
        };
      }
      if (response.ok && writeAttempted && isHtmlPage(response, raw)) {
        // A proxy, a gateway or a sign-in page answers 2xx with a page of its
        // own; the API never saw the write, or nobody can tell (E-79).
        return {
          tool: action.tool,
          ok: false,
          outcomeUnknown: true,
          reason: `HTTP ${response.status} · the answer was an HTML page, not the API's: a proxy or a sign-in page may have answered, so whether the write landed is unknown`,
          idempotencyKey,
        };
      }
      const redacted = await redactOutcome(raw, secret, this.deps.spanModel, this.deps.knownValues);
      const text = redacted.text;
      const redaction = redacted.redaction ? { redaction: redacted.redaction } : {};
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
      }
      const envelope = payload as { ok?: unknown; error?: unknown } | undefined;
      const envelopeFailed = envelope !== undefined && envelope.ok === false;
      const ok = response.ok && !envelopeFailed;
      const effectLength = writeAttempted ? EFFECT_LENGTH : READ_EFFECT_LENGTH;
      const summary = clipEffect(text, effectLength);
      if (!ok) {
        const errorResult =
          typeof envelope?.error === 'string'
            ? await redactOutcome(
                envelope.error,
                secret,
                this.deps.spanModel,
                this.deps.knownValues,
              )
            : undefined;
        const providerError = errorResult ? ` · ${errorResult.text}` : '';
        return {
          tool: action.tool,
          ok: false,
          reason: clipEffect(`HTTP ${response.status}${providerError} · ${summary}`, EFFECT_LENGTH),
          ...redaction,
          ...(errorResult?.redaction ? { redaction: errorResult.redaction } : {}),
          idempotencyKey,
        };
      }
      const rawId = providerIdFrom(payload);
      const identifier = rawId
        ? await redactOutcome(rawId, secret, this.deps.spanModel, this.deps.knownValues)
        : undefined;
      return {
        tool: action.tool,
        ok: true,
        effect: clipEffect(`HTTP ${response.status} · ${summary}`, effectLength),
        providerId: identifier ? clipEffect(identifier.text, EFFECT_LENGTH) : undefined,
        ...redaction,
        ...(identifier?.redaction ? { redaction: identifier.redaction } : {}),
        idempotencyKey,
      };
    } catch (error) {
      const message =
        error instanceof SecretTemplateError
          ? error.message
          : error instanceof Error && error.name === 'TimeoutError'
            ? `no response within ${HTTP_TIMEOUT_MS / 1000} s`
            : error instanceof Error
              ? error.message
              : String(error);
      const redacted = await redactOutcome(
        message,
        secret,
        this.deps.spanModel,
        this.deps.knownValues,
      );
      return {
        tool: action.tool,
        ok: false,
        reason: clipEffect(redacted.text, EFFECT_LENGTH),
        ...(writeAttempted ? { outcomeUnknown: true } : {}),
        ...(redacted.redaction ? { redaction: redacted.redaction } : {}),
        idempotencyKey,
      };
    }
  }
}

import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import { decryptCredential, type DecryptCredential } from './credentials';
import { clipEffect, READ_EFFECT_LENGTH } from './mock';
import {
  actionIntent,
  documentedRpcRead,
  parseSurfaceAction,
  resolveRequestUrl,
  surfaceRefusal,
  TOOL_NOT_ALLOWED,
  type ParsedHttpRequest,
} from './policy';
import { hasPlaceholder, injectSecret, SecretTemplateError } from './secrets';
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

export const HTTP_TOOLS = ['http.request'] as const satisfies readonly MockAction['tool'][];
export const HTTP_TIMEOUT_MS = 20_000;
export const EFFECT_LENGTH = 180;
const RESPONSE_READ_LIMIT = 64 * 1024;

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface HttpAdapterDeps {
  decrypt: DecryptCredential;
  fetch: FetchLike;
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
  if (method === undefined || request.body === undefined || request.body.trim() === '') return false;
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

/** Adapter for `http.request` against a documented HTTP API surface. */
export class HttpAdapter implements SurfaceAdapter {
  readonly tools = HTTP_TOOLS;

  /**
   * Args:
   *   surfaces: The agent's surfaces.
   *   deps: Credential decryption, the fetch implementation and a clock.
   */
  constructor(
    private readonly surfaces: readonly SurfaceRecord[],
    private readonly deps: HttpAdapterDeps = {
      decrypt: decryptCredential,
      fetch: (input: URL, init: RequestInit): Promise<Response> => fetch(input, init),
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
      return { tool: action.tool, ok: false, reason: parsed.ok ? 'not an http.request' : parsed.reason, idempotencyKey };
    }
    const request: ParsedHttpRequest = parsed.action;
    const surface = this.surfaces.find((row) => row.slug === request.surface);
    const refusal = surfaceRefusal(surface, this.deps.now());
    if (!surface || refusal) return { tool: action.tool, ok: false, reason: refusal, idempotencyKey };
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
      return { tool: action.tool, ok: false, reason: (error as Error).message, idempotencyKey };
    }
    const base = new URL(transportEndpoint);
    if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
    const operation = url.pathname.slice(base.pathname.length).replace(/^\/+/, '');
    if (!surface.toolAllowlist?.includes(operation)) {
      return {
        tool: action.tool,
        ok: false,
        reason: `${TOOL_NOT_ALLOWED} (${operation})`,
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
      const body =
        bodyMoved || request.body === undefined || request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : injectSecret(request.body, secret, surface.slug);
      const authorityRefusal = transportAuthority
        ? await this.deps.beforeTransport?.(action, surface, { authority: transportAuthority })
        : await this.deps.beforeTransport?.(action, surface);
      if (authorityRefusal) {
        return { tool: action.tool, ok: false, reason: authorityRefusal, idempotencyKey };
      }
      writeAttempted = actionIntent(request) === 'write';
      const response = await this.deps.fetch(url, {
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
        const errorResult = typeof envelope?.error === 'string'
          ? await redactOutcome(envelope.error, secret, this.deps.spanModel, this.deps.knownValues)
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
      const identifier = rawId ? await redactOutcome(rawId, secret, this.deps.spanModel, this.deps.knownValues) : undefined;
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
      const redacted = await redactOutcome(message, secret, this.deps.spanModel, this.deps.knownValues);
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

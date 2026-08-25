import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import { decryptCredential, type DecryptCredential } from './credentials';
import { clipEffect } from './mock';
import { parseSurfaceAction, surfaceRefusal, type ParsedHttpRequest } from './policy';
import { injectSecret, redactValue, SecretTemplateError } from './secrets';
import type { AdapterRun, AppliedAction, SurfaceAdapter, SurfaceRecord } from './types';

export const HTTP_TOOLS = ['http.request'] as const satisfies readonly MockAction['tool'][];
export const HTTP_TIMEOUT_MS = 20_000;
export const EFFECT_LENGTH = 180;
const RESPONSE_READ_LIMIT = 64 * 1024;

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface HttpAdapterDeps {
  decrypt: DecryptCredential;
  fetch: FetchLike;
  now: () => number;
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
export function resolveRequestUrl(endpoint: string, path: string): URL {
  const base = new URL(endpoint);
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  const target = new URL(path.replace(/^\/+/, ''), base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    throw new Error('path escapes the surface endpoint');
  }
  return target;
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
    let url: URL;
    try {
      url = resolveRequestUrl(surface.endpoint ?? '', request.path);
    } catch (error) {
      return { tool: action.tool, ok: false, reason: (error as Error).message, idempotencyKey };
    }
    if (!surface.credentialId) {
      return { tool: action.tool, ok: false, reason: 'surface has no credential', idempotencyKey };
    }
    let secret = '';
    try {
      secret = await this.deps.decrypt(ctx, surface.credentialId);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = injectSecret(value, secret, surface.slug);
      }
      const body =
        request.body === undefined || request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : injectSecret(request.body, secret, surface.slug);
      const response = await this.deps.fetch(url, {
        method: request.method,
        headers,
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'manual',
      });
      const raw = (await response.text()).slice(0, RESPONSE_READ_LIMIT);
      const text = redactValue(raw, secret);
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
      }
      const envelope = payload as { ok?: unknown; error?: unknown } | undefined;
      const envelopeFailed = envelope !== undefined && envelope.ok === false;
      const ok = response.ok && !envelopeFailed;
      const summary = clipEffect(text, EFFECT_LENGTH);
      if (!ok) {
        const providerError =
          typeof envelope?.error === 'string' ? ` · ${redactValue(envelope.error, secret)}` : '';
        return {
          tool: action.tool,
          ok: false,
          reason: clipEffect(`HTTP ${response.status}${providerError} · ${summary}`, EFFECT_LENGTH),
          idempotencyKey,
        };
      }
      return {
        tool: action.tool,
        ok: true,
        effect: clipEffect(`HTTP ${response.status} · ${summary}`, EFFECT_LENGTH),
        providerId: providerIdFrom(payload),
        idempotencyKey,
      };
    } catch (error) {
      const message =
        error instanceof SecretTemplateError
          ? error.message
          : (error as Error).name === 'TimeoutError'
            ? `no response within ${HTTP_TIMEOUT_MS / 1000} s`
            : (error as Error).message;
      return {
        tool: action.tool,
        ok: false,
        reason: clipEffect(redactValue(message, secret), EFFECT_LENGTH),
        idempotencyKey,
      };
    }
  }
}

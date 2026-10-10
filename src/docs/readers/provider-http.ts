/**
 * The HTTP a REST documentation reader speaks to its provider with (wave 15, 15-X).
 *
 * Confluence, SharePoint, Yuque and Google Drive each answer over HTTPS with a token in a header,
 * and each needs the same care: a request is timed, never follows a redirect that would carry its
 * token elsewhere, and reads a bounded body; a "not now" (429, 503, a provider's own limit) is
 * waited out for the time the answer names, inside one batch's budget; a host that cannot be
 * reached is said as that, with what IT checks (the Feishu reader's W14-R39); and an answer that
 * is not the provider's own (a proxy's or a firewall's page) is never read as a page's refusal
 * (W14-R9). A reader words every other refusal itself, since only it knows the step IT takes.
 */
import {
  interruptedReadError,
  retryAfterMs,
  TransientProviderError,
  transportFailureKind,
  withBackoff,
  type BackoffPolicy,
} from '../../lib/transport-error';

/** How one request is made: the platform's `fetch`, which a test answers in-process. */
export type ProviderFetch = (input: URL, init: RequestInit) => Promise<Response>;

/** What a reader is given instead of the network, the clock and the timer, for tests. */
export interface ProviderHttpOptions {
  /** Sends one request; the platform's `fetch` by default. */
  readonly fetch?: ProviderFetch;
  /** The clock the request spacing and a token's life are read against. */
  readonly now?: () => number;
  /** Waits between requests and before a retry. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long one batch may spend waiting on the provider; `BATCH_BUDGET_MS` by default. */
  readonly batchBudgetMs?: number;
}

/** How long one request may take. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long one batch may spend before a wait would run past it: under the ten minutes a Convex
 * action has, so a limit that keeps resetting fails the batch, which records why, rather than the
 * action being stopped mid-batch (the Feishu reader's budget).
 */
export const BATCH_BUDGET_MS = 6 * 60_000;

/** The largest answer read unless a request names its own bound: a listing, never a file. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How a limited or failed request is tried again: a provider can name a wait of up to a minute,
 * which the reader waits out, three times at most.
 */
const PROVIDER_REST_BACKOFF: BackoffPolicy = { attempts: 4, baseMs: 1_000, maxWaitMs: 65_000 };

/** One answer, read whole. */
export interface ProviderAnswer {
  readonly url: URL;
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
}

/** One request to a provider. */
export interface ProviderRequest {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** The largest body read; a larger one throws `AnswerTooLargeError`. */
  readonly maxBytes?: number;
  /**
   * Whether an answer is the provider's own "not now" beyond a 429 or a 5xx (Google Drive's 403
   * `userRateLimitExceeded`), to be waited out and asked again.
   */
  readonly limited?: (answer: ProviderAnswer) => boolean;
  /** `manual` hands a redirect back unfollowed; any redirect is an error otherwise. */
  readonly redirect?: 'error' | 'manual';
}

/** The machine Day0 runs on could not reach a provider's host at all. */
export class ProviderUnreachableError extends Error {
  constructor(host: string, cause: unknown) {
    super(
      `Day0 could not reach ${host}: ${innermostMessage(cause)}. The machine Day0's backend runs on ` +
        `must reach ${host} directly over HTTPS, with no proxy in between: ask IT to allow it.`,
      { cause },
    );
    this.name = 'ProviderUnreachableError';
  }
}

/** An answer that is not the provider's own: a proxy's or a firewall's page. */
export class ProviderGatewayError extends Error {
  constructor(provider: string, answer: ProviderAnswer) {
    super(
      `${answer.url.host} answered HTTP ${answer.status} with a page that is not ${provider}'s own ` +
        `answer, so something between Day0 and ${provider} (a proxy or a firewall) may be stopping ` +
        `the request: ask IT whether the machine Day0 runs on reaches ${answer.url.host} directly.`,
    );
    this.name = 'ProviderGatewayError';
  }
}

/** An answer larger than the request's bound. */
export class AnswerTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(url: URL, maxBytes: number) {
    super(`${url.host} sent more than the ${maxBytes} bytes Day0 reads of one answer.`);
    this.name = 'AnswerTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** The innermost message of an error's cause chain: what the transport itself said. */
function innermostMessage(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause !== undefined; ) {
    current = current.cause;
    depth += 1;
  }
  return current instanceof Error ? current.message : String(current);
}

/** A response's body, read whole or refused once it passes the bound. */
async function boundedBytes(response: Response, url: URL, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new AnswerTooLargeError(url, maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** An answer's body as text. */
export function answerText(answer: ProviderAnswer): string {
  return new TextDecoder().decode(answer.bytes);
}

/**
 * An answer's body as the provider's own: its JSON, or nothing when the answer has no body.
 *
 * Read before an answer's status is worded, so a 403 that is a proxy's page is never read as the
 * provider's refusal of a credential (W14-R9).
 *
 * @param provider - The provider's name, for the refusal.
 * @returns The parsed body, or undefined for an empty one.
 * @throws ProviderGatewayError when the body is anything else: something other than the provider
 *   answered.
 */
export function providerBody(provider: string, answer: ProviderAnswer): unknown {
  const text = answerText(answer);
  if (text.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: worded below as the page of whatever stands between.
    throw new ProviderGatewayError(provider, answer);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProviderGatewayError(provider, answer);
  }
  return parsed;
}

/** An object's field, when the value is an object. */
export function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/** A string field, or undefined. */
export function textField(value: unknown, name: string): string | undefined {
  const found = field(value, name);
  return typeof found === 'string' ? found : undefined;
}

/** An array field's items, or none. */
export function listField(value: unknown, name: string): readonly unknown[] {
  const found = field(value, name);
  return Array.isArray(found) ? found : [];
}

/**
 * One reader's connection to its provider for one batch: paced, timed, bounded and retried.
 *
 * The sync makes one reader a batch, so the budget starts when the connection is made.
 */
export class ProviderHttp {
  private readonly provider: string;
  private readonly spacingMs: number;
  private readonly fetch: ProviderFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly deadline: number;
  private lastRequestAt: number | undefined;

  /**
   * @param provider - The provider's name as a sentence says it: `Confluence`, `SharePoint`.
   * @param spacingMs - The least time between two requests, from the provider's published limit.
   * @param options - The fetch, clock and timer; the real ones by default.
   */
  constructor(provider: string, spacingMs: number, options: ProviderHttpOptions = {}) {
    this.provider = provider;
    this.spacingMs = spacingMs;
    this.fetch = options.fetch ?? ((input, init): Promise<Response> => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms: number): Promise<void> =>
        new Promise((resolve): void => {
          setTimeout(resolve, ms);
        }));
    // On the system clock, which the backoff reads its deadline against.
    this.deadline = Date.now() + (options.batchBudgetMs ?? BATCH_BUDGET_MS);
  }

  /**
   * Send one request and read its answer whole.
   *
   * @returns The answer, whatever its status, once it is not a "not now".
   * @throws TransientProviderError when the provider stays limited or failing past the waits;
   *   ProviderUnreachableError when its host cannot be reached; AnswerTooLargeError past the bound.
   */
  async send(url: URL, request: ProviderRequest = {}): Promise<ProviderAnswer> {
    try {
      return await withBackoff(async (): Promise<ProviderAnswer> => await this.once(url, request), {
        ...PROVIDER_REST_BACKOFF,
        sleep: this.sleep,
        deadline: this.deadline,
      });
    } catch (error) {
      if (error instanceof TransientProviderError) throw error;
      if (transportFailureKind(error) === 'refused') {
        throw new ProviderUnreachableError(url.host, error);
      }
      throw interruptedReadError(error, `The read of ${url.host}`) ?? error;
    }
  }

  /** One try: spaced, sent, read, and classed as a "not now" or an answer. */
  private async once(url: URL, request: ProviderRequest): Promise<ProviderAnswer> {
    await this.pace();
    const response = await this.fetch(url, {
      method: request.method ?? 'GET',
      headers: { accept: 'application/json', ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      // A redirect would carry the token to wherever it points.
      redirect: request.redirect ?? 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const answer: ProviderAnswer = {
      url,
      status: response.status,
      headers: response.headers,
      bytes: await boundedBytes(response, url, request.maxBytes ?? DEFAULT_MAX_BYTES),
    };
    const limited = response.status === 429 || request.limited?.(answer) === true;
    if (limited || response.status >= 500) {
      throw new TransientProviderError(
        limited
          ? `${this.provider} was rate limited (HTTP ${response.status}).`
          : `${this.provider} answered HTTP ${response.status}.`,
        {
          retryAfterMs: retryAfterMs(response.headers.get('retry-after'), this.now()),
          status: response.status,
        },
      );
    }
    return answer;
  }

  /** Wait until the provider's spacing since the last request has passed. */
  private async pace(): Promise<void> {
    const last = this.lastRequestAt;
    const wait = last === undefined ? 0 : last + this.spacingMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }
}

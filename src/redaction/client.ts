/**
 * The span model as the caller sees it: text and labels in, spans out.
 *
 * The production implementation dials the redaction component over HTTP on
 * the compose network. Tests hand in a double. Nothing here knows what a
 * label means; the policy does.
 */
import { REDACTOR_TIMEOUT_MS } from './policy';
import { fetchWithBackoff, type BackoffPolicy } from '../lib/transport-error';

export interface ModelSpan {
  start: number;
  end: number;
  label: string;
  score: number;
}

export interface SpanModel {
  /** A short name for ledger rows and logs. */
  readonly name: string;
  spans(text: string, labels: readonly string[], threshold: number): Promise<ModelSpan[]>;
}

/** Raised when the component cannot be reached or does not answer in time. */
export class RedactorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactorUnavailableError';
  }
}

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/**
 * One more try for a reset connection or a 503, inside the same deadline: the
 * component is on the compose network, so a second try is cheap and a longer
 * wait would only spend the sync's budget.
 */
export const REDACTOR_BACKOFF: BackoffPolicy = { attempts: 2, baseMs: 250, maxWaitMs: 1_000 };

/**
 * The HTTP client for the `redactor` compose service.
 *
 * A non-2xx reply, a body that is not the expected shape, a network error and
 * a timeout all surface as `RedactorUnavailableError`, so a caller has one
 * condition to decide its fallback on.
 */
export class HttpSpanModel implements SpanModel {
  readonly name: string;
  private readonly endpoint: URL;

  // Four parameters, beyond the soft three: the last two are test seams with defaults.
  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchLike = (input: URL, init: RequestInit): Promise<Response> =>
      fetch(input, init),
    private readonly timeoutMs: number = REDACTOR_TIMEOUT_MS,
    private readonly backoff: BackoffPolicy = REDACTOR_BACKOFF,
  ) {
    this.endpoint = new URL('/v1/spans', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    this.name = `redactor@${this.endpoint.host}`;
  }

  async spans(text: string, labels: readonly string[], threshold: number): Promise<ModelSpan[]> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let onAbort: () => void = () => {};
    const deadline = new Promise<never>((_, reject) => {
      onAbort = () => reject(new RedactorUnavailableError('redaction component timed out'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.readSpans(text, labels, threshold, signal), deadline]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async readSpans(
    text: string,
    labels: readonly string[],
    threshold: number,
    signal: AbortSignal,
  ): Promise<ModelSpan[]> {
    const send = fetchWithBackoff(
      (input: URL, init?: RequestInit): Promise<Response> => this.fetchImpl(input, init ?? {}),
      undefined,
      this.backoff,
    );
    let response: Response;
    try {
      response = await send(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, labels, threshold }),
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RedactorUnavailableError(
        `redaction component unreachable at ${this.endpoint.host}: ${reason}`,
      );
    }
    if (!response.ok) {
      throw new RedactorUnavailableError(`redaction component answered HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RedactorUnavailableError(
        'redaction component answered with a body that is not JSON',
      );
    }
    const spans = (body as { spans?: unknown } | null)?.spans;
    if (!Array.isArray(spans)) {
      throw new RedactorUnavailableError('redaction component answered without spans');
    }
    return spans.map((entry: unknown): ModelSpan => {
      const span = entry as Partial<ModelSpan> | null;
      if (
        !span ||
        typeof span.start !== 'number' ||
        typeof span.end !== 'number' ||
        typeof span.label !== 'string' ||
        typeof span.score !== 'number' ||
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        !Number.isFinite(span.score) ||
        span.score < 0 ||
        span.score > 1 ||
        !labels.includes(span.label) ||
        span.start < 0 ||
        span.end > text.length ||
        span.end <= span.start
      ) {
        throw new RedactorUnavailableError('redaction component answered with an invalid span');
      }
      return { start: span.start, end: span.end, label: span.label, score: span.score };
    });
  }
}

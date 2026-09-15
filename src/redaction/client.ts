/**
 * The span model as the caller sees it: text and labels in, spans out.
 *
 * The production implementation dials the redaction component over HTTP on
 * the compose network. Tests hand in a double. Nothing here knows what a
 * label means; the policy does.
 */
import { REDACTOR_TIMEOUT_MS } from './policy';

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
 * The HTTP client for the `redactor` compose service.
 *
 * A non-2xx reply, a body that is not the expected shape, a network error and
 * a timeout all surface as `RedactorUnavailableError`, so a caller has one
 * condition to decide its fallback on.
 */
export class HttpSpanModel implements SpanModel {
  readonly name: string;
  private readonly endpoint: URL;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchLike = (input: URL, init: RequestInit): Promise<Response> =>
      fetch(input, init),
    private readonly timeoutMs: number = REDACTOR_TIMEOUT_MS,
  ) {
    this.endpoint = new URL('/v1/spans', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    this.name = `redactor@${this.endpoint.host}`;
  }

  async spans(text: string, labels: readonly string[], threshold: number): Promise<ModelSpan[]> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, labels, threshold }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RedactorUnavailableError(`redaction component unreachable at ${this.endpoint.host}: ${reason}`);
    }
    if (!response.ok) {
      throw new RedactorUnavailableError(`redaction component answered HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RedactorUnavailableError('redaction component answered with a body that is not JSON');
    }
    const spans = (body as { spans?: unknown } | null)?.spans;
    if (!Array.isArray(spans)) {
      throw new RedactorUnavailableError('redaction component answered without spans');
    }
    return spans.flatMap((entry: unknown): ModelSpan[] => {
      const span = entry as Partial<ModelSpan> | null;
      if (
        !span ||
        typeof span.start !== 'number' ||
        typeof span.end !== 'number' ||
        typeof span.label !== 'string' ||
        typeof span.score !== 'number' ||
        span.start < 0 ||
        span.end > text.length ||
        span.end <= span.start
      ) {
        return [];
      }
      return [{ start: span.start, end: span.end, label: span.label, score: span.score }];
    });
  }
}

/**
 * The span model this deployment is configured with, if any.
 *
 * `DAY0_REDACTOR_URL` names the component as the backend container reaches
 * it (`http://redactor:8000` for the bundled one). Unset means no model: a
 * documentation sync then refuses, and outcomes say the structural grammar was
 * all that protected them.
 *
 * Args:
 *   url: The configured address; defaults to the environment.
 *
 * Returns:
 *   A client, or undefined when nothing is configured.
 */
export function spanModelFromEnv(url: string | undefined = process.env.DAY0_REDACTOR_URL): SpanModel | undefined {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return new HttpSpanModel(trimmed);
}

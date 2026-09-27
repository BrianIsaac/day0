/** Connection-failure markers preserved by Node, fetch and the MCP client. */
const UNREACHABLE_MARKERS = [
  'econnrefused',
  'enotfound',
  'eai_again',
  'ehostunreach',
  'enetunreach',
  'etimedout',
  'econnreset',
  'fetch failed',
  'failed to fetch',
  'connection refused',
  'socket hang up',
  'network error',
  'getaddrinfo',
  'could not connect',
  'failed to connect',
  'unable to connect',
  'connection closed',
] as const;

/** Markers of a connection nobody answered: nothing is listening, or the name does not resolve. */
const REFUSED_MARKERS = [
  'econnrefused',
  'enotfound',
  'eai_again',
  'ehostunreach',
  'enetunreach',
  'getaddrinfo',
  'connection refused',
  'could not connect',
  'failed to connect',
  'unable to connect',
] as const;

/** Markers of a read that started and was cut off: a timeout, a reset, a closed socket. */
const INTERRUPTED_MARKERS = [
  'etimedout',
  'econnreset',
  'socket hang up',
  'connection closed',
  'other side closed',
  'network error',
  'timeouterror',
  'aborterror',
  'timed out',
  'terminated',
  'fetch failed',
  'failed to fetch',
] as const;

/** The messages, codes and names along an error's cause chain, lower-cased. */
function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }
    if (!(current instanceof Error)) break;
    parts.push(current.message, current.name);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') parts.push(code);
    current = current.cause;
  }
  return parts.join(' ').toLowerCase();
}

/** Whether an error chain says that no transport answered. */
export function isTransportUnreachable(error: unknown): boolean {
  const text = errorChainText(error);
  return UNREACHABLE_MARKERS.some((marker: string): boolean => text.includes(marker));
}

/** How a transport failed: nobody answered, or an answer was cut off. */
export type TransportFailureKind = 'refused' | 'interrupted';

/**
 * Say how a transport failed, or return undefined when the error is not a transport's.
 *
 * The two kinds need different words: a connection nobody answered is
 * something a person can fix (start the component, fix the address), while a
 * read that timed out or was reset after the connection was made is a
 * transient the next attempt usually clears. A refusal marker anywhere in the
 * chain wins, so `fetch failed` caused by `ECONNREFUSED` is a refusal.
 *
 * @param error - Anything thrown.
 */
export function transportFailureKind(error: unknown): TransportFailureKind | undefined {
  const text = errorChainText(error);
  if (REFUSED_MARKERS.some((marker: string): boolean => text.includes(marker))) return 'refused';
  if (INTERRUPTED_MARKERS.some((marker: string): boolean => text.includes(marker))) {
    return 'interrupted';
  }
  return undefined;
}

/**
 * A provider's answer that says "not now": a rate limit or a server error.
 *
 * It carries the wait the provider asked for, when it named one, so the
 * caller's backoff honours it instead of guessing.
 */
export class TransientProviderError extends Error {
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly retryAfterMs?: number;
      readonly status?: number;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'TransientProviderError';
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }
}

/**
 * Milliseconds a `Retry-After` value asks for.
 *
 * @param value - The header: delta seconds or an HTTP date.
 * @param now - The clock, in epoch milliseconds.
 * @returns The wait, never negative, or undefined when the value is neither form.
 */
export function retryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1_000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Class an HTTP answer as a transient provider failure.
 *
 * @param response - The provider's answer.
 * @param what - Who was asked, for the message: `Slack conversations.history`.
 * @param now - The clock, for an HTTP-date `Retry-After`.
 * @returns The error for a 429 or a 5xx, with the wait the answer asked for; undefined otherwise.
 */
export function transientFromResponse(
  response: Response,
  what: string,
  now: number = Date.now(),
): TransientProviderError | undefined {
  if (response.status !== 429 && response.status < 500) return undefined;
  return new TransientProviderError(
    response.status === 429
      ? `${what} was rate limited (HTTP 429).`
      : `${what} answered HTTP ${response.status}.`,
    {
      retryAfterMs: retryAfterMs(response.headers.get('retry-after'), now),
      status: response.status,
    },
  );
}

/** The innermost message of an error's cause chain. */
function rootMessage(error: unknown): string {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current instanceof Error && current.cause !== undefined;
    depth += 1
  ) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
}

/**
 * Word a read that was timed out or reset as the transient it is, keeping its cause.
 *
 * A source's recorded reason is its message, so the cause goes into the
 * message as well as onto `cause`: "the read was interrupted (read
 * ECONNRESET)" tells the operator what happened, where the bare transport
 * wording read as a component that is not running.
 *
 * @param error - Anything a read threw.
 * @param what - What was being read, for the message.
 * @returns The transient error, the error itself when it already is one, or undefined for anything else.
 */
export function interruptedReadError(
  error: unknown,
  what = 'The read',
): TransientProviderError | undefined {
  if (error instanceof TransientProviderError) return error;
  if (transportFailureKind(error) !== 'interrupted') return undefined;
  return new TransientProviderError(
    `${what} was interrupted (${rootMessage(error)}); this is transient, and the next attempt reads it again.`,
    { cause: error },
  );
}

/** How many times a provider call is tried, and how long it may wait between tries. */
export interface BackoffPolicy {
  readonly attempts: number;
  readonly baseMs: number;
  /** A provider that asks for a longer wait than this is not waited for: the failure stands. */
  readonly maxWaitMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The backoff every documentation and intake read uses (Q13): three tries,
 * one then two seconds apart unless the provider names a wait, and never a
 * wait over thirty seconds, so one poll or one sync batch stays inside its
 * action's budget and a long rate-limit window is left to the next run.
 */
export const PROVIDER_BACKOFF: BackoffPolicy = { attempts: 3, baseMs: 1_000, maxWaitMs: 30_000 };

/** Whether another try could get a different answer. */
function retryable(error: unknown): boolean {
  return error instanceof TransientProviderError || transportFailureKind(error) === 'interrupted';
}

/**
 * Call a provider, retrying a transient failure with exponential backoff that honours Retry-After.
 *
 * A refusal, an authentication failure or any other answer that another try
 * would repeat is thrown at once; so is the last transient failure, with its
 * cause, for the caller to record as the transient it is.
 *
 * @param call - One provider request.
 * @param policy - Tries and waits; `PROVIDER_BACKOFF` for every provider read.
 * @returns The call's answer.
 * @throws The last error when no try succeeded.
 */
export async function withBackoff<T>(
  call: () => Promise<T>,
  policy: BackoffPolicy = PROVIDER_BACKOFF,
): Promise<T> {
  const sleep =
    policy.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve): void => {
        setTimeout(resolve, ms);
      }));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!retryable(error) || attempt >= policy.attempts) throw error;
      const asked = error instanceof TransientProviderError ? error.retryAfterMs : undefined;
      const wait = asked ?? policy.baseMs * 2 ** (attempt - 1);
      if (wait > policy.maxWaitMs) throw error;
      await sleep(wait);
    }
  }
}

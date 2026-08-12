/**
 * Shared machinery for the two structured-output ladders: the raw-SDK one in
 * `openai.ts` and the Mastra one in `mastra.ts`. Both ask a server for a native
 * structured response first and drop to prompt injection when it will not do
 * it, and both need to answer the same two questions honestly.
 *
 *   1. Does this error mean "I do not implement that", or something else?
 *      Naming `response_format` is not evidence: a rate limit, an expired key
 *      and an over-long context can all quote the parameter back while saying
 *      nothing about whether the server supports it. A refusal has to look like
 *      a refusal - a status a server uses for an unimplemented request shape,
 *      the parameter named, and wording that declines it - and must not look
 *      like any of the causes that are about something else.
 *   2. How far does one refusal travel? Support is a property of an endpoint,
 *      a model and (for a strict schema) the schema, so a demotion is keyed by
 *      those and expires. One incompatible schema demoting every later charter,
 *      plan and evaluator call for the lifetime of a warm process is not a
 *      conclusion the evidence supports.
 */

/** How long one refusal keeps its scope on the prompt rung before native is retried. */
export const STRUCTURED_DEMOTION_TTL_MS = 10 * 60 * 1000;

/** Statuses a server uses to say "I do not implement that request shape". */
const CAPABILITY_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

/** The parameter has to be what the message is about. */
const NAMES_STRUCTURED_OUTPUT =
  /response_format|json_schema|json_object|structured[ _]output|json mode/;

/** ...and the server has to be declining it rather than reporting on it. */
const DECLINES_IT =
  /unsupported|not supported|does not support|unknown|unrecognized|unrecognised|not implemented|not permitted|no such/;

/**
 * Causes that are about something else entirely, whatever else the message
 * happens to name. Checked first: these are the four shapes that were being
 * read as "this server has no JSON mode", and prompt injection recovers from
 * none of them - a rate limit rate-limits the second call too, and prompt mode
 * spends *more* context, not less.
 */
const UNRELATED_CAUSE =
  /rate.?limit|too many requests|quota|insufficient_quota|billing|api key|unauthori[sz]ed|authenticat|permission|context length|maximum context|reduce the length|too many tokens|overload|service_unavailable|timeout|timed out|temporarily/;

interface ErrorLike {
  status?: number;
  statusCode?: number;
  message?: unknown;
  error?: { message?: unknown };
}

/**
 * Whether an error means "this server does not implement native structured
 * output" rather than "this request was bad" or "this server is busy". Servers
 * decline it in at least three shapes: a 400 naming the field, a 404 on the
 * route, and a 422 from proxies that validate the body themselves.
 */
export function isStructuredOutputRefusal(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ErrorLike;
  const message = `${String(e.message ?? '')} ${String(e.error?.message ?? '')}`.toLowerCase();
  if (UNRELATED_CAUSE.test(message)) return false;

  const status = e.status ?? e.statusCode;
  if (status === undefined || !CAPABILITY_STATUSES.has(status)) return false;

  return NAMES_STRUCTURED_OUTPUT.test(message) && DECLINES_IT.test(message);
}

export interface FallbackMemo {
  /** Whether this scope is currently on the prompt rung. */
  isDemoted(key: string): boolean;
  /** Put this scope on the prompt rung until the TTL lapses. */
  demote(key: string): void;
  /** Milliseconds until this scope retries native, or null when it is not demoted. */
  retriesNativeIn(key: string): number | null;
  /** Test seam, and what the endpoint probe calls between rungs. */
  reset(): void;
}

export function createFallbackMemo(ttlMs: number = STRUCTURED_DEMOTION_TTL_MS): FallbackMemo {
  const demotedUntil = new Map<string, number>();

  const remaining = (key: string): number | null => {
    const until = demotedUntil.get(key);
    if (until === undefined) return null;
    const left = until - Date.now();
    if (left > 0) return left;
    demotedUntil.delete(key);
    return null;
  };

  return {
    isDemoted: (key) => remaining(key) !== null,
    demote: (key) => void demotedUntil.set(key, Date.now() + ttlMs),
    retriesNativeIn: remaining,
    reset: () => demotedUntil.clear(),
  };
}

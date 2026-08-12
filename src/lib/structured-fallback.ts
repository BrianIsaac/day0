/**
 * Shared machinery for the two structured-output ladders: the raw-SDK one in
 * `openai.ts` and the Mastra one in `mastra.ts`. Both ask a server for a native
 * structured response first and drop to prompt injection when it will not do
 * it, and both need to answer the same two questions honestly.
 *
 *   1. Does this failure mean "I do not implement that", or something else?
 *      No wording answers that. Servers decline `response_format` in whatever
 *      prose they like ("not supported", "Allowed values are: text", a bare
 *      422 from a proxy), and they also quote the parameter back while
 *      failing for reasons that have nothing to do with it. The one fact that
 *      separates the two is behavioural: *the same request without the
 *      parameter succeeds*. So nothing here concludes anything. It decides
 *      only whether that experiment is safe to run, and the caller demotes on
 *      the result.
 *
 *      Words are therefore read for shape, never for a conclusion: whether a
 *      *server* answered at all, and if it did, whether it blamed the request
 *      it read or a condition of its own. "Allowed values are: text" earns the
 *      experiment because only something that read a request can name a
 *      parameter of it and report it rejected - not because those words mean
 *      "unsupported".
 *   2. How far does one refusal travel? Support is a property of an endpoint,
 *      a model and (for a strict schema) the schema, so a demotion is keyed by
 *      those and expires. One incompatible schema demoting every later charter,
 *      plan and evaluator call for the lifetime of a warm process is not a
 *      conclusion the evidence supports.
 *
 * The experiment has one limit worth stating, because a classifier that
 * forgets it invents evidence: the two calls are separated in time, so a
 * prompt success is consistent with "removing the parameter fixed it" *and*
 * with "whatever was wrong cleared in between". Nothing here can tell those
 * apart. What it can do is refuse to run the experiment when the failure was
 * never about the parameter, and refuse to call the result proof when the
 * native failure was the kind of thing that passes on its own. Hence two
 * outputs rather than one: whether to try, and whether success would prove
 * anything.
 */

/** How long one proven refusal keeps its scope on the prompt rung. */
export const STRUCTURED_DEMOTION_TTL_MS = 10 * 60 * 1000;

/**
 * Raised when a request completed and the reply carried no valid object. The
 * ladders' own parse and missing-object errors extend this so the classifier
 * can recognise "the server answered and ignored the contract" by type rather
 * than by reading a message.
 */
export class StructuredContractError extends Error {}

/**
 * Statuses that attribute a failure to something the parameter cannot explain:
 * credentials, entitlement, rate, request size, and the server being unwell.
 * Dropping `response_format` fixes none of them and prompt mode, which spends
 * *more* context than native, makes several of them worse.
 */
function statusBlamesAnotherCause(status: number): boolean {
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 408 ||
    status === 413 ||
    status === 429 ||
    status >= 500
  );
}

/** Failures that never reached an endpoint, so they say nothing about it. */
const TRANSPORT_FAILURE =
  /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPROTO|CERT_|DEPTH_ZERO|UND_ERR_)/;

/**
 * The same thing in prose, for stacks that report a dead connection as a
 * message rather than a code. Literal undici phrasings only: a loose word like
 * "network" would let model output veto its own fallback, which is the failure
 * mode this whole file exists to avoid.
 */
const NO_RESPONSE_PHRASE =
  /fetch failed|socket hang up|network socket disconnected|other side closed/;

/**
 * Names the parameter under test. Not a conclusion on its own: a server quotes
 * it back both when it will not take it and when it fails for reasons that have
 * nothing to do with it.
 */
const NAMES_STRUCTURED_OUTPUT =
  /response_format|json_schema|json_object|structured[ _]output|json mode/;

/**
 * Rejection of something the *request* carried, as opposed to a report about
 * the server's own condition. Paired with the pattern above and never read
 * alone: "invalid" says nothing by itself, and neither does `json_schema`.
 */
const REJECTS_WHAT_THE_REQUEST_CARRIED =
  /support|unrecogni[sz]ed|unknown (?:parameter|argument|field|value)|unexpected (?:parameter|argument|field)|invalid|not a valid|allowed values?|not allowed|not permitted|must be one of|only accepts?|cannot be used|not implemented|not available|disabled/;

/**
 * The same causes named in prose, for servers that put them behind a
 * request-shape status where the status alone will not give them away - a
 * context overflow is a 400 on most OpenAI-compatible endpoints - and for
 * stacks that report them with no status at all. Only ever consulted against a
 * *server's* diagnosis of a failed request, never against model output, so an
 * agent that happens to write "permission" into a reply cannot veto its own
 * fallback.
 */
const DIAGNOSIS_BLAMES_ANOTHER_CAUSE =
  /rate.?limit|too many requests|quota|insufficient_quota|billing|api key|unauthori[sz]ed|authenticat|permission|context length|maximum context|reduce the length|too long|too many tokens|overload|service_unavailable|timeout|timed out|temporarily/;

/** What the ladder is allowed to do about a failed native attempt. */
export type StructuredVerdict =
  /** The cause is not the parameter. Rethrow; a second request fails the same way. */
  | 'unrelated'
  /**
   * A request without the parameter is worth making. Whether its success may
   * also be recorded against the scope is `provesRefusal`, not this.
   */
  | 'testable';

export interface StructuredFailure {
  verdict: StructuredVerdict;
  /**
   * Whether a prompt success would *prove* `response_format` was the cause.
   * False when the native failure is the kind that also passes on a retry: the
   * object is still worth fetching, but a scope must not be held on the prompt
   * rung on evidence that cannot tell a refusal from a coincidence. Only
   * meaningful for a `testable` verdict.
   */
  provesRefusal: boolean;
  /** What decided it, so a demotion or a rethrow can be audited from the log. */
  evidence: string;
}

interface ErrorFacts {
  /** The first HTTP failure status anywhere in the cause chain. */
  status?: number;
  /** A transport-level error code, when the request never got an answer. */
  transport?: string;
  /** The server's own diagnosis: messages and response bodies, never the request. */
  diagnosis: string;
  /** The machine-readable `param` of the OpenAI error contract, lowercased. */
  param?: string;
  /** Whether an observable failing request carried `response_format`. */
  carriedParameter?: boolean;
  /**
   * Whether a server was observed to answer at all - any HTTP status, a
   * response body, response headers, an error body's `param`. Without one, the
   * failure happened on this side of the wire and the endpoint's opinion of
   * `response_format` was never expressed, let alone recorded.
   */
  responded: boolean;
  /** The stack's own view that this failure may pass on a retry. */
  retryable?: boolean;
}

interface ErrorLike {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
  param?: unknown;
  responseBody?: unknown;
  responseHeaders?: unknown;
  requestBodyValues?: unknown;
  isRetryable?: unknown;
  error?: unknown;
  cause?: unknown;
}

const MAX_CAUSE_DEPTH = 8;

function gatherFacts(err: unknown): ErrorFacts {
  const facts: ErrorFacts = { diagnosis: '', responded: false };
  const seen = new Set<unknown>();
  let node: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && node && typeof node === 'object'; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    const e = node as ErrorLike;

    for (const raw of [e.status, e.statusCode]) {
      if (typeof raw !== 'number' || raw < 100) continue;
      // A 200 here is not a contradiction: the AI SDK reports a reply it could
      // not read as an API call error carrying the status it arrived with. A
      // status below 100 is not one, and some clients use 0 for "never sent".
      facts.responded = true;
      if (facts.status === undefined && raw >= 400) facts.status = raw;
    }
    if (
      typeof e.responseBody === 'string' ||
      (e.responseHeaders && typeof e.responseHeaders === 'object')
    ) {
      facts.responded = true;
    }
    if (typeof e.isRetryable === 'boolean') facts.retryable ??= e.isRetryable;
    if (
      facts.transport === undefined &&
      typeof e.code === 'string' &&
      TRANSPORT_FAILURE.test(e.code)
    ) {
      facts.transport = e.code;
    }
    if (facts.transport === undefined && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      facts.transport = String(e.name);
    }
    if (typeof e.message === 'string') facts.diagnosis += ` ${e.message}`;
    if (typeof e.responseBody === 'string') facts.diagnosis += ` ${e.responseBody}`;
    // `param` belongs to the OpenAI error *body*, so a client only ever holds
    // one because a server sent it: its presence is itself a response.
    if (typeof e.param === 'string') {
      facts.param ??= e.param.toLowerCase();
      facts.responded = true;
    }

    const body = e.error;
    if (body && typeof body === 'object') {
      const inner = body as ErrorLike;
      if (typeof inner.message === 'string') facts.diagnosis += ` ${inner.message}`;
      if (typeof inner.param === 'string') {
        facts.param ??= inner.param.toLowerCase();
        facts.responded = true;
      }
    }

    if (
      facts.carriedParameter === undefined &&
      e.requestBodyValues &&
      typeof e.requestBodyValues === 'object'
    ) {
      // The AI SDK spells every unset field out as `undefined`, so presence of
      // the key proves nothing and the value has to be read.
      const sent = (e.requestBodyValues as Record<string, unknown>).response_format;
      facts.carriedParameter = sent !== undefined && sent !== null;
    }

    node = e.cause;
  }

  facts.diagnosis = facts.diagnosis.toLowerCase();
  return facts;
}

function unrelated(evidence: string): StructuredFailure {
  return { verdict: 'unrelated', provesRefusal: false, evidence };
}

/**
 * Worth running, and worth believing - unless the stack itself flagged the
 * failure as one a retry may clear, in which case the prompt attempt is also a
 * retry and its success is as much evidence of luck as of a refusal.
 */
function decisive(facts: ErrorFacts, evidence: string): StructuredFailure {
  return facts.retryable === true
    ? ambiguous(`${evidence}, but the stack flagged it retryable`)
    : { verdict: 'testable', provesRefusal: true, evidence };
}

/** Worth running for the object; not evidence of anything about the endpoint. */
function ambiguous(evidence: string): StructuredFailure {
  return { verdict: 'testable', provesRefusal: false, evidence };
}

/**
 * Whether what is in hand is a *server* rejecting `response_format` itself.
 *
 * This is the fact the no-status branch cannot get from the status, because
 * there isn't one, and it is not a matter of vocabulary. Only something that
 * read the request can name a parameter of it and report that parameter as one
 * it will not take: a local `TypeError` does not make that claim, a dead socket
 * does not make it, and a rate limiter blames its own state rather than the
 * request's shape. So the two halves together - the parameter named, and named
 * as rejected - are affirmative evidence of exactly what the ambiguous branch
 * below asks for and cannot otherwise obtain: a server answered, and the
 * request it answered carried the parameter. It still concludes nothing about
 * support. The prompt attempt does that.
 *
 * A machine-readable `param` naming it needs no corroboration: that field is
 * the server's own attribution of the failure to one parameter of the request.
 */
function serverRefusedTheParameter(facts: ErrorFacts): boolean {
  if (facts.param !== undefined && NAMES_STRUCTURED_OUTPUT.test(facts.param)) return true;
  return (
    NAMES_STRUCTURED_OUTPUT.test(facts.diagnosis) &&
    REJECTS_WHAT_THE_REQUEST_CARRIED.test(facts.diagnosis)
  );
}

function statusPrefix(facts: ErrorFacts): string {
  return facts.status === undefined ? 'no status' : `status ${facts.status}`;
}

/**
 * Whether dropping `response_format` is worth trying, and worth believing if it
 * works. Ordered so that the cheap structural facts decide first and the
 * server's prose is only ever a veto:
 *
 *   1. the request never reached a server, so it says nothing about one;
 *   2. the request reached one and the failing request did not even carry the
 *      parameter, so the parameter is not what failed;
 *   3. the status blames a cause the parameter cannot explain;
 *   4. a structured-output contract failure, by type: the reply arrived and did
 *      not honour the schema, which is exactly what "took the parameter and
 *      ignored it" looks like from here. Settled before any prose is read,
 *      because the message of a contract failure quotes the model's own reply
 *      and a reply is not a diagnosis;
 *   5. the error's own words say no server answered;
 *   6. a server named `response_format` as the parameter it rejected. Ahead of
 *      the veto below: between two readings of one message, a rejection of
 *      something the request carried is a claim about that request, while a
 *      bare cause word is a claim about the server's own state, and the
 *      specific one wins. The asymmetry settles the rest - refusing the
 *      experiment here breaks a compatible endpoint outright, while running it
 *      costs one round-trip and a demotion the TTL bounds;
 *   7. the error's own words blame a cause the parameter cannot explain -
 *      consulted for statusless failures too, since a server is free to report
 *      a rate limit or a bad key without one;
 *   8. otherwise the parameter is implicated only if something actually
 *      implicates it. With a status, that is the status itself: the request
 *      shape was rejected. Without one, it takes affirmative evidence that a
 *      server answered *and* that the request it answered carried the
 *      parameter - and even then the failure is unexplained, so the experiment
 *      runs for the object and settles nothing. Anything else - a bare `Error`,
 *      a local `TypeError` - is not evidence about an endpoint and licenses no
 *      second request.
 */
export function classifyStructuredFailure(err: unknown): StructuredFailure {
  if (!err || typeof err !== 'object') return unrelated('not an error object');
  const facts = gatherFacts(err);

  if (facts.transport !== undefined) return unrelated(`transport failure (${facts.transport})`);
  if (facts.carriedParameter === false) {
    return unrelated('failing request did not carry response_format');
  }
  if (facts.status !== undefined && statusBlamesAnotherCause(facts.status)) {
    return unrelated(`status ${facts.status} blames another cause`);
  }
  if (err instanceof StructuredContractError) {
    return decisive(facts, 'server answered, reply held no valid object');
  }
  if (NO_RESPONSE_PHRASE.test(facts.diagnosis)) {
    return unrelated('transport failure (no response)');
  }
  if (serverRefusedTheParameter(facts)) {
    return decisive(facts, `${statusPrefix(facts)}, server named response_format as rejected`);
  }
  if (DIAGNOSIS_BLAMES_ANOTHER_CAUSE.test(facts.diagnosis)) {
    return unrelated(`${statusPrefix(facts)}, and the failure names another cause`);
  }
  if (facts.status === undefined) {
    if (!facts.responded || facts.carriedParameter !== true) {
      return unrelated('no status, and nothing shows a server refusing response_format');
    }
    return ambiguous(
      'server answered a request carrying response_format, without saying what failed',
    );
  }
  return decisive(facts, `status ${facts.status} rejecting the request shape`);
}

/** Which rung a call starts on. */
export type StructuredRung = 'native' | 'prompt';

export interface FallbackMemo {
  /**
   * The rung this call starts on. Claims the single native retry slot when a
   * demotion has lapsed, so one caller re-tests the endpoint per window and
   * the rest stay on the rung that is known to work. Every `native` answer
   * must be settled by exactly one of the three reports below.
   */
  begin(key: string): StructuredRung;
  /** Native produced the object: the scope is healthy, clear any demotion. */
  worked(key: string): void;
  /** Dropping the parameter fixed it: hold this scope on prompt until the TTL lapses. */
  refused(key: string): void;
  /** The attempt proved nothing either way: release the retry slot, change nothing. */
  inconclusive(key: string): void;
  /** Read-only view of the rung the next call would start on. */
  rungFor(key: string): StructuredRung;
  /** Milliseconds until this scope retries native, or null when it is not demoted. */
  retriesNativeIn(key: string): number | null;
  /** Test seam, and what the endpoint probe calls between rungs. */
  reset(): void;
}

interface Demotion {
  until: number;
  /** A caller is past the TTL and re-testing native on everyone else's behalf. */
  retesting: boolean;
}

export function createFallbackMemo(ttlMs: number = STRUCTURED_DEMOTION_TTL_MS): FallbackMemo {
  const demotions = new Map<string, Demotion>();

  const remaining = (key: string): number | null => {
    const demotion = demotions.get(key);
    if (demotion === undefined) return null;
    const left = demotion.until - Date.now();
    return left > 0 ? left : null;
  };

  return {
    begin: (key) => {
      const demotion = demotions.get(key);
      if (demotion === undefined) return 'native';
      if (remaining(key) !== null || demotion.retesting) return 'prompt';
      demotion.retesting = true;
      return 'native';
    },
    worked: (key) => void demotions.delete(key),
    refused: (key) => void demotions.set(key, { until: Date.now() + ttlMs, retesting: false }),
    inconclusive: (key) => {
      const demotion = demotions.get(key);
      if (demotion) demotion.retesting = false;
    },
    rungFor: (key) => (remaining(key) !== null ? 'prompt' : 'native'),
    retriesNativeIn: remaining,
    reset: () => demotions.clear(),
  };
}

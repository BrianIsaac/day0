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

/** Only the host belongs in provider diagnostics; a URL may carry credentials or query values. */
export function providerEndpointLabel(baseUrl?: string): string {
  try {
    return new URL(baseUrl || 'https://api.openai.com').host || '(invalid endpoint)';
  } catch {
    return '(invalid endpoint)';
  }
}

/** How long one proven refusal keeps its scope on the prompt rung. */
export const STRUCTURED_DEMOTION_TTL_MS = 10 * 60 * 1000;

/**
 * Raised when a request completed and the reply carried no valid object. The
 * ladders' own parse and missing-object errors extend this so the classifier
 * can recognise "the server answered and ignored the contract" by type rather
 * than by reading a message.
 */
export class StructuredContractError extends Error {}

/** The longest provider or model text a failure keeps for the card. */
const FAILURE_TEXT_MAX_CHARS = 300;

/** Collapse whitespace and bound a provider's or model's words for a failure reason. */
function failureText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, FAILURE_TEXT_MAX_CHARS);
}

/**
 * Raised when the provider stopped the reply at its output limit. Whatever
 * arrived is incomplete, and a structured reply repaired from it would parse
 * with its last fields missing, so nothing from it is used.
 */
export class ModelReplyCutError extends Error {
  readonly agentName: string;
  /** The start of what arrived, bounded. */
  readonly reply: string;

  constructor(agentName: string, reply: string) {
    super(`${agentName}: the model's reply was cut off at the output limit`);
    this.name = 'ModelReplyCutError';
    this.agentName = agentName;
    this.reply = failureText(reply);
  }
}

/**
 * Raised when the provider refused the content: a `content-filter` finish, or
 * an error the provider's moderation raised. Sending the same request again
 * in either structured mode is refused the same way.
 */
export class ModelRefusalError extends Error {
  readonly agentName: string;
  /** The provider's or the model's words, bounded; empty when it gave none. */
  readonly refusal: string;

  constructor(agentName: string, refusal: string) {
    super(`${agentName}: the model provider refused the request on content grounds`);
    this.name = 'ModelRefusalError';
    this.agentName = agentName;
    this.refusal = failureText(refusal);
  }
}

/**
 * A provider's moderation refusal as providers word it: OpenAI and Azure's
 * `content_filter`, DashScope's `data_inspection_failed`, and the Chinese
 * words the mainland providers use for sensitive or unsafe content and for
 * content review. Read against a server's diagnosis only, never model output.
 */
const MODERATION_REFUSAL =
  /content[_ -]?filter|data[_ -]?inspection|content[_ -]?(?:policy|moderation)|moderation|inappropriate content|敏感|不安全|违规|内容审核|内容安全/;

/** The error an OpenAI-compatible server put inside a 200 reply, as read from its body. */
export interface ErrorInsideOk {
  /** The HTTP-like status the body names, when it names one. */
  status?: number;
  /** The body's own message, bounded. */
  text: string;
}

interface OkBodyErrorLike {
  statusCode?: unknown;
  status?: unknown;
  responseBody?: unknown;
}

function embeddedStatus(...candidates: unknown[]): number | undefined {
  for (const raw of candidates) {
    const value = typeof raw === 'string' && /^\d{3}$/.test(raw.trim()) ? Number(raw) : raw;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
      return value;
    }
  }
  return undefined;
}

/**
 * The error a server answered inside an HTTP 200, when this failure is one.
 *
 * The AI SDK reports such a reply as an API call error with status 200,
 * "Invalid JSON response" as its message and the server's body attached.
 * That message is the SDK's, not the server's; the body says what failed.
 *
 * Args:
 *   node: One error of a cause chain.
 *
 * Returns:
 *   The body's status and message, or undefined when the node is not a 200 carrying an error.
 */
function okBodyError(node: unknown): ErrorInsideOk | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const e = node as OkBodyErrorLike;
  if ((e.statusCode ?? e.status) !== 200 || typeof e.responseBody !== 'string') return undefined;
  let body: unknown;
  try {
    body = JSON.parse(e.responseBody);
  } catch {
    // Not JSON: not an error body this reader can attribute, so not this shape.
    return undefined;
  }
  if (!body || typeof body !== 'object') return undefined;
  const outer = body as Record<string, unknown>;
  const inner =
    outer.error && typeof outer.error === 'object' ? (outer.error as Record<string, unknown>) : {};
  const status = embeddedStatus(
    inner.code,
    inner.status,
    outer.status,
    outer.code,
    outer.status_code,
  );
  if (!outer.error && status === undefined) return undefined;
  return {
    ...(status !== undefined ? { status } : {}),
    text: failureText(bodyMessage(outer) ?? e.responseBody),
  };
}

/** The message an error body carries, in the shapes OpenAI-compatible servers use. */
function bodyMessage(body: Record<string, unknown>): string | undefined {
  const inner =
    body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : {};
  return [
    typeof body.error === 'string' ? body.error : undefined,
    inner.message,
    inner.type,
    typeof inner.code === 'string' ? inner.code : undefined,
    body.message,
    body.msg,
  ].find((part): part is string => typeof part === 'string' && part.trim() !== '');
}

/** A response body's own message when it is a JSON error body, else the body itself, bounded. */
function responseBodyText(responseBody: string): string {
  try {
    const body: unknown = JSON.parse(responseBody);
    if (body && typeof body === 'object') {
      const message = bodyMessage(body as Record<string, unknown>);
      if (message !== undefined) return failureText(message);
    }
  } catch {
    // Not JSON: the body is the server's words as they are.
  }
  return failureText(responseBody);
}

/**
 * The error a server answered inside an HTTP 200 anywhere in a failure's cause chain.
 *
 * @returns The body's status and message, or undefined when the failure is not one.
 */
export function errorInsideOk(err: unknown): ErrorInsideOk | undefined {
  const seen = new Set<unknown>();
  let node: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && node && typeof node === 'object'; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    const inside = okBodyError(node);
    if (inside) return inside;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether a failure is the provider's moderation refusing the request's content.
 *
 * @returns The provider's words when it is, undefined otherwise.
 */
export function moderationRefusal(err: unknown): string | undefined {
  if (err instanceof ModelRefusalError) return err.refusal;
  if (err instanceof StructuredContractError) return undefined;
  const facts = gatherFacts(err);
  if (!facts.responded || !MODERATION_REFUSAL.test(facts.diagnosis)) return undefined;
  // Moderation answers as a request error; a rate limit or an outage that
  // happens to mention it is still transient and keeps its retries.
  if (facts.status !== undefined && (facts.status === 429 || facts.status >= 500)) return undefined;
  return failureText(facts.serverText || facts.diagnosis);
}

/** The schema's reasons a contract error carries: a refused reply's issues, say "the plan had 9 steps; the most is 8". */
function schemaIssuesOf(err: StructuredContractError): string[] {
  if (!('issues' in err) || !Array.isArray(err.issues)) return [];
  return err.issues.filter((issue: unknown): issue is string => typeof issue === 'string');
}

/** The opening of the reply a contract error kept, when it kept one. */
function replyOf(err: StructuredContractError): string {
  return 'reply' in err && typeof err.reply === 'string' ? err.reply : '';
}

/** Statuses that say the provider rejected this request as sent, not its own condition. */
const REQUEST_REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);

/**
 * What a failed model call says about the work item it was for, when it is
 * about the item rather than the provider's condition: a content refusal, a
 * reply cut at the output limit, a reply with no usable object after the
 * ladder's own repairs, or a request the provider rejected with a reason.
 * Rate limits, outages, credentials and transport failures return undefined:
 * they pass or get fixed without the item changing, so the caller leaves the
 * item to be tried again.
 *
 * @returns A sentence for the card, or undefined when the failure is not the item's.
 */
export function itemBoundModelFailure(err: unknown): string | undefined {
  if (err instanceof ModelReplyCutError) return "the model's reply was cut off at the output limit";
  const refusal = moderationRefusal(err);
  if (refusal !== undefined) {
    return refusal
      ? `the model provider refused the request on content grounds: ${refusal}`
      : 'the model provider refused the request on content grounds';
  }
  if (err instanceof StructuredContractError) {
    const said = failureText(schemaIssuesOf(err).join('; ') || replyOf(err));
    return said
      ? `the model's reply held no valid structured object: ${said}`
      : "the model's reply held no valid structured object";
  }
  const facts = gatherFacts(err);
  if (facts.transport !== undefined) return undefined;
  const inside = errorInsideOk(err);
  const status = facts.status ?? inside?.status;
  if (status === undefined || !REQUEST_REJECTED_STATUSES.has(status)) return undefined;
  const said = inside?.text ?? facts.serverText;
  return said
    ? `the model provider rejected the request (status ${status}): ${said}`
    : `the model provider rejected the request (status ${status})`;
}

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
  /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPROTO|CERT_|DEPTH_ZERO|UND_ERR_|ERR_CANCELED|ABORT_ERR)/;

/**
 * The same thing reported as an error class rather than a code. A call the
 * caller withdrew produced no server opinion of `response_format` either.
 */
const TRANSPORT_FAILURE_NAME = /^(AbortError|TimeoutError|CanceledError|CancelledError)$/;

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
 * stacks that report them with no status at all. Deliberately generous, which
 * it can afford to be because it is consulted only after the refusal shape
 * above has had its say: a bare "unavailable" can veto an otherwise unexplained
 * failure without being able to veto a server that named `response_format` as
 * the thing it would not take. Only ever consulted against a *server's*
 * diagnosis of a failed request, never against model output, so an agent that
 * happens to write "permission" into a reply cannot veto its own fallback.
 */
const DIAGNOSIS_BLAMES_ANOTHER_CAUSE =
  /rate.?limit|too many requests|quota|insufficient_quota|resource.?exhausted|billing|api key|unauthori[sz]ed|authenticat|permission|context.?length|maximum context|reduce the length|too long|too many tokens|overload|unavailable|timeout|timed out|deadline.?exceeded|temporarily|cancell?ed|cancell?ation|aborted/;

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
  /** The server's own words, from a response body or an error body's message, bounded and in the original case. */
  serverText: string;
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
  const facts: ErrorFacts = { diagnosis: '', responded: false, serverText: '' };
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
    if (
      facts.transport === undefined &&
      typeof e.name === 'string' &&
      TRANSPORT_FAILURE_NAME.test(e.name)
    ) {
      facts.transport = e.name;
    }
    const inside = okBodyError(node);
    if (inside) {
      // An error inside a 200 is classed by the status its body names; the
      // SDK's "Invalid JSON response" is its own word, not the server's.
      if (facts.status === undefined && inside.status !== undefined) facts.status = inside.status;
      facts.diagnosis += ` ${inside.text}`;
      facts.serverText ||= inside.text;
    } else {
      if (typeof e.message === 'string') facts.diagnosis += ` ${e.message}`;
      if (typeof e.responseBody === 'string') {
        facts.diagnosis += ` ${e.responseBody}`;
        facts.serverText ||= responseBodyText(e.responseBody);
      }
    }
    // `param` belongs to the OpenAI error *body*, so a client only ever holds
    // one because a server sent it: its presence is itself a response.
    if (typeof e.param === 'string') {
      facts.param ??= e.param.toLowerCase();
      facts.responded = true;
    }

    const body = e.error;
    if (body && typeof body === 'object') {
      const inner = body as ErrorLike;
      if (typeof inner.message === 'string') {
        facts.diagnosis += ` ${inner.message}`;
        facts.serverText ||= failureText(inner.message);
      }
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
 *   3. the status blames a cause the parameter cannot explain - except a
 *      rate limit or server error repeated after the retry wrapper's attempts
 *      on a request carrying the parameter, which earns one request without
 *      it and proves nothing;
 *   4. a structured-output contract failure, by type: the reply arrived and did
 *      not honour the schema, which is exactly what "took the parameter and
 *      ignored it" looks like from here. Settled before any prose is read,
 *      because the message of a contract failure quotes the model's own reply
 *      and a reply is not a diagnosis;
 *   5. the error's own words say no server answered, or name the provider's
 *      moderation refusing the content;
 *   6. a server named `response_format` as the parameter it rejected. Ahead of
 *      the veto below, and the reason the veto can be worded loosely: between
 *      two readings of one message, a rejection of something the request
 *      carried is a claim about that request, while a bare cause word is a
 *      claim about the server's own state, and the specific one wins. The
 *      asymmetry settles the rest - refusing the experiment here breaks a
 *      compatible endpoint outright, while running it costs one round-trip and
 *      a demotion the TTL bounds;
 *   7. the error's own words blame a cause the parameter cannot explain -
 *      consulted for statusless failures too, since a server is free to report
 *      a rate limit or a bad key without one;
 *   8. otherwise the parameter is implicated only if something actually
 *      implicates it. With a status, that is the status itself when the
 *      server said nothing else, or a body rejecting something the request
 *      carried; a body that rejects nothing it carried (a reason in another
 *      language, a message about the content) is its own reason and licenses
 *      no second request. Without a status, it takes affirmative evidence that a
 *      server answered *and* that the request it answered carried the
 *      parameter - and even then the failure is unexplained, so the experiment
 *      runs for the object and settles nothing. Anything else - a bare `Error`,
 *      a local `TypeError` - is not evidence about an endpoint and licenses no
 *      second request.
 */
export function classifyStructuredFailure(err: unknown): StructuredFailure {
  if (!err || typeof err !== 'object') return unrelated('not an error object');
  if (err instanceof ModelReplyCutError) return unrelated('reply cut at the output limit');
  if (err instanceof ModelRefusalError) return unrelated('the provider refused the content');
  const facts = gatherFacts(err);

  if (facts.transport !== undefined) return unrelated(`transport failure (${facts.transport})`);
  if (facts.carriedParameter === false) {
    return unrelated('failing request did not carry response_format');
  }
  if (facts.status !== undefined && statusBlamesAnotherCause(facts.status)) {
    // The retry wrapper has already sent it again, so this is a repeat. A
    // provider that answers `json_schema` with "busy" never says why, and one
    // request without the parameter costs little against a run that stops.
    if (facts.carriedParameter === true && (facts.status === 429 || facts.status >= 500)) {
      return ambiguous(`repeated status ${facts.status} to a request carrying response_format`);
    }
    return unrelated(`status ${facts.status} blames another cause`);
  }
  if (err instanceof StructuredContractError) {
    return decisive(facts, 'server answered, reply held no valid object');
  }
  if (NO_RESPONSE_PHRASE.test(facts.diagnosis)) {
    return unrelated('transport failure (no response)');
  }
  if (MODERATION_REFUSAL.test(facts.diagnosis)) {
    return unrelated(`${statusPrefix(facts)}, the provider refused the content`);
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
  // A status alone (a proxy's bare 422) implicates the request's shape. A body
  // that rejects nothing the request carried, in any language, is a failure
  // with its own reason, and the same request in prompt mode fails the same way.
  if (facts.serverText && !REJECTS_WHAT_THE_REQUEST_CARRIED.test(facts.diagnosis)) {
    return unrelated(
      `status ${facts.status}, and the server's answer rejects nothing the request carried`,
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

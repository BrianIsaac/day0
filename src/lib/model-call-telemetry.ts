/**
 * Telemetry for the model calls a loop step makes.
 *
 * A step installs an observer once around its work with `observeModelCalls`;
 * the retry wrapper in `./mastra` reports every call that passes through it
 * to that observer, however deep the call sits, and concurrent steps in one
 * process each see their own. The observer is carried on the async context
 * rather than threaded through every domain function, so a new call site
 * is observed without anyone remembering to plumb it.
 *
 * This lives apart from the wrapper so that a test which replaces the model
 * layer wholesale still has the real seam the loop step installs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from './logger';

/**
 * What one model call through the retry wrapper came to.
 *
 * This is what a loop step puts on the item's ledger, so it names the agent
 * and the failure's class and status, and nothing else: no prompt, no reply,
 * and no error message, which a provider fills with either.
 */
export interface ModelCallReport {
  /** The Mastra agent's name, or the label a bare retry was given. */
  agent: string;
  /** Provider calls made, the last one included. */
  attempts: number;
  /** Attempts that followed a transient failure. */
  retries: number;
  /** Wall-clock from the first attempt to the outcome, the back-off included. */
  durationMs: number;
  outcome: 'ok' | 'failed' | 'timed-out';
  /** The thrown error's class name, when it was an Error. */
  errorName?: string;
  /** The HTTP status the provider answered, when the error carried one. */
  statusCode?: number;
  /**
   * Requests this call actually sent to the provider, when the provider
   * client counted them. Higher than `attempts` when the model SDK retried
   * inside one of ours, which is the difference between a slow call and a
   * retried one.
   */
  providerCalls?: number;
  /** How a structured call asked for its object: the schema on the wire, or in the prompt. */
  structuredMode?: StructuredMode;
  /** On the prompt-rung call that followed a native attempt which produced no object. */
  fellBack?: true;
  /**
   * On that call when it succeeded and the native failure proved the endpoint
   * would not honour the schema: the agent's later calls start on the prompt
   * rung until the demotion expires. This is the mode flip P8-4 found recorded
   * nowhere a person looks.
   */
  demoted?: true;
}

/**
 * How a structured object is asked for.
 *
 *   native: the schema goes down the wire as `response_format`
 *           (`json_schema` for providers that advertise strict mode).
 *   prompt: Mastra injects the schema into the system prompt instead
 *           and parses the object back out of the reply text.
 *
 * `./mastra` runs the ladder between them, the twin of the one in
 * `./openai`, driven by the same `OPENAI_JSON_MODE` switch.
 */
export type StructuredMode = 'native' | 'prompt';

/** What a structured call adds to its report. */
export interface StructuredCallFacts {
  readonly mode: StructuredMode;
  /** The call follows a native attempt that produced no object. */
  readonly fellBack?: boolean;
  /** Its success moves the agent onto the prompt rung. */
  readonly demotes?: boolean;
}

/** Everything the retry wrapper knows about one completed call. */
export interface ModelCallFacts {
  /** The agent name or retry label. */
  readonly agent: string;
  /** Provider calls made, the last one included. */
  readonly attempts: number;
  /** When the first attempt began. */
  readonly startedAt: number;
  /** Requests the provider client counted, or 0 when it did not. */
  readonly providerCalls: number;
  /** What the last attempt threw, when the call failed. */
  readonly failure?: { readonly error: unknown };
  readonly structured?: StructuredCallFacts;
}

export type ModelCallObserver = (report: ModelCallReport) => void | Promise<void>;

/**
 * The observer the enclosing loop step installed, if any.
 *
 * One storage per process, held on the global object, so that two evaluated
 * copies of this module (a test that resets the module registry around a
 * mocked model layer, or a bundle that splits it) still share the context
 * the step installed.
 */
const STORAGE_KEY = Symbol.for('day0.model-call-observers');
const modelCallObservers: AsyncLocalStorage<ModelCallObserver> = ((
  globalThis as { [STORAGE_KEY]?: AsyncLocalStorage<ModelCallObserver> }
)[STORAGE_KEY] ??= new AsyncLocalStorage<ModelCallObserver>());
const REQUIRED_KEY = Symbol.for('day0.model-call-observer-required');
const requiredObserverScopes: AsyncLocalStorage<boolean> = ((
  globalThis as { [REQUIRED_KEY]?: AsyncLocalStorage<boolean> }
)[REQUIRED_KEY] ??= new AsyncLocalStorage<boolean>());

/**
 * Run a loop step with every model call inside it reported to `observer`.
 *
 * Args:
 *   observer: Receives one report per completed call, success or failure.
 *     Its own failure is logged and never fails the call it observed.
 *   fn: The step.
 *
 * Returns:
 *   Whatever the step returns.
 */
export async function observeModelCalls<T>(
  observer: ModelCallObserver,
  fn: () => Promise<T>,
): Promise<T> {
  return await requiredObserverScopes.run(true, () => modelCallObservers.run(observer, fn));
}

/** A live count of the provider requests one model call has sent. */
export interface ProviderRequestCounter {
  count: number;
}

/**
 * Count the provider requests one model call sends, for its report.
 *
 * The counter is passed in rather than returned, because the report is
 * written from inside the call - on the attempt that settled it - rather than
 * after it.
 *
 * Args:
 *   counter: Incremented once per provider request the call sends.
 *   fn: The call, its retries included.
 *
 * Returns:
 *   What the call returned.
 */
export async function countingProviderRequests<T>(
  counter: ProviderRequestCounter,
  fn: () => Promise<T>,
): Promise<T> {
  return await providerRequestCounts.run(counter, fn);
}

/**
 * Provider requests counted for the call the current async context is in.
 *
 * The model SDK retries a 429 or a 503 twice of its own accord inside one
 * attempt of the wrapper's, so without this a call that spent minutes on
 * three requests reads as one slow call. The provider client increments
 * this per request it sends; nothing about the request is recorded.
 */
const REQUEST_COUNT_KEY = Symbol.for('day0.provider-request-counts');
const providerRequestCounts: AsyncLocalStorage<ProviderRequestCounter> = ((
  globalThis as { [REQUEST_COUNT_KEY]?: AsyncLocalStorage<ProviderRequestCounter> }
)[REQUEST_COUNT_KEY] ??= new AsyncLocalStorage<ProviderRequestCounter>());

/** Count one provider request against the model call in progress. */
export function countProviderRequest(): void {
  const counter = providerRequestCounts.getStore();
  if (counter) counter.count += 1;
}

/**
 * The error classes a report may name: the product's own typed failures,
 * whose names carry no provider or model text. Anything else is `Error`.
 */
const REPORTED_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TimeoutError',
  'StructuredOutputMissingError',
  'StructuredOutputInvalidError',
  'ModelRefusalError',
  'ModelReplyCutError',
]);

function reportFor(facts: ModelCallFacts): ModelCallReport {
  const structured = facts.structured;
  const report: ModelCallReport = {
    agent: facts.agent,
    attempts: facts.attempts,
    retries: facts.attempts - 1,
    durationMs: Date.now() - facts.startedAt,
    outcome: 'ok',
    ...(facts.providerCalls > 0 ? { providerCalls: facts.providerCalls } : {}),
    ...(structured ? { structuredMode: structured.mode } : {}),
    ...(structured?.fellBack ? { fellBack: true as const } : {}),
    ...(structured?.demotes && facts.failure === undefined ? { demoted: true as const } : {}),
  };
  if (facts.failure === undefined) return report;
  const err = facts.failure.error;
  const errorName =
    err instanceof Error ? (REPORTED_ERROR_NAMES.has(err.name) ? err.name : 'Error') : undefined;
  report.outcome = errorName === 'TimeoutError' ? 'timed-out' : 'failed';
  if (errorName !== undefined) report.errorName = errorName;
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number') report.statusCode = statusCode;
  return report;
}

/**
 * Report one completed call to the enclosing step's observer, if there is one.
 *
 * @param facts - What the retry wrapper knows about the call.
 * @throws Error when a step required an observer and none is installed.
 */
export async function reportModelCall(facts: ModelCallFacts): Promise<void> {
  const observer = modelCallObservers.getStore();
  if (!observer) {
    if (requiredObserverScopes.getStore())
      throw new Error('model-call observer missing in an observed scope');
    return;
  }
  try {
    await observer(reportFor(facts));
  } catch (err) {
    // The observer's failure never fails the call it observed.
    log.warn('model-call observer failed', {
      agent: facts.agent,
      error: err instanceof Error ? err.name : typeof err,
    });
  }
}

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
export async function observeModelCalls<T>(observer: ModelCallObserver, fn: () => Promise<T>): Promise<T> {
  return await modelCallObservers.run(observer, fn);
}

function reportFor(agent: string, attempts: number, startedAt: number, err?: unknown): ModelCallReport {
  const report: ModelCallReport = {
    agent,
    attempts,
    retries: attempts - 1,
    durationMs: Date.now() - startedAt,
    outcome: 'ok',
  };
  if (err === undefined) return report;
  const error = err as { name?: unknown; statusCode?: unknown };
  const errorName = err instanceof Error ? err.name : undefined;
  report.outcome = errorName === 'TimeoutError' ? 'timed-out' : 'failed';
  if (errorName !== undefined) report.errorName = errorName;
  if (typeof error.statusCode === 'number') report.statusCode = error.statusCode;
  return report;
}

/**
 * Report one completed call to the enclosing step's observer, if there is one.
 *
 * Args:
 *   agent: The agent name or retry label.
 *   attempts: Provider calls made.
 *   startedAt: When the first attempt began.
 *   err: What the last attempt threw, when the call failed.
 */
export async function reportModelCall(
  agent: string,
  attempts: number,
  startedAt: number,
  err?: unknown,
): Promise<void> {
  const observer = modelCallObservers.getStore();
  if (!observer) return;
  try {
    await observer(reportFor(agent, attempts, startedAt, err));
  } catch (observerError) {
    console.warn(`[mastra] model-call observer failed for ${agent}`, observerError);
  }
}


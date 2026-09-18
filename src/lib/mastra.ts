import { AsyncLocalStorage } from 'node:async_hooks';
import { schemaRepairPrompt, type StructuredOutputDiagnostics } from './structured-repair';
import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { env } from '../env';
import { languageModel, MODEL, modelProviderClient } from './openai';
import { log } from './logger';
import {
  classifyStructuredFailure,
  createFallbackMemo,
  StructuredContractError,
} from './structured-fallback';

/**
 * Mastra-fronted agent helpers.
 *
 * Each domain function (charter synthesis, quality-fit, plan drafting,
 * skill execution, skill authoring, transcript extraction, good-habits
 * distillation) constructs a named Mastra Agent at module load. This
 * makes the named agents visible in Mastra observability + Langfuse
 * traces so the framework's role in the call graph is concrete rather
 * than incidental.
 *
 * Both helpers retry on transient model errors (503 service overloads,
 * generic API errors flagged `isRetryable`). The Mastra/AI-SDK default
 * is two retries on top of the initial attempt — that has not been
 * enough during demo windows when the provider is hot. We wrap with
 * exponential backoff up to five attempts so the loop survives a flake.
 */

/**
 * Model handed to every Mastra Agent.
 *
 * The shared resolver routes hosted OpenAI through Responses and custom
 * OpenAI-compatible endpoints through chat completions. Both evaluation arms
 * and every shipped Mastra agent receive this same lazy model configuration.
 */
export const MODEL_CONFIG = Object.assign(
  (): MastraModelConfig => languageModel() as MastraModelConfig,
  { provider: modelProviderClient() },
);

/** Shared sampling setting for the shipped agent and the evaluation control. */
export const MODEL_TEMPERATURE = 0.4;
export const MODEL_CALL_TIMEOUT_MS = 300_000;
export const MODEL_PROVIDER_MAX_RETRIES = 2;

export interface ModelCallSettings {
  maxOutputTokens?: number;
  reasoningEffort?: typeof env.OPENAI_REASONING_EFFORT;
}

export function modelCallOptions(overrides: ModelCallSettings = {}) {
  const maxOutputTokens = overrides.maxOutputTokens ?? env.OPENAI_MAX_OUTPUT_TOKENS;
  const reasoningEffort = overrides.reasoningEffort ?? env.OPENAI_REASONING_EFFORT;
  return {
    modelSettings: {
      temperature: MODEL_TEMPERATURE,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
    ...(reasoningEffort === undefined ? {} : { providerOptions: { openai: { reasoningEffort } } }),
  };
}

function modelAbortSignal(): AbortSignal {
  return AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS);
}

export const MODEL_RETRY_POLICY = {
  maxAttempts: 5,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  retryableStatusCodes: [429, 503],
  retryableMessagePattern: 'overload|service_unavailable|503|temporar|rate.?limit',
} as const;

function isTransientApiError(err: unknown): boolean {
  if (err instanceof StructuredContractError) return false;
  if (!err || typeof err !== 'object') return false;
  const e = err as { isRetryable?: boolean; message?: unknown; statusCode?: number };
  if (e.isRetryable === true) return true;
  if (
    typeof e.statusCode === 'number' &&
    (MODEL_RETRY_POLICY.retryableStatusCodes as readonly number[]).includes(e.statusCode)
  ) {
    return true;
  }
  const msg = String(e.message ?? '');
  return new RegExp(MODEL_RETRY_POLICY.retryableMessagePattern, 'i').test(msg);
}

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
 * The observer the enclosing loop step installed, carried on the async
 * context rather than threaded through every domain function: a step
 * installs it once around its work, and every call that passes the retry
 * wrapper inside that work, however deep, reports to it. Concurrent steps
 * in one process each see their own.
 */
const modelCallObservers = new AsyncLocalStorage<ModelCallObserver>();

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

async function report(agent: string, attempts: number, startedAt: number, err?: unknown): Promise<void> {
  const observer = modelCallObservers.getStore();
  if (!observer) return;
  try {
    await observer(reportFor(agent, attempts, startedAt, err));
  } catch (observerError) {
    console.warn(`[mastra] model-call observer failed for ${agent}`, observerError);
  }
}

async function withRetry<T>(
  call: { label: string; agent: string },
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt < MODEL_RETRY_POLICY.maxAttempts; attempt++) {
    try {
      const value = await fn();
      await report(call.agent, attempt + 1, startedAt);
      return value;
    } catch (err) {
      lastErr = err;
      if (!isTransientApiError(err) || attempt === MODEL_RETRY_POLICY.maxAttempts - 1) {
        await report(call.agent, attempt + 1, startedAt, err);
        throw err;
      }
      const delay = Math.min(
        MODEL_RETRY_POLICY.baseDelayMs * 2 ** attempt,
        MODEL_RETRY_POLICY.maxDelayMs,
      );
      console.warn(
        `[mastra] ${call.label} attempt ${attempt + 1} hit transient error; retrying in ${delay}ms`,
        err,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Apply the same transient provider retry policy to any Mastra generation shape. */
export async function withModelRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return await withRetry({ label, agent: label }, fn);
}

export function makeAgent(name: string, instructions: string): Agent {
  return new Agent({
    id: name,
    name,
    instructions,
    model: MODEL_CONFIG,
    maxRetries: MODEL_PROVIDER_MAX_RETRIES,
  });
}

/**
 * How Mastra is asked to produce the object.
 *
 *   native — the schema goes down the wire as `response_format`
 *            (`json_schema` for providers that advertise strict mode).
 *   prompt — Mastra injects the schema into the system prompt instead
 *            and parses the object back out of the reply text.
 *
 * This is the Mastra-side twin of the ladder in `src/lib/openai.ts`,
 * driven by the same `OPENAI_JSON_MODE` switch so one variable
 * describes the whole model layer.
 */
export type StructuredMode = 'native' | 'prompt';

/**
 * Raised when the server accepted the request and returned no object. Mastra
 * more often raises its own inside `agent.generate()` first - a schema
 * validation failure against the prose-prefixed text a server returns when it
 * takes `response_format` and ignores it - which is what the error below
 * translates, so that both routes reach the classifier as the same kind of
 * failure.
 */
export class StructuredOutputMissingError extends StructuredContractError {
  constructor(
    readonly agentName: string,
    readonly mode: StructuredMode,
  ) {
    super(`agentJson(${agentName}): model returned no structured object in ${mode} mode`);
    this.name = 'StructuredOutputMissingError';
  }
}

/**
 * Raised when Mastra's own schema validation rejected the reply. Same fact as
 * the error above - a request completed and the reply did not honour the
 * contract - reached by a different route, so it is typed as the same kind of
 * failure.
 */
export class StructuredOutputInvalidError extends StructuredContractError {
  constructor(
    readonly agentName: string,
    readonly mode: StructuredMode,
    cause: unknown,
  ) {
    super(`agentJson(${agentName}): ${mode} reply did not satisfy the schema`, { cause });
    this.name = 'StructuredOutputInvalidError';
  }
}

/**
 * Mastra validates the reply against the schema inside `agent.generate()`, so a
 * server that takes `response_format` and returns prose-prefixed JSON anyway
 * fails there, before the missing-object check below can see it. That error
 * carries no HTTP status and nothing else that distinguishes it from a bad key
 * or a local bug - only this id does, and the classifier admits a statusless
 * failure on affirmative evidence alone. Recognising the id here rather than in
 * the shared classifier keeps Mastra's private error vocabulary on the Mastra
 * side of the seam.
 */
function isMastraSchemaViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    (err as { id?: unknown }).id === 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED'
  );
}

/**
 * Which agents have had native structured output declined, and until when.
 * Keyed by endpoint, model and agent because that is the scope the evidence
 * covers: each Mastra agent carries one schema shape, and a strict schema the
 * server will not compile says nothing about the other six domain agents. The
 * entry expires, so a transient refusal costs one degraded window rather than
 * every charter, plan, evaluator and executor call for the life of the process.
 */
const structuredModeMemo = createFallbackMemo();

function structuredModeKey(agentName: string): string {
  return `${env.OPENAI_BASE_URL ?? 'api.openai.com'}|${MODEL}|${agentName}`;
}

/** The rung the next `auto` call will start on for this agent. */
export function structuredModeFor(agentName: string): StructuredMode {
  return structuredModeMemo.rungFor(structuredModeKey(agentName));
}

/** Test seam, and what the endpoint probe calls between rungs. */
export function resetStructuredModeMemo(): void {
  structuredModeMemo.reset();
}

/** The strategy this call is pinned to, or undefined when the ladder is free to move. */
function pinnedStructuredMode(override?: StructuredMode): StructuredMode | undefined {
  if (override) return override;
  return env.OPENAI_JSON_MODE === 'auto' ? undefined : env.OPENAI_JSON_MODE;
}

export interface AgentJsonArgs extends ModelCallSettings {
  agent: Agent;
  user: string;
  schema: unknown;
  /** Pin the strategy for this call, overriding `OPENAI_JSON_MODE`. */
  mode?: StructuredMode;
}

export interface AgentJsonResult<T> {
  value: T;
  /** Which strategy actually produced the object. */
  mode: StructuredMode;
  /** True when `native` was attempted first and had to be abandoned. */
  fellBack: boolean;
  /** Provider call warnings returned with the generation that produced the value. */
  providerWarnings: string[];
}

interface GeneratedObject<T> {
  value: T;
  providerWarnings: string[];
}

/** Flatten provider warning objects into stable, evidence-safe text. */
export function providerWarningTexts(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  const rendered = warnings
    .map((warning): string | null => {
      if (typeof warning === 'string') return warning.trim() || null;
      if (!warning || typeof warning !== 'object') return String(warning);
      const row = warning as { type?: unknown; feature?: unknown; details?: unknown };
      const type = typeof row.type === 'string' ? row.type.trim() : 'provider warning';
      const feature = typeof row.feature === 'string' ? row.feature.trim() : '';
      const details = typeof row.details === 'string' ? row.details.trim() : '';
      const heading = feature ? `${type} (${feature})` : type;
      return details ? `${heading}: ${details}` : heading;
    })
    .filter((warning): warning is string => Boolean(warning));
  return [...new Set(rendered)];
}

/**
 * The Mastra twin of `jsonCompleteWithMode`, and the same experiment: when a
 * native attempt fails for a reason `response_format` could explain, the prompt
 * attempt is what settles whether it did, and only its success demotes the
 * agent. A failure the parameter cannot explain - a rate limit, a bad key, a
 * 5xx, anything statusless that nothing ties to the endpoint - is rethrown
 * untried, because prompt injection recovers from none of them and would only
 * bury the real cause under a second failure. Where the parameter is implicated
 * but the failure could also have cleared on its own, the object is fetched and
 * no demotion is recorded: the two calls are separated in time and this ladder
 * cannot tell a refusal from a coincidence.
 */
export async function agentJsonWithMode<T>(args: AgentJsonArgs): Promise<AgentJsonResult<T>> {
  const pinned = pinnedStructuredMode(args.mode);
  if (pinned) {
    const generated = await generateObject<T>(args, pinned);
    return {
      value: generated.value,
      mode: pinned,
      fellBack: false,
      providerWarnings: generated.providerWarnings,
    };
  }

  const key = structuredModeKey(args.agent.name);
  const endpoint = env.OPENAI_BASE_URL ?? 'api.openai.com';
  if (structuredModeMemo.begin(key) === 'prompt') {
    const generated = await generateObject<T>(args, 'prompt');
    return {
      value: generated.value,
      mode: 'prompt',
      fellBack: false,
      providerWarnings: generated.providerWarnings,
    };
  }

  let native: GeneratedObject<T>;
  try {
    native = await generateObject<T>(args, 'native');
  } catch (err) {
    const failure = classifyStructuredFailure(err);
    if (failure.verdict === 'unrelated') {
      structuredModeMemo.inconclusive(key);
      log.warn('structured-output: native failed for a reason prompt injection cannot fix', {
        agent: args.agent.name,
        baseUrl: endpoint,
        model: MODEL,
        evidence: failure.evidence,
        cause: (err as Error).message,
        hint: 'set OPENAI_JSON_MODE=prompt to pin the fallback if this server never honours it',
      });
      throw err;
    }
    let generated: GeneratedObject<T>;
    try {
      generated = await generateObject<T>(args, 'prompt');
    } catch (withoutParameter) {
      structuredModeMemo.inconclusive(key);
      log.warn(
        'structured-output: prompt injection failed the same way, so response_format was not the cause',
        {
          agent: args.agent.name,
          baseUrl: endpoint,
          model: MODEL,
          evidence: failure.evidence,
          cause: (err as Error).message,
          promptModeCause: (withoutParameter as Error).message,
        },
      );
      throw err;
    }
    if (!failure.provesRefusal) {
      // The object is in hand, which is what the caller needed, but the native
      // failure was consistent with a passing condition and the two calls are
      // separated in time. Demoting on that would hold every later call for
      // this agent on the degraded rung on the strength of a coincidence.
      structuredModeMemo.inconclusive(key);
      log.warn(
        'structured-output: prompt injection produced the object, but the native failure does not prove response_format was the cause; not demoting',
        {
          agent: args.agent.name,
          baseUrl: endpoint,
          model: MODEL,
          evidence: failure.evidence,
          cause: (err as Error).message,
        },
      );
      return {
        value: generated.value,
        mode: 'prompt',
        fellBack: true,
        providerWarnings: generated.providerWarnings,
      };
    }
    structuredModeMemo.refused(key);
    log.warn(
      'structured-output fallback: native response_format failed, prompt injection produced the object',
      {
        agent: args.agent.name,
        baseUrl: endpoint,
        model: MODEL,
        evidence: failure.evidence,
        cause: (err as Error).message,
        retriesNativeInMs: structuredModeMemo.retriesNativeIn(key),
      },
    );
    return {
      value: generated.value,
      mode: 'prompt',
      fellBack: true,
      providerWarnings: generated.providerWarnings,
    };
  }
  structuredModeMemo.worked(key);
  return {
    value: native.value,
    mode: 'native',
    fellBack: false,
    providerWarnings: native.providerWarnings,
  };
}

export async function agentJson<T>(args: AgentJsonArgs): Promise<T> {
  return (await agentJsonWithMode<T>(args)).value;
}

async function generateObject<T>(
  args: AgentJsonArgs,
  mode: StructuredMode,
): Promise<GeneratedObject<T>> {
  const startedAt = new Date().toISOString();
  const maxRepairs = mode === 'prompt' ? env.OPENAI_STRUCTURED_REPAIR_ATTEMPTS : 0;
  const diagnostics: StructuredOutputDiagnostics = {
    version: 1,
    id: crypto.randomUUID(),
    agent: args.agent.name,
    mode,
    startedAt,
    finishedAt: startedAt,
    firstReplyValid: null,
    validationFailures: 0,
    repairAttempts: 0,
    coercions: 0,
    outcome: 'failed',
  };
  let user = args.user;
  try {
    for (;;) {
      try {
        const result = await withRetry(
          { label: `agentJson(${args.agent.name})`, agent: args.agent.name },
          () => generateObjectOnce<T>({ ...args, user }, mode),
        );
        if (diagnostics.firstReplyValid === null) diagnostics.firstReplyValid = true;
        diagnostics.outcome = 'valid';
        return result;
      } catch (error) {
        if (!(error instanceof StructuredOutputInvalidError)) throw error;
        diagnostics.firstReplyValid = false;
        diagnostics.validationFailures += 1;
        if (diagnostics.repairAttempts >= maxRepairs) throw error;
        const cause = error.cause as { message?: unknown; details?: { value?: unknown } };
        // Mastra owns parsing/validation. Its rejected value and error are the
        // evidence for a repair; neither licenses manufacturing missing actions.
        const rejected = cause?.details?.value;
        user = schemaRepairPrompt(
          args.user,
          typeof cause?.message === 'string' ? cause.message : error.message,
          typeof rejected === 'string' ? rejected : undefined,
        );
        diagnostics.repairAttempts += 1;
      }
    }
  } finally {
    diagnostics.finishedAt = new Date().toISOString();
    log.info('structured-output-call', { diagnostics });
  }
}

async function generateObjectOnce<T>(
  args: AgentJsonArgs,
  mode: StructuredMode,
): Promise<GeneratedObject<T>> {
  const signal = modelAbortSignal();
  const startedAt = Date.now();
  const timedOut = (): boolean => signal.aborted || Date.now() - startedAt >= MODEL_CALL_TIMEOUT_MS;
  const timeoutError = (cause?: unknown): Error => {
    const error = new Error(
      `agentJson(${args.agent.name}): ${mode} model call reached the ${MODEL_CALL_TIMEOUT_MS}ms timeout`,
      cause === undefined ? undefined : { cause },
    );
    error.name = 'TimeoutError';
    return error;
  };
  let response;
  try {
    response = await args.agent.generate(args.user, {
      abortSignal: signal,
      ...modelCallOptions(args),
      // Zod 4 schemas pass through Mastra's PublicSchema bridge; the cast
      // sidesteps the v4-vs-v3 peer-dep nuance without losing the
      // runtime validation Mastra performs against the schema.
      structuredOutput: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        schema: args.schema as any,
        jsonPromptInjection: mode === 'prompt',
      },
    });
  } catch (err) {
    if (timedOut()) throw timeoutError(err);
    if (isMastraSchemaViolation(err)) {
      throw new StructuredOutputInvalidError(args.agent.name, mode, err);
    }
    throw err;
  }
  const resultError = (response as { error?: unknown }).error;
  if (timedOut()) throw timeoutError(resultError);
  if (resultError !== undefined && resultError !== null) {
    if (resultError instanceof Error) throw resultError;
    throw new Error(
      `agentJson(${args.agent.name}): ${mode} generation failed: ${String(resultError)}`,
    );
  }
  const finishReason = (response as { finishReason?: unknown }).finishReason;
  if (finishReason === 'error') {
    throw new Error(`agentJson(${args.agent.name}): ${mode} generation finished with an error`);
  }
  // Mastra reports a withdrawn call as a tripwire with no object; observed
  // shape for an aborted native call: finishReason 'tripwire', no error, no
  // text. The abort wall is handled above; any other tripwire is Mastra's own
  // processor stopping the run, which is not a server refusing the schema.
  if (finishReason === 'tripwire') {
    const tripwire = (response as { tripwire?: unknown }).tripwire;
    const reason =
      tripwire && typeof tripwire === 'object' && 'reason' in tripwire
        ? String((tripwire as { reason?: unknown }).reason)
        : 'no reason given';
    throw new Error(
      `agentJson(${args.agent.name}): ${mode} generation was stopped by a tripwire (${reason})`,
    );
  }
  const object = response.object as T | undefined;
  if (object === undefined || object === null) {
    throw new StructuredOutputMissingError(args.agent.name, mode);
  }
  return {
    value: object,
    providerWarnings: providerWarningTexts((response as { warnings?: unknown }).warnings),
  };
}

export async function agentText(
  args: { agent: Agent; user: string } & ModelCallSettings,
): Promise<string> {
  return withRetry({ label: `agentText(${args.agent.name})`, agent: args.agent.name }, async () => {
    const response = await args.agent.generate(args.user, {
      abortSignal: modelAbortSignal(),
      ...modelCallOptions(args),
    });
    return response.text ?? '';
  });
}

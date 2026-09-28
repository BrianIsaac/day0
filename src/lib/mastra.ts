import { schemaRepairPrompt, type StructuredOutputDiagnostics } from './structured-repair';
import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { env } from '../env';
import { languageModel, MODEL, modelProviderClient } from './openai';
import { log } from './logger';
import {
  countingProviderRequests,
  countModelUsage,
  reportModelCall,
  type ProviderRequestCounter,
  type StructuredCallFacts,
  type StructuredMode,
} from './model-call-telemetry';
import {
  classifyStructuredFailure,
  createFallbackMemo,
  errorInsideOk,
  ModelRefusalError,
  ModelReplyCutError,
  moderationRefusal,
  providerEndpointLabel,
  StructuredContractError,
} from './structured-fallback';

/** The typed refusals `agentJson` and `agentText` throw, for their callers to recognise. */
export { ModelRefusalError, ModelReplyCutError } from './structured-fallback';

/**
 * Mastra-fronted agent helpers.
 *
 * Each domain function (charter synthesis, quality-fit, plan drafting,
 * skill execution, skill authoring, transcript extraction) constructs a
 * named Mastra Agent at module load. This
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
/**
 * The most one model call may take, from its first attempt to its last, the
 * structured ladder's rungs and repairs included: a deadline armed once when
 * the call starts and shared by every attempt (U9 step 20, P7-18). Per
 * attempt, five attempts and the SDK's retries inside each let one call run
 * for a quarter of an hour, past the ten minutes a Node action is given, and
 * an action killed mid-call reported nothing.
 */
export const MODEL_CALL_TIMEOUT_MS = 300_000;
export const MODEL_PROVIDER_MAX_RETRIES = 2;

/** When one model call must be done by, armed once at its entry. */
interface ModelCallDeadline {
  readonly at: number;
}

/** A deadline for a call starting now. */
function armDeadline(): ModelCallDeadline {
  return { at: Date.now() + MODEL_CALL_TIMEOUT_MS };
}

/** What is left of a call's budget, in milliseconds. */
function remainingMs(deadline: ModelCallDeadline): number {
  return deadline.at - Date.now();
}

/** The error a call that spent its budget ends with, named as the telemetry reads a timeout. */
function budgetSpent(label: string, cause?: unknown): Error {
  const error = new Error(
    `${label}: the model call reached its ${MODEL_CALL_TIMEOUT_MS}ms budget`,
    cause === undefined ? undefined : { cause },
  );
  error.name = 'TimeoutError';
  return error;
}

/**
 * Run one attempt within what is left of the call's budget: its signal aborts
 * at the deadline, and the attempt is ended then as timed out even if the
 * request it makes does not honour the signal.
 *
 * @throws Error named `TimeoutError` when the budget is spent.
 */
async function withinDeadline<T>(
  deadline: ModelCallDeadline,
  label: string,
  attempt: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const left = remainingMs(deadline);
  if (left <= 0) throw budgetSpent(label);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const spent = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(budgetSpent(label));
    }, left);
  });
  try {
    return await Promise.race([attempt(controller.signal), spent]);
  } finally {
    clearTimeout(timer);
  }
}

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

export const MODEL_RETRY_POLICY = {
  maxAttempts: 5,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  retryableStatusCodes: [429, 503],
  retryableMessagePattern: 'overload|service_unavailable|503|temporar|rate.?limit|busy',
} as const;

function isRetryableStatus(status: number): boolean {
  return (MODEL_RETRY_POLICY.retryableStatusCodes as readonly number[]).includes(status);
}

function isTransientApiError(err: unknown): boolean {
  if (err instanceof StructuredContractError) return false;
  if (err instanceof ModelRefusalError || err instanceof ModelReplyCutError) return false;
  if (!err || typeof err !== 'object') return false;
  const retryableWords = new RegExp(MODEL_RETRY_POLICY.retryableMessagePattern, 'i');
  // An error inside a 200 is non-retryable to the SDK whatever it says; its
  // body's status and words decide, the way a real status would.
  const inside = errorInsideOk(err);
  if (inside) {
    return inside.status !== undefined
      ? isRetryableStatus(inside.status) || inside.status >= 500
      : retryableWords.test(inside.text);
  }
  const e = err as { isRetryable?: boolean; message?: unknown; statusCode?: number };
  if (e.isRetryable === true) return true;
  if (typeof e.statusCode === 'number' && isRetryableStatus(e.statusCode)) return true;
  return retryableWords.test(String(e.message ?? ''));
}

async function withRetry<T>(
  call: { label: string; agent: string; structured?: StructuredCallFacts },
  fn: (signal: AbortSignal) => Promise<T>,
  deadline: ModelCallDeadline,
): Promise<T> {
  const startedAt = Date.now();
  // The counter spans every attempt, so one report says how many requests
  // this call put on the provider, the SDK's own retries included.
  const counter: ProviderRequestCounter = { count: 0 };
  return await countingProviderRequests(counter, async (): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MODEL_RETRY_POLICY.maxAttempts; attempt++) {
      try {
        const value = await withinDeadline(deadline, call.label, fn);
        await reportModelCall({
          agent: call.agent,
          attempts: attempt + 1,
          startedAt,
          providerCalls: counter.count,
          usage: counter,
          structured: call.structured,
        });
        return value;
      } catch (err) {
        lastErr = err;
        const delay = Math.min(
          MODEL_RETRY_POLICY.baseDelayMs * 2 ** attempt,
          MODEL_RETRY_POLICY.maxDelayMs,
        );
        // No attempt starts that the budget cannot hold, backoff included.
        if (
          !isTransientApiError(err) ||
          attempt === MODEL_RETRY_POLICY.maxAttempts - 1 ||
          delay >= remainingMs(deadline)
        ) {
          await reportModelCall({
            agent: call.agent,
            attempts: attempt + 1,
            startedAt,
            providerCalls: counter.count,
            usage: counter,
            failure: { error: err },
            structured: call.structured,
          });
          throw err;
        }
        console.warn(
          `[mastra] ${call.label} attempt ${attempt + 1} hit transient error; retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  });
}

/**
 * Apply the same transient provider retry policy, within one call budget, to
 * any Mastra generation shape. The call is handed the signal that aborts it
 * at the budget's end.
 */
export async function withModelRetry<T>(
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return await withRetry({ label, agent: label }, fn, armDeadline());
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

/** How Mastra is asked to produce the object; declared beside the report that records it. */
export type { StructuredMode };

/**
 * Raised when the server accepted the request and returned no object. Mastra
 * more often raises its own inside `agent.generate()` first - a schema
 * validation failure against the prose-prefixed text a server returns when it
 * takes `response_format` and ignores it - which is what the error below
 * translates, so that both routes reach the classifier as the same kind of
 * failure.
 */
export class StructuredOutputMissingError extends StructuredContractError {
  /** What the model said instead, bounded; a refusal often arrives as prose with no object. */
  readonly reply: string;

  constructor(
    readonly agentName: string,
    readonly mode: StructuredMode,
    reply = '',
  ) {
    super(`agentJson(${agentName}): model returned no structured object in ${mode} mode`);
    this.name = 'StructuredOutputMissingError';
    this.reply = reply.replace(/\s+/g, ' ').trim().slice(0, 300);
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
  // One budget for the whole call: both rungs of the ladder and every repair.
  const deadline = armDeadline();
  const pinned = pinnedStructuredMode(args.mode);
  if (pinned) {
    const generated = await generateObject<T>(args, pinned, deadline);
    return {
      value: generated.value,
      mode: pinned,
      fellBack: false,
      providerWarnings: generated.providerWarnings,
    };
  }

  const key = structuredModeKey(args.agent.name);
  const endpoint = providerEndpointLabel(env.OPENAI_BASE_URL);
  if (structuredModeMemo.begin(key) === 'prompt') {
    const generated = await generateObject<T>(args, 'prompt', deadline);
    return {
      value: generated.value,
      mode: 'prompt',
      fellBack: false,
      providerWarnings: generated.providerWarnings,
    };
  }

  let native: GeneratedObject<T>;
  try {
    native = await generateObject<T>(args, 'native', deadline);
  } catch (err) {
    const failure = classifyStructuredFailure(err);
    if (failure.verdict === 'unrelated') {
      structuredModeMemo.inconclusive(key);
      log.warn('structured-output: native failed for a reason prompt injection cannot fix', {
        agent: args.agent.name,
        baseUrl: endpoint,
        model: MODEL,
        evidence: failure.evidence,
        hint: 'set OPENAI_JSON_MODE=prompt to pin the fallback if this server never honours it',
      });
      throw err;
    }
    let generated: GeneratedObject<T>;
    try {
      generated = await generateObject<T>(args, 'prompt', deadline, {
        fellBack: true,
        demotes: failure.provesRefusal,
      });
    } catch {
      structuredModeMemo.inconclusive(key);
      log.warn(
        'structured-output: prompt injection failed the same way, so response_format was not the cause',
        {
          agent: args.agent.name,
          baseUrl: endpoint,
          model: MODEL,
          evidence: failure.evidence,
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
      'structured-output fallback: the native attempt produced no valid object and prompt injection did; this agent starts on the prompt rung',
      {
        agent: args.agent.name,
        baseUrl: endpoint,
        model: MODEL,
        evidence: failure.evidence,
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
  deadline: ModelCallDeadline,
  fallback: Omit<StructuredCallFacts, 'mode'> = {},
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
          {
            label: `agentJson(${args.agent.name})`,
            agent: args.agent.name,
            structured: { mode, ...fallback },
          },
          (signal) => generateObjectOnce<T>({ ...args, user }, mode, signal),
          deadline,
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
  signal: AbortSignal,
): Promise<GeneratedObject<T>> {
  const timedOut = (): boolean => signal.aborted;
  const timeoutError = (cause?: unknown): Error =>
    budgetSpent(`agentJson(${args.agent.name}): ${mode}`, cause);
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
    throw asModerationRefusal(args.agent.name, err);
  }
  // Billed whatever the reply turns out to hold.
  countModelUsage(response);
  const resultError = (response as { error?: unknown }).error;
  if (timedOut()) throw timeoutError(resultError);
  if (resultError !== undefined && resultError !== null) {
    if (resultError instanceof Error) throw asModerationRefusal(args.agent.name, resultError);
    throw new Error(
      `agentJson(${args.agent.name}): ${mode} generation failed: ${String(resultError)}`,
    );
  }
  const finishReason = (response as { finishReason?: unknown }).finishReason;
  if (finishReason === 'error') {
    throw new Error(`agentJson(${args.agent.name}): ${mode} generation finished with an error`);
  }
  assertCompleteReply(args.agent.name, finishReason, replyText(response));
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
    throw new StructuredOutputMissingError(args.agent.name, mode, replyText(response));
  }
  return {
    value: object,
    providerWarnings: providerWarningTexts((response as { warnings?: unknown }).warnings),
  };
}

function replyText(response: unknown): string {
  const text = (response as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

/**
 * Refuse a reply the provider did not finish: one cut at the output limit is
 * incomplete however well it parses, and one stopped by a content filter is a
 * refusal whatever text came with it.
 *
 * @throws ModelReplyCutError for a `length` finish.
 * @throws ModelRefusalError for a `content-filter` finish.
 */
function assertCompleteReply(agentName: string, finishReason: unknown, text: string): void {
  if (finishReason === 'length') throw new ModelReplyCutError(agentName, text);
  if (finishReason === 'content-filter') throw new ModelRefusalError(agentName, text);
}

/** A provider's moderation refusal as the typed refusal, anything else unchanged. */
function asModerationRefusal(agentName: string, err: unknown): unknown {
  const refusal = moderationRefusal(err);
  return refusal === undefined ? err : new ModelRefusalError(agentName, refusal);
}

/**
 * Generate plain text with the shared retry policy.
 *
 * @throws ModelReplyCutError when the reply stopped at the output limit.
 * @throws ModelRefusalError when the provider refused the content.
 */
export async function agentText(
  args: { agent: Agent; user: string } & ModelCallSettings,
): Promise<string> {
  return withRetry(
    { label: `agentText(${args.agent.name})`, agent: args.agent.name },
    async (signal) => {
      let response;
      try {
        response = await args.agent.generate(args.user, {
          abortSignal: signal,
          ...modelCallOptions(args),
        });
      } catch (err) {
        throw asModerationRefusal(args.agent.name, err);
      }
      countModelUsage(response);
      const text = replyText(response);
      assertCompleteReply(
        args.agent.name,
        (response as { finishReason?: unknown }).finishReason,
        text,
      );
      return text;
    },
    armDeadline(),
  );
}

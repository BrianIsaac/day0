import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { env } from '../env';
import { languageModel, MODEL } from './openai';
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
 * Every provider uses the explicit AI-SDK chat-completions model. Chat
 * completions with `json_schema` is the common structured-output route across
 * OpenAI and the supported local runtimes; using Mastra's Responses router for
 * only the hosted bed would change both provider and protocol at once.
 */
export const MODEL_CONFIG = (): MastraModelConfig => languageModel() as MastraModelConfig;

/** Shared sampling setting for the shipped agent and the evaluation control. */
export const MODEL_TEMPERATURE = 0.4;
export const MODEL_CALL_TIMEOUT_MS = 90_000;
export const MODEL_PROVIDER_MAX_RETRIES = 2;

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

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MODEL_RETRY_POLICY.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientApiError(err) || attempt === MODEL_RETRY_POLICY.maxAttempts - 1) throw err;
      const delay = Math.min(
        MODEL_RETRY_POLICY.baseDelayMs * 2 ** attempt,
        MODEL_RETRY_POLICY.maxDelayMs,
      );
      console.warn(
        `[mastra] ${label} attempt ${attempt + 1} hit transient error; retrying in ${delay}ms`,
        err,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Apply the same transient provider retry policy to any Mastra generation shape. */
export async function withModelRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return await withRetry(label, fn);
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

export interface AgentJsonArgs {
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
  const label = `agentJson(${args.agent.name})`;
  const pinned = pinnedStructuredMode(args.mode);
  if (pinned) {
    return {
      value: await withRetry(label, () => generateObject<T>(args, pinned)),
      mode: pinned,
      fellBack: false,
    };
  }

  const key = structuredModeKey(args.agent.name);
  const endpoint = env.OPENAI_BASE_URL ?? 'api.openai.com';
  if (structuredModeMemo.begin(key) === 'prompt') {
    return {
      value: await withRetry(`${label}:prompt`, () => generateObject<T>(args, 'prompt')),
      mode: 'prompt',
      fellBack: false,
    };
  }

  let native: T;
  try {
    native = await withRetry(label, () => generateObject<T>(args, 'native'));
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
    let value: T;
    try {
      value = await withRetry(`${label}:prompt`, () => generateObject<T>(args, 'prompt'));
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
      return { value, mode: 'prompt', fellBack: true };
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
    return { value, mode: 'prompt', fellBack: true };
  }
  structuredModeMemo.worked(key);
  return { value: native, mode: 'native', fellBack: false };
}

export async function agentJson<T>(args: AgentJsonArgs): Promise<T> {
  return (await agentJsonWithMode<T>(args)).value;
}

async function generateObject<T>(
  args: { agent: Agent; user: string; schema: unknown },
  mode: StructuredMode,
): Promise<T> {
  const signal = modelAbortSignal();
  const startedAt = Date.now();
  const timedOut = (): boolean =>
    signal.aborted || Date.now() - startedAt >= MODEL_CALL_TIMEOUT_MS;
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
      modelSettings: { temperature: MODEL_TEMPERATURE },
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
  if ((response as { finishReason?: unknown }).finishReason === 'error') {
    throw new Error(`agentJson(${args.agent.name}): ${mode} generation finished with an error`);
  }
  const object = response.object as T | undefined;
  if (object === undefined || object === null) {
    throw new StructuredOutputMissingError(args.agent.name, mode);
  }
  return object;
}

export async function agentText(args: { agent: Agent; user: string }): Promise<string> {
  return withRetry(`agentText(${args.agent.name})`, async () => {
    const response = await args.agent.generate(args.user, {
      abortSignal: modelAbortSignal(),
      modelSettings: { temperature: MODEL_TEMPERATURE },
    });
    return response.text ?? '';
  });
}

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
 * Hosted OpenAI keeps the model-router string so Mastra resolves the
 * model through its own provider registry (capability metadata, strict
 * structured-output mode, observability labels). A custom
 * OPENAI_BASE_URL swaps in an explicit AI-SDK chat-completions model,
 * because the router would otherwise resolve `openai/*` against
 * api.openai.com and ignore the base URL entirely.
 */
export const MODEL_CONFIG: MastraModelConfig = env.OPENAI_BASE_URL
  ? (languageModel() as MastraModelConfig)
  : (`openai/${MODEL}` as MastraModelConfig);

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;

function isTransientApiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { isRetryable?: boolean; message?: unknown; statusCode?: number };
  if (e.isRetryable === true) return true;
  if (e.statusCode === 503 || e.statusCode === 429) return true;
  const msg = String(e.message ?? '');
  return /overload|service_unavailable|503|temporar|rate.?limit/i.test(msg);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientApiError(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      console.warn(
        `[mastra] ${label} attempt ${attempt + 1} hit transient error; retrying in ${delay}ms`,
        err,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export function makeAgent(name: string, instructions: string): Agent {
  return new Agent({
    id: name,
    name,
    instructions,
    model: MODEL_CONFIG,
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
 * takes `response_format` and ignores it - which is why the classifier decides
 * on the shape of the failure rather than on this type alone.
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
 * 5xx - is rethrown untried, because prompt injection recovers from none of
 * them and would only bury the real cause under a second failure.
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
  const response = await args.agent.generate(args.user, {
    // Zod 4 schemas pass through Mastra's PublicSchema bridge; the cast
    // sidesteps the v4-vs-v3 peer-dep nuance without losing the
    // runtime validation Mastra performs against the schema.
    structuredOutput: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: args.schema as any,
      jsonPromptInjection: mode === 'prompt',
    },
  });
  const object = response.object as T | undefined;
  if (object === undefined || object === null) {
    throw new StructuredOutputMissingError(args.agent.name, mode);
  }
  return object;
}

export async function agentText(args: { agent: Agent; user: string }): Promise<string> {
  return withRetry(`agentText(${args.agent.name})`, async () => {
    const response = await args.agent.generate(args.user);
    return response.text ?? '';
  });
}

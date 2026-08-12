import OpenAI from 'openai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { env } from '../env';
import { log } from './logger';
import {
  classifyStructuredFailure,
  createFallbackMemo,
  StructuredContractError,
} from './structured-fallback';

/**
 * Provider-agnostic model client. Every raw-SDK call and every AI-SDK
 * model instance in the app resolves through here, so pointing Day0 at
 * a different OpenAI-compatible server is a two-variable change:
 *
 *   OPENAI_BASE_URL=http://localhost:11434/v1   OPENAI_MODEL=qwen3:8b
 *
 * Verified shapes: ollama, vLLM, llama.cpp `llama-server`, LM Studio,
 * and hosted OpenAI-compatible gateways (Qwen, DeepSeek, OpenRouter,
 * Groq, Together). Leave OPENAI_BASE_URL unset for api.openai.com.
 */

export const MODEL = env.OPENAI_MODEL;

/** The AI-SDK model instance shape, without depending on `@ai-sdk/provider` directly. */
export type SdkLanguageModel = ReturnType<OpenAIProvider['chat']>;

let client: OpenAI | null = null;
let provider: OpenAIProvider | null = null;

/**
 * Local runtimes authenticate nothing but the OpenAI SDK still refuses
 * to construct without a key, so a custom base URL gets a placeholder
 * rather than forcing operators to invent a fake key in their env file.
 */
const PLACEHOLDER_API_KEY = 'day0-local';

function resolveApiKey(): string {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  if (env.OPENAI_BASE_URL) return PLACEHOLDER_API_KEY;
  throw new Error(
    'OPENAI_API_KEY not set — set it, or set OPENAI_BASE_URL to an OpenAI-compatible endpoint that needs no key',
  );
}

export function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: resolveApiKey(), baseURL: env.OPENAI_BASE_URL });
  }
  return client;
}

function openaiProvider(): OpenAIProvider {
  if (!provider) {
    provider = createOpenAI({ apiKey: resolveApiKey(), baseURL: env.OPENAI_BASE_URL });
  }
  return provider;
}

/**
 * AI-SDK language model for the Mastra + `streamText` paths.
 *
 * Custom endpoints get the chat-completions surface explicitly: the
 * provider's default is `/v1/responses`, which is an OpenAI-only API
 * that no local runtime implements. Hosted OpenAI keeps the default so
 * the responses-API features (prompt caching, reasoning) stay available.
 */
export function languageModel(modelId: string = MODEL): SdkLanguageModel {
  const p = openaiProvider();
  return env.OPENAI_BASE_URL ? p.chat(modelId) : p(modelId);
}

/** How a JSON completion coerced the model into emitting an object. */
export type JsonMode = 'native' | 'prompt';

/**
 * Appended to the system prompt in `prompt` mode. Deliberately blunt:
 * small local models drift into markdown fences and prefatory prose
 * unless the constraint is spelled out as a character-level rule.
 */
export const JSON_ONLY_INSTRUCTION = [
  '',
  'OUTPUT CONTRACT — non-negotiable:',
  '  - Reply with ONE JSON object and nothing else.',
  '  - No markdown fences, no commentary before or after the object.',
  '  - The first character of your reply is "{" and the last is "}".',
].join('\n');

/**
 * Which endpoint-and-model pairs have refused `response_format`, and until
 * when. Support is a property of the server and the model, not of the process,
 * so a refusal from one model says nothing about the next - and it expires, so
 * a server that starts honouring the parameter is not written off for the life
 * of a warm process. Only consulted in `auto` mode; `native` and `prompt` are
 * hard settings.
 */
const jsonModeMemo = createFallbackMemo();

function jsonModeKey(model: string): string {
  return `${env.OPENAI_BASE_URL ?? 'api.openai.com'}|${model}`;
}

/** The rung the next `auto` call will start on for this model. */
export function jsonModeFor(model: string = MODEL): JsonMode {
  return jsonModeMemo.rungFor(jsonModeKey(model));
}

/** Test seam, and what the endpoint probe calls between rungs. */
export function resetJsonModeMemo(): void {
  jsonModeMemo.reset();
}

/**
 * Pull the first complete JSON value out of a model reply. Handles the
 * three ways a server that ignores `response_format` returns JSON:
 * wrapped in a markdown fence, prefixed with a `<think>` trace (qwen,
 * deepseek-r1 and friends when the runtime inlines reasoning instead of
 * splitting it into its own field), or preceded by prose.
 *
 * Returns null when the reply holds no balanced JSON value.
 */
export function extractJsonPayload(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;

  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // An unterminated trace means the reply was truncated mid-reasoning.
  if (/^<think>/i.test(text)) return null;

  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) text = fenced[1].trim();

  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface JsonCompleteArgs<TParsed> {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  /** Optional schema-like coercion applied after JSON.parse. */
  coerce?: (raw: unknown) => TParsed;
  /**
   * Pin the strategy for this call, overriding `OPENAI_JSON_MODE`. Lets
   * a caller (or a test, or the endpoint probe) drive either rung of
   * the ladder deterministically instead of depending on what the
   * server happened to do first.
   */
  mode?: JsonMode;
}

export interface JsonCompleteResult<TParsed> {
  value: TParsed;
  /** Which coercion actually produced the object. */
  mode: JsonMode;
  /** True when `native` was attempted first and had to be abandoned. */
  fellBack: boolean;
}

/**
 * Single-shot JSON completion with an explicit two-strategy ladder.
 *
 *   native — `response_format: { type: 'json_object' }`, the OpenAI way.
 *   prompt — no `response_format`; the contract goes in the system
 *            prompt and the object is extracted from the reply text.
 *
 * `OPENAI_JSON_MODE` pins a strategy (`native` / `prompt`) for testing
 * or for a server whose behaviour is already known. The default `auto`
 * tries native; when that fails for a reason `response_format` could
 * explain, the prompt attempt doubles as the experiment that settles it,
 * and only its success demotes the endpoint. A failure the parameter
 * cannot explain — a rate limit, a bad key, an overlong context, a sick
 * server, anything statusless that nothing ties to the endpoint — is
 * rethrown untried: prompt injection recovers from none of them and a
 * second doomed round-trip would only hide the real cause. Where the
 * parameter is implicated but the failure could also have passed on a
 * retry, the object is fetched and nothing is demoted.
 *
 * The demotion is memoised per endpoint-and-model and expires, so one
 * wasted round-trip pays for a run of calls rather than one per call,
 * without one model's refusal speaking for another's.
 *
 * There is deliberately no value-only convenience wrapper: `fellBack`
 * is how a caller learns it is on the degraded rung, and a wrapper that
 * drops it makes that invisible at every call site at once.
 */
export async function jsonCompleteWithMode<TParsed = unknown>(
  args: JsonCompleteArgs<TParsed>,
): Promise<JsonCompleteResult<TParsed>> {
  const configured = args.mode ?? env.OPENAI_JSON_MODE;
  if (configured === 'prompt') {
    return { value: await runJsonCompletion('prompt', args), mode: 'prompt', fellBack: false };
  }
  if (configured === 'native') {
    return { value: await runJsonCompletion('native', args), mode: 'native', fellBack: false };
  }
  const model = args.model ?? MODEL;
  const key = jsonModeKey(model);
  const endpoint = env.OPENAI_BASE_URL ?? 'api.openai.com';
  if (jsonModeMemo.begin(key) === 'prompt') {
    return { value: await runJsonCompletion('prompt', args), mode: 'prompt', fellBack: false };
  }
  let native: TParsed;
  try {
    native = await runJsonCompletion('native', args);
  } catch (err) {
    const failure = classifyStructuredFailure(err);
    if (failure.verdict === 'unrelated') {
      jsonModeMemo.inconclusive(key);
      log.warn('json-mode: native response_format failed for a reason prompt mode cannot fix', {
        baseUrl: endpoint,
        model,
        evidence: failure.evidence,
        cause: (err as Error).message,
        hint: 'set OPENAI_JSON_MODE=prompt to pin the fallback if this server never honours it',
      });
      throw err;
    }
    let value: TParsed;
    try {
      value = await runJsonCompletion('prompt', args);
    } catch (withoutParameter) {
      // Dropping the parameter changed nothing, so the parameter was not the
      // problem. The original failure is the one worth reporting; the second
      // is a symptom of the same cause.
      jsonModeMemo.inconclusive(key);
      log.warn(
        'json-mode: dropping response_format did not help, so the failure was not about it',
        {
          baseUrl: endpoint,
          model,
          evidence: failure.evidence,
          cause: (err as Error).message,
          promptModeCause: (withoutParameter as Error).message,
        },
      );
      throw err;
    }
    if (!failure.provesRefusal) {
      // The object arrived, which is what the caller needed, but the native
      // failure was consistent with a passing condition and the two calls are
      // separated in time. Demoting on that would put every later call on the
      // degraded rung on the strength of a coincidence.
      jsonModeMemo.inconclusive(key);
      log.warn(
        'json-mode: prompt mode produced the object, but the native failure does not prove response_format was the cause; not demoting',
        {
          baseUrl: endpoint,
          model,
          evidence: failure.evidence,
          cause: (err as Error).message,
        },
      );
      return { value, mode: 'prompt', fellBack: true };
    }
    jsonModeMemo.refused(key);
    log.warn(
      'json-mode fallback: server did not honour response_format, switching to prompt mode',
      {
        baseUrl: endpoint,
        model,
        evidence: failure.evidence,
        cause: (err as Error).message,
        retriesNativeInMs: jsonModeMemo.retriesNativeIn(key),
      },
    );
    return { value, mode: 'prompt', fellBack: true };
  }
  jsonModeMemo.worked(key);
  return { value: native, mode: 'native', fellBack: false };
}

/** Raised when a reply carried no parseable JSON, whatever the mode. */
export class JsonParseError extends StructuredContractError {
  constructor(
    readonly mode: JsonMode,
    readonly raw: string,
    cause: string,
  ) {
    super(`jsonComplete(${mode}): model returned invalid JSON — ${cause}`);
    this.name = 'JsonParseError';
  }
}

async function runJsonCompletion<TParsed>(
  mode: JsonMode,
  args: JsonCompleteArgs<TParsed>,
): Promise<TParsed> {
  const res = await openai().chat.completions.create({
    model: args.model ?? MODEL,
    max_completion_tokens: args.maxTokens ?? 4000,
    ...(mode === 'native' ? { response_format: { type: 'json_object' as const } } : {}),
    messages: [
      {
        role: 'system',
        content: mode === 'native' ? args.system : args.system + JSON_ONLY_INSTRUCTION,
      },
      { role: 'user', content: args.user },
    ],
  });
  const raw = res.choices[0]?.message?.content?.trim() ?? '';
  if (!raw) throw new JsonParseError(mode, raw, 'empty content');

  const payload = mode === 'native' ? raw : (extractJsonPayload(raw) ?? raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    // A native-mode reply that needs extraction means the server took
    // the parameter and ignored it — recoverable, so surface it as a
    // parse error the ladder can catch rather than a hard throw.
    const salvaged = mode === 'native' ? extractJsonPayload(raw) : null;
    if (salvaged) {
      try {
        return finalise(JSON.parse(salvaged), args);
      } catch {
        /* fall through to the parse error below */
      }
    }
    throw new JsonParseError(mode, raw, (err as Error).message);
  }
  return finalise(parsed, args);
}

function finalise<TParsed>(parsed: unknown, args: JsonCompleteArgs<TParsed>): TParsed {
  return args.coerce ? args.coerce(parsed) : (parsed as TParsed);
}

export interface TextCompleteArgs {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}

export async function textComplete(args: TextCompleteArgs): Promise<string> {
  const res = await openai().chat.completions.create({
    model: args.model ?? MODEL,
    max_completion_tokens: args.maxTokens ?? 4000,
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
  });
  return res.choices[0]?.message?.content?.trim() ?? '';
}

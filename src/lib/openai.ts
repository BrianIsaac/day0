import OpenAI from 'openai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { env } from '../env';
import { log } from './logger';

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
 * Per-process memo of whether the configured server honours
 * `response_format`. `null` means "not probed yet". Only consulted in
 * `auto` mode; `native` and `prompt` are hard settings.
 */
let nativeJsonModeSupported: boolean | null = null;

export function jsonModeProbe(): boolean | null {
  return nativeJsonModeSupported;
}

/** Test seam — clears the memo so a suite can drive both branches. */
export function resetJsonModeProbe(): void {
  nativeJsonModeSupported = null;
}

/**
 * Whether an error means "this server does not implement
 * `response_format`" rather than "this request was bad". Servers reject
 * it in at least three shapes: a 400 naming the field, a 404 on the
 * route, and a 422 from proxies that validate the body themselves.
 */
export function isJsonModeUnsupportedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; message?: unknown; error?: { message?: unknown } };
  const message = `${String(e.message ?? '')} ${String(e.error?.message ?? '')}`.toLowerCase();
  const namesResponseFormat =
    /response_format|json_object|json_schema|structured output|json mode/.test(message);
  if (namesResponseFormat) return true;
  const status = e.status;
  if (status === undefined) return false;
  return (
    (status === 400 || status === 404 || status === 422 || status === 501) &&
    /unsupported|not supported|unknown|unrecognized|invalid/.test(message)
  );
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
 * tries native, and demotes to prompt when the server either rejects
 * `response_format` or accepts it and ignores it (unparseable reply).
 * The demotion is memoised per process, so one wasted round-trip pays
 * for the whole run rather than one per call.
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
  if (nativeJsonModeSupported === false) {
    return { value: await runJsonCompletion('prompt', args), mode: 'prompt', fellBack: false };
  }
  try {
    const value = await runJsonCompletion('native', args);
    nativeJsonModeSupported = true;
    return { value, mode: 'native', fellBack: false };
  } catch (err) {
    if (!isJsonModeFallbackWorthy(err)) throw err;
    nativeJsonModeSupported = false;
    log.warn('json-mode fallback: server did not honour response_format, switching to prompt mode', {
      baseUrl: env.OPENAI_BASE_URL ?? 'api.openai.com',
      model: args.model ?? MODEL,
      cause: (err as Error).message,
    });
    return { value: await runJsonCompletion('prompt', args), mode: 'prompt', fellBack: true };
  }
}

export async function jsonComplete<TParsed = unknown>(
  args: JsonCompleteArgs<TParsed>,
): Promise<TParsed> {
  const result = await jsonCompleteWithMode(args);
  return result.value;
}

/** A native-mode failure the prompt ladder can plausibly recover from. */
function isJsonModeFallbackWorthy(err: unknown): boolean {
  return isJsonModeUnsupportedError(err) || err instanceof JsonParseError;
}

/** Raised when a reply carried no parseable JSON, whatever the mode. */
export class JsonParseError extends Error {
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
      { role: 'system', content: mode === 'native' ? args.system : args.system + JSON_ONLY_INSTRUCTION },
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

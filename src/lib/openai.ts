import OpenAI from 'openai';
import { env } from '../env';

let client: OpenAI | null = null;

export function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return client;
}

export const MODEL = env.OPENAI_MODEL;

export interface JsonCompleteArgs<TParsed> {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  /** Optional schema-like coercion applied after JSON.parse. */
  coerce?: (raw: unknown) => TParsed;
}

/**
 * Single-shot JSON-mode completion. Uses `response_format: json_object`
 * so the model is forced to emit a parseable object. The optional
 * `coerce` lets callers funnel the raw payload through type-safe
 * defaults without a separate Zod schema (kept lightweight for
 * hackathon speed).
 */
export async function jsonComplete<TParsed = unknown>(args: JsonCompleteArgs<TParsed>): Promise<TParsed> {
  const res = await openai().chat.completions.create({
    model: args.model ?? MODEL,
    max_completion_tokens: args.maxTokens ?? 4000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
  });
  const raw = res.choices[0]?.message?.content?.trim() ?? '';
  if (!raw) throw new Error('jsonComplete: empty content');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`jsonComplete: model returned invalid JSON — ${(err as Error).message}`);
  }
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

import { Agent } from '@mastra/core/agent';
import { env } from '../env';

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
 * Both helpers retry on transient OpenAI errors (503 service overloads,
 * generic API errors flagged `isRetryable`). The Mastra/AI-SDK default
 * is two retries on top of the initial attempt — that has not been
 * enough during demo windows when OpenAI is hot. We wrap with
 * exponential backoff up to five attempts so the loop survives a flake.
 */

const MODEL = `openai/${env.OPENAI_MODEL}` as const;
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
      console.warn(`[mastra] ${label} attempt ${attempt + 1} hit transient error; retrying in ${delay}ms`, err);
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
    model: MODEL,
  });
}

export async function agentJson<T>(args: {
  agent: Agent;
  user: string;
  schema: unknown;
}): Promise<T> {
  return withRetry(`agentJson(${args.agent.name})`, async () => {
    const response = await args.agent.generate(args.user, {
      // Zod 4 schemas pass through Mastra's PublicSchema bridge; the cast
      // sidesteps the v4-vs-v3 peer-dep nuance without losing the
      // runtime validation Mastra performs against the schema.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      structuredOutput: { schema: args.schema as any },
    });
    return response.object as T;
  });
}

export async function agentText(args: { agent: Agent; user: string }): Promise<string> {
  return withRetry(`agentText(${args.agent.name})`, async () => {
    const response = await args.agent.generate(args.user);
    return response.text ?? '';
  });
}

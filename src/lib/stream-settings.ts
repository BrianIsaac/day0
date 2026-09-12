import type { JSONValue } from 'ai';
import { env } from '../env';

/**
 * The two model knobs, for a route that streams through the AI SDK directly.
 *
 * `modelCallOptions` (`./mastra`) does this for everything that goes through a
 * Mastra agent, and this is the same pair of environment variables read for the
 * same reason. It is a separate function rather than a call into that one
 * because the two call shapes differ: Mastra takes a `modelSettings` object and
 * fixes `temperature`, while `streamText` takes the budget at the top level and
 * a streaming route has never sent a temperature. Reusing the Mastra helper
 * would quietly add one.
 *
 * Both knobs stay optional. Unset, a route sends exactly what it sent before
 * them, which is what keeps a hosted deployment unchanged when neither is
 * configured.
 */
export interface StreamCallSettings {
  /** What the route sends when `OPENAI_MAX_OUTPUT_TOKENS` is absent. */
  maxOutputTokens: number;
  /** Provider options the route sends regardless, merged under the same key. */
  openai?: Record<string, JSONValue>;
}

export interface StreamCallOptions {
  maxOutputTokens: number;
  providerOptions: { openai: Record<string, JSONValue> };
}

/**
 * Resolve the output budget and reasoning effort for one `streamText` call.
 *
 * The budget is provider-agnostic: the AI SDK sends it as `max_tokens` on a
 * compatible chat endpoint and `max_output_tokens` on hosted Responses. Effort
 * is provider-specific and goes under `providerOptions.openai`, beside whatever
 * the route already sends there, becoming chat `reasoning_effort` or Responses
 * `reasoning.effort`.
 *
 * Args:
 *   route: The budget this route sends when the knob is unset, and any provider
 *     options it sends on every call.
 *
 * Returns:
 *   Settings to spread into `streamText`.
 */
export function streamCallOptions(route: StreamCallSettings): StreamCallOptions {
  const reasoningEffort = env.OPENAI_REASONING_EFFORT;
  return {
    maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS ?? route.maxOutputTokens,
    providerOptions: {
      openai: {
        ...route.openai,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
    },
  };
}

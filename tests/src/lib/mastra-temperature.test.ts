import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});
import {
  agentJson,
  agentJsonWithMode,
  agentText,
  makeAgent,
  MODEL_CALL_TIMEOUT_MS,
  MODEL_CONFIG,
  MODEL_PROVIDER_MAX_RETRIES,
  MODEL_TEMPERATURE,
  providerWarningTexts,
  resetStructuredModeMemo,
  structuredModeFor,
  withModelRetry,
} from '../../../src/lib/mastra';
import { classifyStructuredFailure } from '../../../src/lib/structured-fallback';
import type { Agent } from '@mastra/core/agent';

afterEach((): void => {
  vi.useRealTimers();
  resetStructuredModeMemo();
});

describe('shared model sampling', (): void => {
  it('uses the same non-zero temperature for structured and text calls', async (): Promise<void> => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ object: { ok: true } })
      .mockResolvedValueOnce({ text: 'done' });
    const agent = { name: 'temperature-test', generate } as unknown as Agent;

    await agentJson({ agent, user: 'structured', schema: {} });
    await agentText({ agent, user: 'text' });

    expect(MODEL_TEMPERATURE).toBeGreaterThan(0);
    expect(MODEL_CALL_TIMEOUT_MS).toBe(240_000);
    expect(MODEL_PROVIDER_MAX_RETRIES).toBe(2);
    expect(makeAgent('retry-test', 'test').maxRetries).toBe(MODEL_PROVIDER_MAX_RETRIES);
    expect(generate.mock.calls[0]?.[1]).toMatchObject({
      modelSettings: { temperature: MODEL_TEMPERATURE },
    });
    expect(generate.mock.calls[1]?.[1]).toMatchObject({
      modelSettings: { temperature: MODEL_TEMPERATURE },
    });
    expect(generate.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(generate.mock.calls[1]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('applies the recorded outer transient retry policy', async (): Promise<void> => {
    vi.useFakeTimers();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockResolvedValueOnce('recovered');

    const result = withModelRetry('parity-test', run);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe('recovered');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('uses the chat-completions client for the hosted route too', (): void => {
    expect(typeof MODEL_CONFIG).toBe('function');
    expect((MODEL_CONFIG() as { provider?: string }).provider).toBe('openai.chat');
  });

  it('surfaces provider warnings from a structured generate result', async (): Promise<void> => {
    const generate = vi.fn().mockResolvedValue({
      object: { ok: true },
      warnings: [
        {
          type: 'unsupported',
          feature: 'temperature',
          details: 'temperature is not supported for reasoning models',
        },
      ],
    });
    const agent = { name: 'warning-test', generate } as unknown as Agent;

    const result = await agentJsonWithMode<{ ok: boolean }>({
      agent,
      user: 'structured',
      schema: {},
    });

    expect(result.providerWarnings).toEqual([
      'unsupported (temperature): temperature is not supported for reasoning models',
    ]);
    expect(providerWarningTexts(undefined)).toEqual([]);
  });

  it('classifies a native call that reaches the abort wall as transport and keeps native mode', async (): Promise<void> => {
    vi.useFakeTimers();
    const generate = vi
      .fn()
      .mockImplementationOnce(
        async (): Promise<{ object?: { ok: boolean }; finishReason: string }> =>
          await new Promise((resolve) =>
            setTimeout(() => resolve({ finishReason: 'error' }), MODEL_CALL_TIMEOUT_MS),
          ),
      )
      .mockResolvedValueOnce({ object: { ok: true }, finishReason: 'stop' });
    const agent = { name: 'abort-regression', generate } as unknown as Agent;

    const pending = agentJsonWithMode<{ ok: boolean }>({
      agent,
      user: 'structured',
      schema: {},
    }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS);

    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('TimeoutError');
    expect(classifyStructuredFailure(error)).toMatchObject({
      verdict: 'unrelated',
      provesRefusal: false,
      evidence: 'transport failure (TimeoutError)',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(structuredModeFor(agent.name)).toBe('native');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentJson,
  agentText,
  makeAgent,
  MODEL_CALL_TIMEOUT_MS,
  MODEL_PROVIDER_MAX_RETRIES,
  MODEL_TEMPERATURE,
  withModelRetry,
} from '../../../src/lib/mastra';
import type { Agent } from '@mastra/core/agent';

afterEach((): void => {
  vi.useRealTimers();
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
    expect(MODEL_CALL_TIMEOUT_MS).toBe(90_000);
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
});

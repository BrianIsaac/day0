import { describe, expect, it, vi } from 'vitest';
import {
  agentJson,
  agentText,
  MODEL_CALL_TIMEOUT_MS,
  MODEL_TEMPERATURE,
} from '../../../src/lib/mastra';
import type { Agent } from '@mastra/core/agent';

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
    expect(generate.mock.calls[0]?.[1]).toMatchObject({
      modelSettings: { temperature: MODEL_TEMPERATURE },
    });
    expect(generate.mock.calls[1]?.[1]).toMatchObject({
      modelSettings: { temperature: MODEL_TEMPERATURE },
    });
    expect(generate.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(generate.mock.calls[1]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

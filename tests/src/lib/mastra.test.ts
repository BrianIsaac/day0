import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});
import type { Agent } from '@mastra/core/agent';
import {
  agentJson,
  agentText,
  MODEL_CALL_TIMEOUT_MS,
  resetStructuredModeMemo,
  withModelRetry,
} from '../../../src/lib/mastra';
import {
  countProviderRequest,
  observeModelCalls,
  type ModelCallReport,
} from '../../../src/lib/model-call-telemetry';

/**
 * The retry wrapper reports every model call to the observer the loop step
 * installed around it: how many attempts it took, how long it held the step,
 * and how it ended. The report is what goes on the item's ledger, so it may
 * name the agent and the failure's class, and nothing of the prompt or the
 * reply.
 */

const SECRET_PROMPT = 'Authorization: Bearer sk-live-do-not-record';

afterEach((): void => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetStructuredModeMemo();
});

async function collect<T>(fn: () => Promise<T>): Promise<{ reports: ModelCallReport[]; result: T }> {
  const reports: ModelCallReport[] = [];
  const result = await observeModelCalls((report: ModelCallReport): void => {
    reports.push(report);
  }, fn);
  return { reports, result };
}

describe('model-call telemetry from the retry wrapper', (): void => {
  it('reports one attempt and the wall-clock duration of a call that succeeds first time', async (): Promise<void> => {
    vi.useFakeTimers();
    const generate = vi.fn(async (): Promise<{ object: { ok: true } }> => {
      await vi.advanceTimersByTimeAsync(1_250);
      return { object: { ok: true } };
    });
    const agent = { name: 'day0-scope-judgement', generate } as unknown as Agent;

    const { reports, result } = await collect(() => agentJson({ agent, user: SECRET_PROMPT, schema: {} }));

    expect(result).toEqual({ ok: true });
    expect(reports).toEqual([
      {
        agent: 'day0-scope-judgement',
        attempts: 1,
        retries: 0,
        durationMs: 1_250,
        outcome: 'ok',
      },
    ]);
  });

  it('reports the attempts and the total duration of a retried call', async (): Promise<void> => {
    vi.useFakeTimers();
    const generate = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 503, message: 'service unavailable' })
      .mockRejectedValueOnce({ statusCode: 429, message: 'rate limit' })
      .mockResolvedValueOnce({ object: { ok: true } });
    const agent = { name: 'day0-plan', generate } as unknown as Agent;
    vi.spyOn(console, 'warn').mockImplementation((): void => {});

    const pending = collect(() => agentJson({ agent, user: SECRET_PROMPT, schema: {} }));
    // 2 s after the first failure, 4 s after the second: the policy's doubling.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    const { reports } = await pending;

    expect(generate).toHaveBeenCalledTimes(3);
    expect(reports).toEqual([
      {
        agent: 'day0-plan',
        attempts: 3,
        retries: 2,
        durationMs: 6_000,
        outcome: 'ok',
      },
    ]);
  });

  it('reports a call that exhausted its attempts as failed, with the status and the error class only', async (): Promise<void> => {
    vi.useFakeTimers();
    const overloaded = Object.assign(new Error(`overloaded while handling ${SECRET_PROMPT}`), {
      statusCode: 503,
    });
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(overloaded);
    vi.spyOn(console, 'warn').mockImplementation((): void => {});

    const pending = collect(() => withModelRetry('parity-test', run).catch((err: unknown) => err));
    for (const delay of [2_000, 4_000, 8_000, 16_000]) await vi.advanceTimersByTimeAsync(delay);
    const { reports, result } = await pending;

    expect(result).toBe(overloaded);
    expect(run).toHaveBeenCalledTimes(5);
    expect(reports).toEqual([
      {
        agent: 'parity-test',
        attempts: 5,
        retries: 4,
        durationMs: 30_000,
        outcome: 'failed',
        errorName: 'Error',
        statusCode: 503,
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain('sk-live');
  });

  it('reports a timed-out call as timed out after one attempt', async (): Promise<void> => {
    vi.useFakeTimers();
    // The faked clock does not fire `AbortSignal.timeout`, so the provider
    // call is made to fail on its own at the wall, as an aborted fetch does.
    const generate = vi.fn(
      (): Promise<{ object: unknown }> =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('This operation was aborted')), MODEL_CALL_TIMEOUT_MS);
        }),
    );
    const agent = { name: 'day0-skill-runtime', generate } as unknown as Agent;

    const pending = collect(() => agentJson({ agent, user: SECRET_PROMPT, schema: {} }).catch((err: unknown) => err));
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS);
    const { reports, result } = await pending;

    expect((result as Error).name).toBe('TimeoutError');
    expect(reports).toEqual([
      {
        agent: 'day0-skill-runtime',
        attempts: 1,
        retries: 0,
        durationMs: MODEL_CALL_TIMEOUT_MS,
        outcome: 'timed-out',
        errorName: 'TimeoutError',
      },
    ]);
  });

  it('reports a text call too, and nothing when no observer is installed', async (): Promise<void> => {
    const generate = vi.fn().mockResolvedValue({ text: 'done' });
    const agent = { name: 'day0-good-habits', generate } as unknown as Agent;

    const { reports } = await collect(() => agentText({ agent, user: SECRET_PROMPT }));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ agent: 'day0-good-habits', attempts: 1, outcome: 'ok' });

    await expect(agentText({ agent, user: 'unobserved' })).resolves.toBe('done');
  });

  it('keeps concurrent steps\' reports apart', async (): Promise<void> => {
    const generate = vi.fn().mockResolvedValue({ text: 'done' });
    const agent = { name: 'day0-good-habits', generate } as unknown as Agent;
    const seen: Record<string, number> = { a: 0, b: 0 };
    await Promise.all([
      observeModelCalls(
        (): void => {
          seen.a += 1;
        },
        async (): Promise<void> => {
          await agentText({ agent, user: 'a' });
          await agentText({ agent, user: 'a' });
        },
      ),
      observeModelCalls(
        (): void => {
          seen.b += 1;
        },
        async (): Promise<void> => {
          await agentText({ agent, user: 'b' });
        },
      ),
    ]);
    expect(seen).toEqual({ a: 2, b: 1 });
  });

  it('counts the provider requests a call made, including the ones the SDK retried inside it', async (): Promise<void> => {
    // The AI SDK retries a 503 twice of its own accord inside one attempt of
    // ours, so a call that took minutes would otherwise read as one slow call
    // rather than as retries. Observed on a real backend, 18 September 2026.
    const generate = vi.fn(async (): Promise<{ object: { ok: true } }> => {
      countProviderRequest();
      countProviderRequest();
      countProviderRequest();
      return { object: { ok: true } };
    });
    const agent = { name: 'day0-scope-judgement', generate } as unknown as Agent;

    const { reports } = await collect(() => agentJson({ agent, user: SECRET_PROMPT, schema: {} }));

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ attempts: 1, retries: 0, providerCalls: 3 });
  });

  it('counts each attempt\'s provider requests into the one report', async (): Promise<void> => {
    vi.useFakeTimers();
    const generate = vi
      .fn()
      .mockImplementationOnce(async (): Promise<never> => {
        countProviderRequest();
        throw { statusCode: 503, message: 'service unavailable' };
      })
      .mockImplementationOnce(async (): Promise<{ object: { ok: true } }> => {
        countProviderRequest();
        countProviderRequest();
        return { object: { ok: true } };
      });
    const agent = { name: 'day0-plan', generate } as unknown as Agent;
    vi.spyOn(console, 'warn').mockImplementation((): void => {});

    const pending = collect(() => agentJson({ agent, user: SECRET_PROMPT, schema: {} }));
    await vi.advanceTimersByTimeAsync(2_000);
    const { reports } = await pending;

    expect(reports[0]).toMatchObject({ attempts: 2, retries: 1, providerCalls: 3 });
  });

  it('omits the provider count when nothing counted, rather than reporting a wrong one', async (): Promise<void> => {
    const generate = vi.fn().mockResolvedValue({ text: 'done' });
    const agent = { name: 'day0-good-habits', generate } as unknown as Agent;

    const { reports } = await collect(() => agentText({ agent, user: SECRET_PROMPT }));
    expect(reports[0]).not.toHaveProperty('providerCalls');
  });

  it('never lets a failing observer fail the call it observed', async (): Promise<void> => {
    const generate = vi.fn().mockResolvedValue({ text: 'done' });
    const agent = { name: 'day0-good-habits', generate } as unknown as Agent;
    vi.spyOn(console, 'warn').mockImplementation((): void => {});
    await expect(
      observeModelCalls(
        async (): Promise<void> => {
          throw new Error('ledger write refused');
        },
        () => agentText({ agent, user: 'observed' }),
      ),
    ).resolves.toBe('done');
  });
});

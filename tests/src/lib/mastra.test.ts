import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-key';
});
import type { Agent } from '@mastra/core/agent';
import { MastraError } from '@mastra/core/error';
import {
  agentJson,
  agentJsonWithMode,
  agentText,
  MODEL_CALL_TIMEOUT_MS,
  ModelRefusalError,
  ModelReplyCutError,
  resetStructuredModeMemo,
  StructuredOutputInvalidError,
  withModelRetry,
} from '../../../src/lib/mastra';
import {
  countProviderRequest,
  observeModelCalls,
  type ModelCallReport,
} from '../../../src/lib/model-call-telemetry';
import { itemBoundModelFailure, providerEndpointLabel } from '../../../src/lib/structured-fallback';
import { planSchema } from '../../../src/work/plan';

/**
 * The retry wrapper reports every model call to the observer the loop step
 * installed around it: how many attempts it took, how long it held the step,
 * and how it ended. The report is what goes on the item's ledger, so it may
 * name the agent and the failure's class, and nothing of the prompt or the
 * reply.
 */

// A fixed token: a random one can contain a run such as 503 that the retry
// policy reads as a transient status, and the test then backs off past its
// limit (about one gate run in 140).
const secretToken = 'sk-live-fedcbafedcbafedcbafedcbafedcbafe';
const SECRET_PROMPT = `labelled secret: ${secretToken}`;

afterEach((): void => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetStructuredModeMemo();
});

async function collect<T>(
  fn: () => Promise<T>,
): Promise<{ reports: ModelCallReport[]; result: T }> {
  const reports: ModelCallReport[] = [];
  const result = await observeModelCalls((report: ModelCallReport): void => {
    reports.push(report);
  }, fn);
  return { reports, result };
}

describe('model-call telemetry from the retry wrapper', (): void => {
  it('keeps URL credentials and query values out of provider log labels', (): void => {
    const endpoint = `https://operator:${secretToken}@relay.example/v1?key=${secretToken}`;
    expect(providerEndpointLabel(endpoint)).toBe('relay.example');
  });
  it('reports one attempt and the wall-clock duration of a call that succeeds first time', async (): Promise<void> => {
    vi.useFakeTimers();
    const generate = vi.fn(async (): Promise<{ object: { ok: true } }> => {
      await vi.advanceTimersByTimeAsync(1_250);
      return { object: { ok: true } };
    });
    const agent = { name: 'day0-scope-judgement', generate } as unknown as Agent;

    const { reports, result } = await collect(() =>
      agentJson({ agent, user: SECRET_PROMPT, schema: {} }),
    );

    expect(result).toEqual({ ok: true });
    expect(reports).toEqual([
      {
        agent: 'day0-scope-judgement',
        attempts: 1,
        retries: 0,
        durationMs: 1_250,
        outcome: 'ok',
        structuredMode: 'native',
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
        structuredMode: 'native',
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
    expect(JSON.stringify(reports)).not.toContain(secretToken);
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

    const pending = collect(() =>
      agentJson({ agent, user: SECRET_PROMPT, schema: {} }).catch((err: unknown) => err),
    );
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
        structuredMode: 'native',
      },
    ]);
  });

  it('ends a retry followed by a slow request at the call budget, not a fresh one per attempt (U9 step 20)', async (): Promise<void> => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation((): void => {});
    let calls = 0;
    const pending = collect(() =>
      withModelRetry('timeout-after-retry', async () => {
        countProviderRequest();
        if (calls++ === 0) throw { statusCode: 503, message: 'busy' };
        await new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(Object.assign(new Error('request timed out'), { name: 'TimeoutError' })),
            MODEL_CALL_TIMEOUT_MS,
          );
        });
      }).catch(() => undefined),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS);
    const { reports } = await pending;
    expect(reports[0]).toMatchObject({
      attempts: 2,
      retries: 1,
      providerCalls: 2,
      // The second attempt had what the first and its backoff left, not a fresh budget.
      durationMs: MODEL_CALL_TIMEOUT_MS,
      outcome: 'timed-out',
    });
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('ends a call its caller gave less time at that limit, and says which (12-J item 6, option A)', async (): Promise<void> => {
    vi.useFakeTimers();
    const generate = vi.fn((): Promise<{ object: unknown }> => new Promise(() => undefined));
    const agent = { name: 'day0-work-generator', generate } as unknown as Agent;
    const pending = collect(() =>
      agentJson({ agent, user: SECRET_PROMPT, schema: {}, timeoutMs: 80_000 }).catch(
        (err: unknown) => err,
      ),
    );
    await vi.advanceTimersByTimeAsync(80_000);
    const { reports, result } = await pending;
    expect((result as Error).name).toBe('TimeoutError');
    expect((result as Error).message).toContain('the model call reached its 80000ms budget');
    expect(reports[0]).toMatchObject({ durationMs: 80_000, outcome: 'timed-out' });
  });

  it('never lets a call outlive its budget, however many slow attempts it makes (P7-18)', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation((): void => {});
    // Each attempt is refused as busy after 100 s, so five of them and their
    // backoffs would take more than eight minutes, and the SDK's own retries
    // inside each would take longer still.
    const generate = vi.fn(
      (): Promise<{ object: unknown }> =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject({ statusCode: 503, message: 'busy' }), 100_000);
        }),
    );
    const agent = { name: 'day0-skill-runtime', generate } as unknown as Agent;
    const pending = collect(() =>
      agentJson({ agent, user: SECRET_PROMPT, schema: {} }).catch((err: unknown) => err),
    );
    await vi.advanceTimersByTimeAsync(MODEL_CALL_TIMEOUT_MS);
    const { reports, result } = await pending;
    expect((result as Error).name).toBe('TimeoutError');
    expect(generate).toHaveBeenCalledTimes(3);
    expect(reports).toEqual([
      expect.objectContaining({
        attempts: 3,
        durationMs: MODEL_CALL_TIMEOUT_MS,
        outcome: 'timed-out',
      }),
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

  it("keeps concurrent steps' reports apart", async (): Promise<void> => {
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

  it("counts each attempt's provider requests into the one report", async (): Promise<void> => {
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

  it('keeps provider request counts separate for overlapping calls', async (): Promise<void> => {
    let releaseFirst = (): void => {};
    let releaseSecond = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let firstStarted = (): void => {};
    let secondStarted = (): void => {};
    const firstReady = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondReady = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const first = collect(() =>
      withModelRetry('first', async () => {
        countProviderRequest();
        firstStarted();
        await firstGate;
        countProviderRequest();
      }),
    );
    const second = collect(() =>
      withModelRetry('second', async () => {
        countProviderRequest();
        secondStarted();
        await secondGate;
        countProviderRequest();
        countProviderRequest();
      }),
    );
    await Promise.all([firstReady, secondReady]);
    releaseSecond();
    releaseFirst();
    const [one, two] = await Promise.all([first, second]);
    expect(one.reports[0]?.providerCalls).toBe(2);
    expect(two.reports[0]?.providerCalls).toBe(3);
  });

  it('does not leak a provider error body or prompt secret to reports or warning logs', async (): Promise<void> => {
    const warning = vi.spyOn(console, 'warn').mockImplementation((): void => {});
    const providerError = Object.assign(
      new Error(`provider rejected ${secretToken}; ${SECRET_PROMPT}`),
      {
        name: `Injected${secretToken}`,
        statusCode: 400,
      },
    );
    const { reports } = await collect(() =>
      withModelRetry('privacy-check', async () => {
        throw providerError;
      }).catch(() => undefined),
    );
    expect(JSON.stringify(reports)).not.toContain(secretToken);
    expect(reports[0]?.errorName).toBe('Error');

    const retryError = Object.assign(new Error(`provider temporarily rejected ${secretToken}`), {
      statusCode: 503,
    });
    let called = 0;
    vi.useFakeTimers();
    const retried = collect(() =>
      withModelRetry('privacy-retry', async () => {
        if (called++ === 0) throw retryError;
        return 'ok';
      }),
    );
    // 2 s after the transient failure: the policy's first backoff, on the faked clock.
    await vi.advanceTimersByTimeAsync(2_000);
    await retried;
    const warnings = warning.mock.calls
      .flat()
      .map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : String(value)))
      .join('\n');
    expect(warnings).not.toContain(secretToken);
    expect(warnings).not.toContain(SECRET_PROMPT);
  });

  it('counts requests across separately evaluated copies of the telemetry module', async (): Promise<void> => {
    const pending = collect(() =>
      withModelRetry('cross-module', async () => {
        vi.resetModules();
        const fresh = await import('../../../src/lib/model-call-telemetry');
        fresh.countProviderRequest();
      }),
    );
    const { reports } = await pending;
    expect(reports[0]?.providerCalls).toBe(1);
  });

  it('does not carry an observer into a later call after its scope finishes', async (): Promise<void> => {
    const seen: ModelCallReport[] = [];
    await observeModelCalls(
      (report) => {
        seen.push(report);
      },
      async () => {
        vi.resetModules();
        const fresh = await import('../../../src/lib/model-call-telemetry');
        await fresh.reportModelCall({
          agent: 'inside',
          attempts: 1,
          startedAt: Date.now(),
          providerCalls: 0,
        });
      },
    );
    const fresh = await import('../../../src/lib/model-call-telemetry');
    await fresh.reportModelCall({
      agent: 'outside',
      attempts: 1,
      startedAt: Date.now(),
      providerCalls: 0,
    });
    expect(seen.map((report) => report.agent)).toEqual(['inside']);
  });

  it('fails when a work scope loses its observer across module evaluation', async (): Promise<void> => {
    const key = Symbol.for('day0.model-call-observers');
    const globals = globalThis as { [key: symbol]: unknown };
    const original = globals[key];
    try {
      await observeModelCalls(
        () => {},
        async () => {
          globals[key] = new AsyncLocalStorage();
          vi.resetModules();
          const fresh = await import('../../../src/lib/model-call-telemetry');
          await expect(
            fresh.reportModelCall({
              agent: 'lost-observer',
              attempts: 1,
              startedAt: Date.now(),
              providerCalls: 0,
            }),
          ).rejects.toThrow('model-call observer missing');
        },
      );
    } finally {
      globals[key] = original;
      vi.resetModules();
    }
  });

  it('does not print a failing observer error body', async (): Promise<void> => {
    const warning = vi.spyOn(console, 'log').mockImplementation((): void => {});
    await expect(
      observeModelCalls(
        async () => {
          throw new Error(`ledger rejected ${secretToken}`);
        },
        () => withModelRetry('observer-failure', async () => 'ok'),
      ),
    ).resolves.toBe('ok');
    const output = warning.mock.calls.flat().map(String).join('\n');
    expect(output).not.toContain(secretToken);
    expect(output).toContain('observer failed');
  });

  it('does not log a provider response body from structured output fallback', async (): Promise<void> => {
    const output = vi.spyOn(console, 'log').mockImplementation((): void => {});
    const providerError = Object.assign(new Error(`provider response: ${secretToken}`), {
      statusCode: 401,
    });
    const agent = {
      name: 'day0-plan',
      generate: vi.fn().mockRejectedValue(providerError),
    } as unknown as Agent;
    await collect(() =>
      agentJson({ agent, user: SECRET_PROMPT, schema: {} }).catch(() => undefined),
    );
    expect(output.mock.calls.flat().join('\n')).not.toContain(secretToken);
    expect(output.mock.calls.flat().join('\n')).not.toContain(SECRET_PROMPT);
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

describe('replies the provider did not finish', (): void => {
  /** An AI SDK call error carrying a server's JSON body inside an HTTP 200. */
  function errorInsideOk(body: unknown): Error {
    return Object.assign(new Error('Invalid JSON response'), {
      statusCode: 200,
      responseBody: JSON.stringify(body),
      isRetryable: false,
      requestBodyValues: { response_format: { type: 'json_schema' } },
    });
  }

  it('refuses a structured reply cut at the output limit without a prompt-mode attempt', async (): Promise<void> => {
    const generate = vi.fn().mockResolvedValue({
      object: { rows: ['first'] },
      finishReason: 'length',
      text: '{"rows":["first"',
    });
    const agent = { name: 'day0-plan', generate } as unknown as Agent;

    await expect(agentJson({ agent, user: 'plan', schema: {} })).rejects.toBeInstanceOf(
      ModelReplyCutError,
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('refuses a content-filter finish as the provider refusing, with the text it gave', async (): Promise<void> => {
    const generate = vi
      .fn()
      .mockResolvedValue({ finishReason: 'content-filter', text: 'I cannot help with that.' });
    const agent = { name: 'day0-plan', generate } as unknown as Agent;

    const refused = agentJson({ agent, user: 'plan', schema: {} });

    await expect(refused).rejects.toBeInstanceOf(ModelRefusalError);
    await expect(refused).rejects.toMatchObject({ refusal: 'I cannot help with that.' });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('turns a moderation 400 into a refusal and never re-sends it in prompt mode', async (): Promise<void> => {
    const generate = vi.fn().mockRejectedValue(
      Object.assign(new Error('Bad Request'), {
        statusCode: 400,
        responseBody: '{"code":"DataInspectionFailed","message":"输入数据可能包含不当内容"}',
        requestBodyValues: { response_format: { type: 'json_schema' } },
      }),
    );
    const agent = { name: 'day0-plan', generate } as unknown as Agent;

    await expect(agentJson({ agent, user: 'plan', schema: {} })).rejects.toBeInstanceOf(
      ModelRefusalError,
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('retries an error inside a 200 that says the server is busy, then uses the answer', async (): Promise<void> => {
    vi.useFakeTimers();
    const generate = vi
      .fn()
      .mockRejectedValueOnce(errorInsideOk({ error: { message: 'Server busy, please retry' } }))
      .mockResolvedValueOnce({ object: { ok: true }, finishReason: 'stop' });
    const agent = { name: 'day0-plan', generate } as unknown as Agent;

    const result = agentJson<{ ok: boolean }>({ agent, user: 'plan', schema: {} });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toEqual({ ok: true });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not retry an error inside a 200 whose body names a request status', async (): Promise<void> => {
    const generate = vi
      .fn()
      .mockRejectedValue(errorInsideOk({ error: { code: 400, message: '参数错误' } }));
    const agent = { name: 'day0-plan', generate } as unknown as Agent;

    await expect(agentJson({ agent, user: 'plan', schema: {} })).rejects.toMatchObject({
      statusCode: 200,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps what the model said when a reply held no object', async (): Promise<void> => {
    const generate = vi
      .fn()
      .mockResolvedValue({ finishReason: 'stop', text: 'Sorry, I will not plan this ticket.' });
    const agent = { name: 'day0-plan', generate } as unknown as Agent;

    await expect(
      agentJsonWithMode({ agent, user: 'plan', schema: {}, mode: 'prompt' }),
    ).rejects.toMatchObject({ reply: 'Sorry, I will not plan this ticket.' });
  });

  it('refuses plain text cut at the output limit', async (): Promise<void> => {
    const generate = vi.fn().mockResolvedValue({ finishReason: 'length', text: '## Good-habits' });
    const agent = { name: 'day0-good-habits', generate } as unknown as Agent;

    await expect(agentText({ agent, user: 'distil' })).rejects.toBeInstanceOf(ModelReplyCutError);
  });
});

describe('the structured-output mode on the report', (): void => {
  it('says which rung produced each object, and marks the call that moved the agent to the prompt rung', async (): Promise<void> => {
    vi.spyOn(console, 'log').mockImplementation((): void => {});
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ finishReason: 'stop', text: 'Sure! Here is prose.' })
      .mockResolvedValueOnce({ object: { ok: true }, finishReason: 'stop' })
      .mockResolvedValueOnce({ object: { ok: true }, finishReason: 'stop' });
    const agent = { name: 'day0-mode-flip', generate } as unknown as Agent;

    const { reports } = await collect(async () => {
      await agentJson({ agent, user: SECRET_PROMPT, schema: {} });
      await agentJson({ agent, user: SECRET_PROMPT, schema: {} });
    });

    const call = {
      agent: 'day0-mode-flip',
      attempts: 1,
      retries: 0,
      durationMs: expect.any(Number),
    };
    expect(reports).toEqual([
      {
        ...call,
        outcome: 'failed',
        errorName: 'StructuredOutputMissingError',
        structuredMode: 'native',
      },
      { ...call, outcome: 'ok', structuredMode: 'prompt', fellBack: true, demoted: true },
      { ...call, outcome: 'ok', structuredMode: 'prompt' },
    ]);
  });

  it('marks a fallback that proved nothing without calling it a demotion', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation((): void => {});
    vi.spyOn(console, 'log').mockImplementation((): void => {});
    const busy = Object.assign(new Error('busy'), {
      statusCode: 503,
      requestBodyValues: { response_format: { type: 'json_schema' } },
    });
    const generate = vi
      .fn()
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ object: { ok: true }, finishReason: 'stop' });
    const agent = { name: 'day0-busy-native', generate } as unknown as Agent;

    const pending = collect(() => agentJson({ agent, user: SECRET_PROMPT, schema: {} }));
    for (const delay of [2_000, 4_000, 8_000, 16_000]) await vi.advanceTimersByTimeAsync(delay);
    const { reports } = await pending;

    expect(reports.at(-1)).toMatchObject({
      outcome: 'ok',
      structuredMode: 'prompt',
      fellBack: true,
    });
    expect(reports.at(-1)).not.toHaveProperty('demoted');
  });

  it('keeps the class of a typed model failure and nothing of its text', async (): Promise<void> => {
    const generate = vi
      .fn()
      .mockResolvedValue({ finishReason: 'length', text: `${SECRET_PROMPT} {"a":` });
    const agent = { name: 'day0-cut-reply', generate } as unknown as Agent;

    const { reports } = await collect(() =>
      agentText({ agent, user: SECRET_PROMPT }).catch(() => undefined),
    );

    expect(reports).toEqual([
      expect.objectContaining({ outcome: 'failed', errorName: 'ModelReplyCutError' }),
    ]);
    expect(JSON.stringify(reports)).not.toContain(secretToken);
  });
});

describe('the bill on the report', (): void => {
  it("puts the provider's token usage on each call's report, the attempt with no object included", async (): Promise<void> => {
    vi.spyOn(console, 'log').mockImplementation((): void => {});
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: 'Sure! Here is prose.',
        totalUsage: { inputTokens: 1_200, outputTokens: 40, totalTokens: 1_240 },
      })
      .mockResolvedValueOnce({
        object: { ok: true },
        finishReason: 'stop',
        usage: {
          inputTokens: 1_500,
          outputTokens: 60,
          totalTokens: 1_560,
          cachedInputTokens: 1_024,
        },
      });
    const agent = { name: 'day0-metered', generate } as unknown as Agent;

    const { reports } = await collect(() => agentJson({ agent, user: SECRET_PROMPT, schema: {} }));

    expect(
      reports.map(({ inputTokens, outputTokens, cachedInputTokens }) => ({
        inputTokens,
        outputTokens,
        cachedInputTokens,
      })),
    ).toEqual([
      { inputTokens: 1_200, outputTokens: 40, cachedInputTokens: undefined },
      { inputTokens: 1_500, outputTokens: 60, cachedInputTokens: 1_024 },
    ]);
  });

  it('leaves the token fields off when the provider reported no usage', async (): Promise<void> => {
    const generate = vi.fn().mockResolvedValue({ text: 'done' });
    const agent = { name: 'day0-unmetered-provider', generate } as unknown as Agent;

    const { reports } = await collect(() => agentText({ agent, user: SECRET_PROMPT }));

    expect(reports[0]).not.toHaveProperty('inputTokens');
    expect(reports[0]).not.toHaveProperty('outputTokens');
  });

  it('logs the report of a call no loop step observes, and nothing of the prompt', async (): Promise<void> => {
    const output = vi.spyOn(console, 'log').mockImplementation((): void => {});
    const generate = vi.fn().mockResolvedValue({
      text: 'done',
      usage: { inputTokens: 900, outputTokens: 12, totalTokens: 912 },
    });
    const agent = { name: 'day0-orientation', generate } as unknown as Agent;

    await agentText({ agent, user: SECRET_PROMPT });

    const lines = output.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'info',
        msg: 'model-call',
        agent: 'day0-orientation',
        outcome: 'ok',
        inputTokens: 900,
        outputTokens: 12,
      }),
    );
    expect(JSON.stringify(lines)).not.toContain(secretToken);
  });
});

describe('a reply the schema refused', (): void => {
  /** The violation as Mastra raises it: its own error, with the schema's parse error as the cause. */
  function mastraViolation(value: unknown): MastraError {
    const parsed = planSchema.safeParse(value);
    return new MastraError(
      {
        domain: 'AGENT',
        category: 'SYSTEM',
        id: 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED',
        text: 'Structured output validation failed: - steps: the plan had 9 steps; the most is 8',
        details: { value: JSON.stringify(value) },
      },
      parsed.error,
    );
  }

  it("carries the schema's reason to the card, not the generic text", async (): Promise<void> => {
    const nineSteps = {
      summary: 'Nine steps.',
      steps: Array.from({ length: 9 }, (_, index): string => `Step ${index + 1}.`),
      expectedOutputType: 'message',
      riskNotes: '',
      reversibility: '',
      estimatedMinutes: 9,
    };
    const generate = vi.fn().mockRejectedValue(mastraViolation(nineSteps));
    const agent = { name: 'day0-plan', generate } as unknown as Agent;

    const refused = await agentJsonWithMode({
      agent,
      user: 'plan',
      schema: planSchema,
      mode: 'native',
    }).catch((err: unknown): unknown => err);

    expect(refused).toBeInstanceOf(StructuredOutputInvalidError);
    expect(refused).toMatchObject({ issues: ['the plan had 9 steps; the most is 8'] });
    expect(itemBoundModelFailure(refused)).toBe(
      "the model's reply held no valid structured object: the plan had 9 steps; the most is 8",
    );
  });

  it('keeps the generic text when the violation carries no parse error', (): void => {
    const bare = Object.assign(new Error('Structured output validation failed'), {
      id: 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED',
    });

    expect(new StructuredOutputInvalidError('day0-plan', 'native', bare).issues).toEqual([]);
    expect(
      itemBoundModelFailure(new StructuredOutputInvalidError('day0-plan', 'native', bare)),
    ).toBe("the model's reply held no valid structured object");
  });
});

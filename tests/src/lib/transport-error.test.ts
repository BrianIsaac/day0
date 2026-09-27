import { describe, expect, it } from 'vitest';
import {
  fetchWithBackoff,
  interruptedReadError,
  isTransportUnreachable,
  PROVIDER_BACKOFF,
  retryAfterMs,
  TransientProviderError,
  transientFromResponse,
  transportFailureKind,
  withBackoff,
} from '../../../src/lib/transport-error';

describe('transport failure classification', (): void => {
  it('walks causes and accepts the MCP client wording without classifying provider refusals', (): void => {
    expect(
      isTransportUnreachable(
        new Error('request failed', { cause: new Error('connect ECONNREFUSED 172.18.0.9:3000') }),
      ),
    ).toBe(true);
    expect(
      isTransportUnreachable(
        'Failed to connect to MCP server docs: Could not connect to server with any available HTTP transport',
      ),
    ).toBe(true);
    expect(isTransportUnreachable(new Error('Documentation provider returned 401'))).toBe(false);
  });

  it('tells a connection nobody answered from a read that was cut off', (): void => {
    const coded = (message: string, code: string): Error =>
      Object.assign(new Error(message), { code });
    expect(transportFailureKind(coded('connect ECONNREFUSED 10.0.0.9:3000', 'ECONNREFUSED'))).toBe(
      'refused',
    );
    expect(transportFailureKind(new Error('getaddrinfo ENOTFOUND docs-notion-mcp'))).toBe(
      'refused',
    );
    expect(
      transportFailureKind(
        new Error('request failed', { cause: coded('read ECONNRESET', 'ECONNRESET') }),
      ),
    ).toBe('interrupted');
    expect(transportFailureKind(coded('socket hang up', 'ECONNRESET'))).toBe('interrupted');
    expect(transportFailureKind(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(
      'interrupted',
    );
    expect(transportFailureKind(new Error('Documentation provider returned 401'))).toBeUndefined();
  });
});

describe('Retry-After', (): void => {
  it('reads delta seconds and an HTTP date, and nothing else', (): void => {
    const now = Date.parse('2026-09-28T01:00:00Z');
    expect(retryAfterMs('3', now)).toBe(3_000);
    expect(retryAfterMs('Mon, 28 Sep 2026 01:00:05 GMT', now)).toBe(5_000);
    expect(retryAfterMs('Mon, 28 Sep 2026 00:59:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });

  it('classes a 429 and a 5xx as transient with the wait they ask for, and a 4xx as not', (): void => {
    const limited = transientFromResponse(
      new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }),
      'Slack conversations.history',
    );
    expect(limited).toBeInstanceOf(TransientProviderError);
    expect(limited?.retryAfterMs).toBe(2_000);
    expect(limited?.message).toBe('Slack conversations.history was rate limited (HTTP 429).');
    expect(transientFromResponse(new Response('{}', { status: 503 }), 'x')?.status).toBe(503);
    expect(transientFromResponse(new Response('{}', { status: 404 }), 'x')).toBeUndefined();
  });
});

describe('one bounded backoff', (): void => {
  it('waits what the provider asks, then gets the answer, so one 429 costs one request', async (): Promise<void> => {
    const waits: number[] = [];
    let calls = 0;
    const answer = await withBackoff(
      async (): Promise<string> => {
        calls += 1;
        if (calls === 1) throw new TransientProviderError('rate limited', { retryAfterMs: 1_500 });
        return 'read';
      },
      { ...PROVIDER_BACKOFF, sleep: async (ms): Promise<void> => void waits.push(ms) },
    );
    expect(answer).toBe('read');
    expect(calls).toBe(2);
    expect(waits).toEqual([1_500]);
  });

  it('backs off exponentially without a Retry-After and gives up after the attempts', async (): Promise<void> => {
    const waits: number[] = [];
    const failing = withBackoff(
      async (): Promise<never> => {
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      },
      { attempts: 3, baseMs: 1_000, maxWaitMs: 30_000, sleep: async (ms) => void waits.push(ms) },
    );
    await expect(failing).rejects.toThrow('read ECONNRESET');
    expect(waits).toEqual([1_000, 2_000]);
  });

  it('never retries a refusal, and never sleeps longer than the cap', async (): Promise<void> => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => void waits.push(ms);
    await expect(
      withBackoff(
        async (): Promise<never> => {
          throw new Error('Slack returned invalid_auth');
        },
        { ...PROVIDER_BACKOFF, sleep },
      ),
    ).rejects.toThrow('invalid_auth');
    await expect(
      withBackoff(
        async (): Promise<never> => {
          throw new TransientProviderError('rate limited', { retryAfterMs: 120_000 });
        },
        { ...PROVIDER_BACKOFF, sleep },
      ),
    ).rejects.toThrow('rate limited');
    expect(waits).toEqual([]);
  });
});

describe('an interrupted read', (): void => {
  it('is worded as a transient with its cause, and nothing else is', (): void => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const worded = interruptedReadError(new Error('request failed', { cause: reset }), 'The read');
    expect(worded?.message).toBe(
      'The read was interrupted (read ECONNRESET); this is transient, and the next attempt reads it again.',
    );
    expect(worded?.cause).toBeInstanceOf(Error);
    const limited = new TransientProviderError('rate limited');
    expect(interruptedReadError(limited)).toBe(limited);
    expect(interruptedReadError(new Error('connect ECONNREFUSED 10.0.0.1:3000'))).toBeUndefined();
    expect(interruptedReadError(new Error('HTTP 401'))).toBeUndefined();
  });
});

describe('a fetch with one bounded backoff', (): void => {
  it('waits the Retry-After of a 429 with a fresh timeout per try, and returns the answer', async (): Promise<void> => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const waits: number[] = [];
    let calls = 0;
    const fetcher = fetchWithBackoff(
      async (_input, init): Promise<Response> => {
        signals.push(init?.signal);
        calls += 1;
        return calls === 1
          ? new Response('{}', { status: 429, headers: { 'Retry-After': '1' } })
          : new Response('{"ok":true}', { status: 200 });
      },
      10_000,
      { ...PROVIDER_BACKOFF, sleep: async (ms): Promise<void> => void waits.push(ms) },
    );
    const response = await fetcher('https://slack.com/api/conversations.history');
    expect(response.status).toBe(200);
    expect(waits).toEqual([1_000]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('lets go of a refused answer before the next try, and keeps the last one readable', async (): Promise<void> => {
    const answers = [
      new Response('first', { status: 429 }),
      new Response('second', { status: 503 }),
      new Response('third', { status: 429 }),
    ];
    const handed = [...answers];
    const fetcher = fetchWithBackoff(async (): Promise<Response> => handed.shift()!, 10_000, {
      ...PROVIDER_BACKOFF,
      sleep: async (): Promise<void> => undefined,
    });
    const last = await fetcher('https://slack.com/api/x');
    expect(answers[0]!.bodyUsed).toBe(true);
    expect(answers[1]!.bodyUsed).toBe(true);
    expect(await last.text()).toBe('third');
  });

  it('returns the last 429 once the tries are spent', async (): Promise<void> => {
    const fetcher = fetchWithBackoff(
      async (): Promise<Response> => new Response('{}', { status: 429 }),
      10_000,
      { ...PROVIDER_BACKOFF, sleep: async (): Promise<void> => undefined },
    );
    expect((await fetcher('https://slack.com/api/x')).status).toBe(429);
  });
});

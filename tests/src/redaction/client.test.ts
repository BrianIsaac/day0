import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpSpanModel, RedactorUnavailableError } from '../../../src/redaction/client';
import { redactText } from '../../../src/redaction/redact';
import {
  routeSpanModelFetch,
  serveSpanModel,
  SPAN_MODEL_TEST_URL,
  spanModelFetch,
} from '../../fixtures/redaction-double';

describe('span response validation', () => {
  it.each([
    { start: -1, end: 7, label: 'password', score: 0.9 },
    { start: 0.5, end: 7, label: 'password', score: 0.9 },
    { start: 0, end: 100, label: 'password', score: 0.9 },
    { start: 0, end: 7, label: 'password', score: 2 },
    { start: 0, end: 7, label: 'unexpected', score: 0.9 },
  ])('fails closed for an invalid span: %j', async (span) => {
    const model = new HttpSpanModel('http://redactor:8000', async () =>
      Response.json({ spans: [span] }),
    );
    await expect(
      redactText('hunter2', 'documentation', { model, onUnavailable: 'throw' }),
    ).rejects.toBeInstanceOf(RedactorUnavailableError);
    expect(
      await redactText('hunter2', 'outcome', { model, onUnavailable: 'structural' }),
    ).toMatchObject({ degraded: 'structural-only' });
  });

  it('bounds the whole request including a body that never finishes', async () => {
    const model = new HttpSpanModel(
      'http://redactor:8000',
      async () => new Response(new ReadableStream()),
      10,
    );
    const result = await Promise.race([
      redactText('known-value', 'outcome', {
        model,
        known: ['known-value'],
        onUnavailable: 'structural',
      }),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 100)),
    ]);
    expect(result).toMatchObject({ text: '<redacted>', degraded: 'structural-only' });
  });
});

describe('one more try for the redaction component', () => {
  const span = { start: 0, end: 7, label: 'password', score: 0.9 };
  const noWait = {
    attempts: 2,
    baseMs: 0,
    maxWaitMs: 1_000,
    sleep: async (): Promise<void> => undefined,
  };

  it('reads the spans after a reset connection or a 503', async () => {
    for (const first of [
      async (): Promise<Response> => {
        throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      },
      async (): Promise<Response> => new Response('busy', { status: 503 }),
    ]) {
      let calls = 0;
      const model = new HttpSpanModel(
        'http://redactor:8000',
        async (): Promise<Response> =>
          (calls += 1) === 1 ? await first() : Response.json({ spans: [span] }),
        1_000,
        noWait,
      );
      await expect(model.spans('hunter2', ['password'], 0.4)).resolves.toEqual([span]);
      expect(calls).toBe(2);
    }
  });

  it('does not try a refused body again', async () => {
    let calls = 0;
    const model = new HttpSpanModel(
      'http://redactor:8000',
      async (): Promise<Response> => {
        calls += 1;
        return new Response('too large', { status: 413 });
      },
      1_000,
      noWait,
    );
    await expect(model.spans('hunter2', ['password'], 0.4)).rejects.toThrow('HTTP 413');
    expect(calls).toBe(1);
  });
});

describe('the span model double answered in-process (the test transport)', () => {
  const BASE = SPAN_MODEL_TEST_URL;
  const viaHandler = (answer: (request: Request) => Promise<Response>): HttpSpanModel =>
    new HttpSpanModel(BASE, (input: URL, init: RequestInit) => answer(new Request(input, init)));

  afterEach((): void => {
    vi.useRealTimers();
  });

  it('reads the spans with setTimeout faked and the clock never advanced', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const spans = await viaHandler(spanModelFetch()).spans(
      'the password is hunter2',
      ['password'],
      0.5,
    );
    expect(spans).toEqual([{ start: 16, end: 23, label: 'password', score: 0.9 }]);
  });

  it('answers every request as the served double does', async () => {
    const served = await serveSpanModel();
    const answer = spanModelFetch();
    try {
      const requests: ReadonlyArray<readonly [string, RequestInit]> = [
        [
          '/v1/spans',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: 'reach Priya on +65 9123 4567',
              labels: ['person', 'phone number'],
              threshold: 0.5,
            }),
          },
        ],
        ['/v1/spans', { method: 'POST', body: 'not json' }],
        ['/v1/spans?threshold=0.5', { method: 'POST', body: '{}' }],
        ['/healthz', { method: 'GET' }],
        ['/v1/unknown', { method: 'GET' }],
      ];
      for (const [path, init] of requests) {
        const overSocket = await fetch(`${served.url}${path}`, init);
        const inProcess = await answer(new Request(`${BASE}${path}`, init));
        expect([inProcess.status, await inProcess.json()]).toEqual([
          overSocket.status,
          await overSocket.json(),
        ]);
      }
    } finally {
      await served.close();
    }
  });
});

describe('the global fetch a test routes to the in-process span model', () => {
  /** A fallback that answers every request itself and records the address it was asked. */
  const recordingFallback = (): { readonly fetch: typeof fetch; readonly asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        asked.push(input instanceof Request ? input.url : String(input));
        return new Response('from the fallback');
      },
    };
  };

  afterEach((): void => {
    vi.useRealTimers();
  });

  it('answers the reserved address in-process with setTimeout faked, asking the fallback nothing', async () => {
    const fallback = recordingFallback();
    const routed = routeSpanModelFetch(fallback.fetch);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const model = new HttpSpanModel(SPAN_MODEL_TEST_URL, (input: URL, init: RequestInit) =>
      routed(input, init),
    );

    await expect(model.spans('the password is hunter2', ['password'], 0.5)).resolves.toEqual([
      { start: 16, end: 23, label: 'password', score: 0.9 },
    ]);
    const health = await routed(`${SPAN_MODEL_TEST_URL}/healthz`);
    expect(await health.json()).toMatchObject({ ok: true, model: 'recorded' });
    expect(fallback.asked).toEqual([]);
  });

  it('hands every other address to the fallback untouched, in any of the three shapes', async () => {
    const fallback = recordingFallback();
    const routed = routeSpanModelFetch(fallback.fetch);

    const responses = await Promise.all([
      routed('https://wiki.example/one'),
      routed(new URL('http://redactor.test:8001/v1/spans')),
      routed(new Request('http://127.0.0.1:8000/v1/spans', { method: 'POST', body: '{}' })),
    ]);

    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      'from the fallback',
      'from the fallback',
      'from the fallback',
    ]);
    expect(fallback.asked).toEqual([
      'https://wiki.example/one',
      'http://redactor.test:8001/v1/spans',
      'http://127.0.0.1:8000/v1/spans',
    ]);
  });
});

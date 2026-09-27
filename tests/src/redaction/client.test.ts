import { describe, expect, it } from 'vitest';
import { HttpSpanModel, RedactorUnavailableError } from '../../../src/redaction/client';
import { redactText } from '../../../src/redaction/redact';

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

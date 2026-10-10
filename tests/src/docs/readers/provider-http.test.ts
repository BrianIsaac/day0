import { describe, expect, it } from 'vitest';
import { PageTooLargeError } from '../../../../src/docs/readers/page-address';
import {
  AnswerTooLargeError,
  answerText,
  field,
  listField,
  providerBody,
  ProviderGatewayError,
  ProviderHttp,
  ProviderUnreachableError,
  textField,
  type ProviderAnswer,
} from '../../../../src/docs/readers/provider-http';
import { TransientProviderError } from '../../../../src/lib/transport-error';

const URL_A = new URL('https://api.example.test/v1/pages');

/** A connection whose clock moves only when it waits, over the answers a test queues. */
function connection(
  answers: Array<Response | Error>,
  spacingMs = 0,
  batchBudgetMs?: number,
): { http: ProviderHttp; sleeps: number[]; sent: RequestInit[] } {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const sent: RequestInit[] = [];
  const http = new ProviderHttp('Example', spacingMs, {
    fetch: async (_input: URL, init: RequestInit): Promise<Response> => {
      sent.push(init);
      const next = answers.shift();
      if (next === undefined) throw new Error('the test queued no further answer');
      if (next instanceof Error) throw next;
      return next;
    },
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
    batchBudgetMs,
  });
  return { http, sleeps, sent };
}

/** An answer with this body, as `providerBody` reads one. */
function answered(status: number, body: string): ProviderAnswer {
  return { url: URL_A, status, headers: new Headers(), bytes: new TextEncoder().encode(body) };
}

describe('a reader’s connection to its provider', (): void => {
  it('hands back an answer of any other status for the reader to word, and follows no redirect', async (): Promise<void> => {
    const { http, sent } = connection([new Response('{"message":"no"}', { status: 404 })]);
    const answer = await http.send(URL_A, { headers: { authorization: 'Bearer fixture-token' } });
    expect([answer.status, answerText(answer)]).toEqual([404, '{"message":"no"}']);
    expect(sent[0]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(new Headers(sent[0].headers).get('authorization')).toBe('Bearer fixture-token');
  });

  it('waits the time a 429 or a 503 names, and its own doubling wait when none is named', async (): Promise<void> => {
    const { http, sleeps } = connection([
      new Response('', { status: 429, headers: { 'retry-after': '12' } }),
      new Response('', { status: 503 }),
      new Response('', { status: 502, headers: { 'retry-after': '4' } }),
      new Response('{}', { status: 200 }),
    ]);
    expect((await http.send(URL_A)).status).toBe(200);
    expect(sleeps).toEqual([12_000, 2_000, 4_000]);
  });

  it("waits out a provider's own limit, which the reader names", async (): Promise<void> => {
    const { http, sleeps } = connection([
      new Response('{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}', { status: 403 }),
      new Response('{}', { status: 200 }),
    ]);
    const answer = await http.send(URL_A, {
      limited: (each): boolean => answerText(each).includes('userRateLimitExceeded'),
    });
    expect([answer.status, sleeps]).toEqual([200, [1_000]]);
  });

  it('gives up on a limit that outlasts its tries, a wait past a minute, or the batch budget', async (): Promise<void> => {
    const always = (): Response =>
      new Response('', { status: 429, headers: { 'retry-after': '1' } });
    await expect(
      connection([always(), always(), always(), always()]).http.send(URL_A),
    ).rejects.toThrow('Example was rate limited (HTTP 429).');
    const long = connection([new Response('', { status: 429, headers: { 'retry-after': '600' } })]);
    await expect(long.http.send(URL_A)).rejects.toBeInstanceOf(TransientProviderError);
    expect(long.sleeps).toEqual([]);
    const spent = connection([new Response('', { status: 503 })], 0, 500);
    await expect(spent.http.send(URL_A)).rejects.toThrow('Example answered HTTP 503.');
    expect(spent.sleeps).toEqual([]);
  });

  it('spaces its requests by the provider’s limit', async (): Promise<void> => {
    const { http, sleeps } = connection(
      [new Response('{}'), new Response('{}'), new Response('{}')],
      200,
    );
    await http.send(URL_A);
    await http.send(URL_A);
    await http.send(URL_A);
    expect(sleeps).toEqual([200, 200]);
  });

  it('says a host nothing answered at could not be reached, with what IT allows (W14-R39)', async (): Promise<void> => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:443'), {
        code: 'ECONNREFUSED',
      }),
    });
    const { http } = connection([refused]);
    const failure = await http.send(URL_A).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderUnreachableError);
    expect((failure as Error).message).toBe(
      "Day0 could not reach api.example.test: connect ECONNREFUSED 10.0.0.7:443. The machine Day0's backend runs on must reach api.example.test directly over HTTPS, with no proxy in between: ask IT to allow it.",
    );
  });

  it('tries a read cut off in flight again, and words one that keeps failing as the transient it is', async (): Promise<void> => {
    const reset = (): Error =>
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      });
    const recovered = connection([reset(), new Response('{}')]);
    expect((await recovered.http.send(URL_A)).status).toBe(200);
    const { http } = connection([reset(), reset(), reset(), reset()]);
    await expect(http.send(URL_A)).rejects.toThrow(
      'The read of api.example.test was interrupted (read ECONNRESET); this is transient, and the next attempt reads it again.',
    );
  });

  it('refuses an answer larger than the request’s bound', async (): Promise<void> => {
    const { http } = connection([new Response('x'.repeat(2_000))]);
    await expect(http.send(URL_A, { maxBytes: 1_000 })).rejects.toBeInstanceOf(AnswerTooLargeError);
  });

  it('says a body its own fetch bounded is too large, once, whatever its address holds (W15-R11)', async (): Promise<void> => {
    // The checked page fetch errors its stream past its bound; a download address may hold any
    // words, a transport marker among them, and the answer is still too large, not a transient.
    const address = new URL('https://files.example.test/terminated-contracts.docx');
    const { http, sent } = connection([
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new Uint8Array(10));
            controller.error(new PageTooLargeError(address, 16 * 1024 * 1024));
          },
        }),
      ),
    ]);
    await expect(http.send(address)).rejects.toBeInstanceOf(AnswerTooLargeError);
    expect(sent).toHaveLength(1);
  });
});

describe('an answer’s body', (): void => {
  it('is the provider’s JSON, or nothing when the answer has none', (): void => {
    expect(providerBody('Example', answered(200, '{"results":[{"id":"1"}]}'))).toEqual({
      results: [{ id: '1' }],
    });
    expect(providerBody('Example', answered(401, ''))).toBeUndefined();
  });

  it('is never read as the provider’s when it is a page from something in between (W14-R9)', (): void => {
    for (const body of ['<html>Blocked</html>', '"just a string"', 'null']) {
      expect(() => providerBody('Example', answered(403, body))).toThrow(ProviderGatewayError);
    }
  });

  it('is read field by field without trusting its shape', (): void => {
    const body: unknown = { title: 'Close', version: { number: 7 }, results: [1, 2] };
    expect(textField(body, 'title')).toBe('Close');
    expect(textField(body, 'version')).toBeUndefined();
    expect(field(field(body, 'version'), 'number')).toBe(7);
    expect(listField(body, 'results')).toEqual([1, 2]);
    expect(listField(body, 'title')).toEqual([]);
    expect(field('not an object', 'title')).toBeUndefined();
  });
});

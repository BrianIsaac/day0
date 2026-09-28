import { describe, expect, it } from 'vitest';
import {
  deleteComment,
  LinearClient,
  LinearRequestError,
  MAX_RETRY_WAIT_MS,
  RETRY_PAUSE_MS,
  retryOnce,
  readComments,
} from '../../../scripts/lib/linear';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables?: Record<string, unknown> };
}

function fakeFetch(
  answer: (body: Recorded['body']) => unknown,
  calls: Recorded[] = [],
): { fetch: typeof fetch; calls: Recorded[] } {
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Recorded['body'];
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body });
    return new Response(JSON.stringify(answer(body)), { status: 200 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('the Linear client', (): void => {
  it('posts to the GraphQL endpoint with the key as the authorization header', async (): Promise<void> => {
    const { fetch, calls } = fakeFetch(() => ({ data: { issue: { comments: { nodes: [] } } } }));
    await expect(readComments(new LinearClient('lin_api_test', fetch), 'i7')).resolves.toEqual([]);
    expect(calls[0]!.url).toBe('https://api.linear.app/graphql');
    expect(calls[0]!.headers.Authorization).toBe('lin_api_test');
    expect(calls[0]!.body.query).toContain('comments');
  });

  it('turns a GraphQL error list into a thrown error and never returns partial data', async (): Promise<void> => {
    const { fetch } = fakeFetch(() => ({ errors: [{ message: 'Query too complex' }] }));
    await expect(readComments(new LinearClient('k', fetch), 'i7')).rejects.toThrow(
      'Query too complex',
    );
  });

  it('lists comments and deletes one through the named documents with the ids as variables', async (): Promise<void> => {
    const { fetch, calls } = fakeFetch((body) =>
      body.query.includes('commentDelete')
        ? { data: { commentDelete: { success: true } } }
        : { data: { issue: { comments: { nodes: [{ id: 'c1', body: 'hi', createdAt: 't' }] } } } },
    );
    const client = new LinearClient('k', fetch);
    await expect(readComments(client, 'i7')).resolves.toEqual([
      { id: 'c1', body: 'hi', createdAt: 't' },
    ]);
    await deleteComment(client, 'c9');
    expect(calls.map((call) => call.body.variables)).toEqual([{ id: 'i7' }, { id: 'c9' }]);
  });

  it('refuses a delete the provider answers success: false', async (): Promise<void> => {
    const { fetch } = fakeFetch(() => ({ data: { commentDelete: { success: false } } }));
    await expect(deleteComment(new LinearClient('k', fetch), 'c9')).rejects.toThrow(
      'commentDelete',
    );
  });
});

describe('a failed Linear call, classified', (): void => {
  const NOW = 1_789_700_000_000;
  const timedOut = (): DOMException =>
    new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const json = (value: unknown, init: ResponseInit): Response =>
    new Response(JSON.stringify(value), init);

  async function failure(answer: () => Promise<Response>): Promise<LinearRequestError> {
    const error: unknown = await readComments(
      new LinearClient('k', answer as typeof fetch, () => NOW),
      'i7',
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LinearRequestError);
    return error as LinearRequestError;
  }

  it('calls a timeout, a dropped connection, a 5xx and a rate limit transient, with the wait Linear asked for', async (): Promise<void> => {
    expect(
      await failure(async () => {
        throw timedOut();
      }),
    ).toMatchObject({ transient: true, reason: 'a timeout' });
    // The transport's own words decide, through the product's one classifier (C-29).
    expect(
      await failure(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo EAI_AGAIN api.linear.app'), {
            code: 'EAI_AGAIN',
          }),
        });
      }),
    ).toMatchObject({
      transient: true,
      reason: 'a network failure',
    });
    expect(
      await failure(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        });
      }),
    ).toMatchObject({
      transient: true,
      reason: 'a dropped connection',
    });
    expect(
      await failure(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    ).toMatchObject({
      transient: true,
      reason: 'HTTP 502',
      waitMs: undefined,
    });
    expect(
      await failure(async () => json({}, { status: 429, headers: { 'Retry-After': '7' } })),
    ).toMatchObject({
      transient: true,
      reason: 'HTTP 429',
      waitMs: 7_000,
    });
    // Linear's documented rate limit: HTTP 400, RATELIMITED, and the window's end in epoch milliseconds.
    const limited = {
      errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }],
    };
    expect(
      await failure(async () =>
        json(limited, {
          status: 400,
          headers: { 'X-RateLimit-Requests-Reset': String(NOW + 5_000) },
        }),
      ),
    ).toMatchObject({ transient: true, reason: 'a Linear rate limit', waitMs: 5_000 });
    expect(await failure(async () => json(limited, { status: 400 }))).toMatchObject({
      transient: true,
      reason: 'a Linear rate limit',
      waitMs: undefined,
    });
  });

  it('calls a timeout while the answer is still arriving a timeout too', async (): Promise<void> => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('{"da'));
        controller.error(timedOut());
      },
    });
    expect(await failure(async () => new Response(stalled, { status: 200 }))).toMatchObject({
      transient: true,
      reason: 'a timeout',
    });
  });

  it('never calls a request Linear refused as wrong transient', async (): Promise<void> => {
    const invalid = {
      errors: [{ message: 'Argument Validation Error', extensions: { code: 'INVALID_INPUT' } }],
    };
    const refused = await failure(async () => json(invalid, { status: 400 }));
    expect(refused).toMatchObject({ transient: false });
    expect(refused.message).toBe('Linear: Argument Validation Error');
    expect(await failure(async () => new Response('', { status: 401 }))).toMatchObject({
      transient: false,
      reason: 'HTTP 401',
    });
    expect(
      await failure(async () =>
        json({ errors: [{ message: 'Query too complex' }] }, { status: 200 }),
      ),
    ).toMatchObject({
      transient: false,
    });
  });
});

describe('a failure that is not a transport the classifier knows', (): void => {
  it('leaves a bare fetch failure as it came, since a refused certificate says the same (C-29)', async (): Promise<void> => {
    const certificate = new TypeError('fetch failed', {
      cause: Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    });
    const error: unknown = await readComments(
      new LinearClient('k', (async (): Promise<Response> => {
        throw certificate;
      }) as typeof fetch),
      'i7',
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBe(certificate);
  });
});

describe('one retry', (): void => {
  function recorder(): {
    lines: string[];
    sleeps: number[];
    say: (line: string) => void;
    sleep: (ms: number) => Promise<void>;
  } {
    const lines: string[] = [];
    const sleeps: number[] = [];
    return {
      lines,
      sleeps,
      say: (line: string): void => {
        lines.push(line);
      },
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    };
  }
  const timeout = (): LinearRequestError =>
    new LinearRequestError('Linear did not answer within 30 s.', 'a timeout', true);

  it('names the retry, pauses, and runs the second attempt it is given', async (): Promise<void> => {
    const io = recorder();
    const result = await retryOnce(
      'label delete',
      io,
      async (): Promise<string> => {
        throw timeout();
      },
      async (): Promise<string> => 'gone',
    );
    expect(result).toBe('gone');
    expect(io.lines).toEqual(['retrying label delete after a timeout']);
    expect(io.sleeps).toEqual([RETRY_PAUSE_MS]);
  });

  it('waits as long as Linear asked, and says so', async (): Promise<void> => {
    const io = recorder();
    let calls = 0;
    await retryOnce('label delete', io, async (): Promise<void> => {
      calls += 1;
      if (calls === 1)
        throw new LinearRequestError('Linear answered HTTP 429.', 'HTTP 429', true, 7_000);
    });
    expect(calls).toBe(2);
    expect(io.lines).toEqual(['retrying label delete after HTTP 429, in 7 s as Linear asked']);
    expect(io.sleeps).toEqual([7_000]);
  });

  it('fails with one line naming both failures when the retry fails too', async (): Promise<void> => {
    const io = recorder();
    await expect(
      retryOnce(
        'label delete',
        io,
        async (): Promise<void> => {
          throw timeout();
        },
        async (): Promise<void> => {
          throw new LinearRequestError('Linear answered HTTP 503.', 'HTTP 503', true);
        },
      ),
    ).rejects.toThrow('label delete failed twice: a timeout, then HTTP 503');
  });

  it("never retries a request Linear called wrong, nor an error that is not Linear's", async (): Promise<void> => {
    const io = recorder();
    let again = 0;
    const wrong = new LinearRequestError('Linear: Argument Validation Error', 'HTTP 400', false);
    await expect(
      retryOnce(
        'fin-status create',
        io,
        async (): Promise<void> => {
          throw wrong;
        },
        async (): Promise<void> => {
          again += 1;
        },
      ),
    ).rejects.toBe(wrong);
    await expect(
      retryOnce(
        'fin-status create',
        io,
        async (): Promise<void> => {
          throw new Error('Linear issueCreate did not succeed.');
        },
        async (): Promise<void> => {
          again += 1;
        },
      ),
    ).rejects.toThrow('Linear issueCreate did not succeed.');
    expect(again).toBe(0);
    expect(io.lines).toEqual([]);
    expect(io.sleeps).toEqual([]);
  });

  it('does not turn a caller abort into a transient provider failure', async (): Promise<void> => {
    const io = recorder();
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      throw new DOMException('The caller stopped the operation', 'AbortError');
    }) as typeof globalThis.fetch;
    const client = new LinearClient('k', fetch);

    await expect(
      retryOnce('workspace read', io, () => readComments(client, 'i7')),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
    expect(io.lines).toEqual([]);
    expect(io.sleeps).toEqual([]);
  });

  it('does not wait past its cap, and says how long Linear asked for', async (): Promise<void> => {
    const io = recorder();
    let again = 0;
    await expect(
      retryOnce(
        'label delete',
        io,
        async (): Promise<void> => {
          throw new LinearRequestError('Linear answered HTTP 429.', 'HTTP 429', true, 1_800_000);
        },
        async (): Promise<void> => {
          again += 1;
        },
      ),
    ).rejects.toThrow(
      `label delete failed: Linear asked to wait 1800 s after HTTP 429, longer than the ${MAX_RETRY_WAIT_MS / 1_000} s a retry waits`,
    );
    expect(again).toBe(0);
    expect(io.sleeps).toEqual([]);
  });
});

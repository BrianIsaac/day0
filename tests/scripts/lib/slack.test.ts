import { describe, expect, it } from 'vitest';
import { SlackClient } from '../../../scripts/lib/slack';

function fakeFetch(answer: (url: string, body: string) => unknown) {
  const calls: Array<{ url: string; body: string; auth: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(input), body: String(init?.body ?? ''), auth: headers.Authorization });
    return new Response(JSON.stringify(answer(String(input), String(init?.body ?? ''))), {
      status: 200,
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('the Slack client', (): void => {
  it('verifies the token with auth.test and reports the bot identity', async (): Promise<void> => {
    const { fetch, calls } = fakeFetch(() => ({
      ok: true,
      team: 'day0',
      user_id: 'UBOT',
      bot_id: 'BBOT',
    }));
    const client = new SlackClient('xoxb-test', fetch);
    await expect(client.authTest()).resolves.toEqual({
      team: 'day0',
      userId: 'UBOT',
      botId: 'BBOT',
    });
    expect(calls[0]!.url).toBe('https://slack.com/api/auth.test');
    expect(calls[0]!.auth).toBe('Bearer xoxb-test');
  });

  it('turns ok: false into a thrown error naming the provider reason', async (): Promise<void> => {
    const { fetch } = fakeFetch(() => ({ ok: false, error: 'invalid_auth' }));
    await expect(new SlackClient('x', fetch).authTest()).rejects.toThrow('invalid_auth');
  });

  it('reads a channel history from a timestamp and deletes by channel and ts', async (): Promise<void> => {
    const { fetch, calls } = fakeFetch((url) =>
      url.includes('conversations.history')
        ? { ok: true, messages: [{ ts: '2.0', text: 'later', bot_id: 'BBOT' }] }
        : { ok: true, channel: 'D1', ts: '2.0' },
    );
    const client = new SlackClient('x', fetch);
    await expect(client.history('D1', '1.5')).resolves.toEqual([
      { ts: '2.0', text: 'later', botId: 'BBOT', user: undefined },
    ]);
    expect(calls[0]!.url).toContain('channel=D1');
    expect(calls[0]!.url).toContain('oldest=1.5');
    await client.deleteMessage('D1', '2.0');
    expect(JSON.parse(calls[1]!.body)).toEqual({ channel: 'D1', ts: '2.0' });
  });

  it('waits for Retry-After and retries one HTTP 429', async (): Promise<void> => {
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
            status: 429,
            headers: { 'Retry-After': '7' },
          })
        : new Response(JSON.stringify({ ok: true, team: 'day0', user_id: 'UBOT', bot_id: 'BBOT' }));
    }) as typeof globalThis.fetch;
    const lines: string[] = [];
    const sleeps: number[] = [];
    const client = new SlackClient('x', fetch, {
      say: (line: string): void => {
        lines.push(line);
      },
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    });

    await expect(client.authTest()).resolves.toMatchObject({ team: 'day0' });
    expect(calls).toBe(2);
    expect(lines).toEqual(['retrying Slack auth.test after HTTP 429, in 7 s as Slack asked']);
    expect(sleeps).toEqual([7_000]);
  });

  it('retries once when Slack times out before answering', async (): Promise<void> => {
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1)
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response(
        JSON.stringify({ ok: true, team: 'day0', user_id: 'UBOT', bot_id: 'BBOT' }),
      );
    }) as typeof globalThis.fetch;
    const lines: string[] = [];
    const sleeps: number[] = [];
    const client = new SlackClient('x', fetch, {
      say: (line: string): void => {
        lines.push(line);
      },
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    });

    await expect(client.authTest()).resolves.toMatchObject({ team: 'day0' });
    expect(calls).toBe(2);
    expect(lines).toEqual(['retrying Slack auth.test after a timeout']);
    expect(sleeps).toEqual([2_000]);
  });

  it('retries once when the connection drops mid-answer, as every provider read does (C-29)', async (): Promise<void> => {
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        });
      }
      return new Response(
        JSON.stringify({ ok: true, team: 'day0', user_id: 'UBOT', bot_id: 'BBOT' }),
      );
    }) as typeof globalThis.fetch;
    const lines: string[] = [];
    const client = new SlackClient('x', fetch, {
      say: (line: string): void => {
        lines.push(line);
      },
      sleep: async (): Promise<void> => undefined,
    });

    await expect(client.authTest()).resolves.toMatchObject({ team: 'day0' });
    expect(calls).toBe(2);
    expect(lines).toEqual(['retrying Slack auth.test after a dropped connection']);
  });

  it('never retries a request its caller stopped', async (): Promise<void> => {
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      throw new DOMException('The caller stopped the operation', 'AbortError');
    }) as typeof globalThis.fetch;
    const client = new SlackClient('x', fetch, {
      say: (): void => undefined,
      sleep: async (): Promise<void> => undefined,
    });

    await expect(client.authTest()).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('retries one HTTP 5xx even when the response is not JSON', async (): Promise<void> => {
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      return calls === 1
        ? new Response('<html>service unavailable</html>', { status: 503 })
        : new Response(JSON.stringify({ ok: true, team: 'day0', user_id: 'UBOT', bot_id: 'BBOT' }));
    }) as typeof globalThis.fetch;
    const lines: string[] = [];
    const sleeps: number[] = [];
    const client = new SlackClient('x', fetch, {
      say: (line: string): void => {
        lines.push(line);
      },
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    });

    await expect(client.authTest()).resolves.toMatchObject({ team: 'day0' });
    expect(calls).toBe(2);
    expect(lines).toEqual(['retrying Slack auth.test after HTTP 503']);
    expect(sleeps).toEqual([2_000]);
  });

  it('treats message_not_found after a timed-out delete as the first attempt having landed', async (): Promise<void> => {
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      if (calls === 1)
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return new Response(JSON.stringify({ ok: false, error: 'message_not_found' }));
    }) as typeof globalThis.fetch;
    const lines: string[] = [];
    const client = new SlackClient('x', fetch, {
      say: (line: string): void => {
        lines.push(line);
      },
      sleep: async (): Promise<void> => undefined,
    });

    await expect(client.deleteMessage('D1', '2.0')).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(lines).toEqual([
      'retrying Slack chat.delete after a timeout',
      'the first Slack chat.delete landed before the timeout; not sent again',
    ]);
  });

  it('does not wait beyond the retry cap', async (): Promise<void> => {
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
        status: 429,
        headers: { 'Retry-After': '1800' },
      });
    }) as typeof globalThis.fetch;
    const lines: string[] = [];
    const sleeps: number[] = [];
    const client = new SlackClient('x', fetch, {
      say: (line: string): void => {
        lines.push(line);
      },
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    });

    await expect(client.authTest()).rejects.toThrow(
      'Slack auth.test failed: Slack asked to wait 1800 s after HTTP 429, longer than the 60 s a retry waits',
    );
    expect(calls).toBe(1);
    expect(lines).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  it('does not retry cant_delete_message or another provider refusal', async (): Promise<void> => {
    const codes = ['cant_delete_message', 'invalid_auth'];
    for (const code of codes) {
      let calls = 0;
      const fetch = (async (): Promise<Response> => {
        calls += 1;
        return new Response(JSON.stringify({ ok: false, error: code }));
      }) as typeof globalThis.fetch;
      const lines: string[] = [];
      const sleeps: number[] = [];
      const client = new SlackClient('x', fetch, {
        say: (line: string): void => {
          lines.push(line);
        },
        sleep: async (ms: number): Promise<void> => {
          sleeps.push(ms);
        },
      });

      await expect(
        code === 'cant_delete_message' ? client.deleteMessage('D1', '2.0') : client.authTest(),
      ).rejects.toThrow(
        `Slack ${code === 'cant_delete_message' ? 'chat.delete' : 'auth.test'}: ${code}`,
      );
      expect(calls, code).toBe(1);
      expect(lines, code).toEqual([]);
      expect(sleeps, code).toEqual([]);
    }
  });
});

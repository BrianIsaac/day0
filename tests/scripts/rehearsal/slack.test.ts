import { describe, expect, it } from 'vitest';
import { botMessagesSince, SlackClient } from '../../../scripts/rehearsal/slack';

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
    await expect(client.authTest()).resolves.toEqual({ team: 'day0', userId: 'UBOT', botId: 'BBOT' });
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
});

describe('which messages are the run’s to delete', (): void => {
  it('does not delete a concurrent message from the same shared bot', () => {
    expect(botMessagesSince([
      { ts: '3.0', text: 'Other run\n\n-- another worker (Day0) · run another-item/run-2', botId: 'BBOT' },
      { ts: '3.1', text: 'Our run\n\n-- rehearsal worker (Day0) · run our-item/run-1', botId: 'BBOT' },
    ], 'BBOT', '2.0', ['our-item']).map(message => message.ts)).toEqual(['3.1']);
  });

  it("keeps only the bot's own messages at or after the run start", (): void => {
    const messages = [
      { ts: '3.0', text: 'bot after\n-- worker (Day0) · run ours/r1', botId: 'BBOT' },
      { ts: '2.5', text: 'human after', user: 'UHUMAN' },
      { ts: '1.0', text: 'bot before', botId: 'BBOT' },
      { ts: '2.0', text: 'bot at start\n-- worker (Day0) · run ours/r1', botId: 'BBOT' },
    ];
    expect(botMessagesSince(messages, 'BBOT', '2.0', ['ours']).map((m) => m.ts)).toEqual(['3.0', '2.0']);
  });
});

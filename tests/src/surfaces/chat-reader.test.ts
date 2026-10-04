import { describe, expect, it } from 'vitest';
import { TransientProviderError } from '../../../src/lib/transport-error';
import {
  chatReaderFor,
  MAX_CHANNEL_PAGES,
  slackChatReader,
  type ChatFetch,
  ChatReadRefused,
} from '../../../src/surfaces/chat-reader';
import { parseSurfaceAction, toolRefusal } from '../../../src/surfaces/policy';
import { httpSecretPlacementRefusal } from '../../../src/surfaces/secrets';
import type { SurfaceRecord } from '../../../src/surfaces/types';

const SLACK_METHODS = [
  'auth.test',
  'conversations.list',
  'conversations.history',
  'conversations.replies',
  'chat.postMessage',
];

const slack: SurfaceRecord = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  verdict: 'connected',
  credentialLanded: true,
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  toolAllowlist: SLACK_METHODS,
  credentialId: 'cred-slack',
  credentialKind: 'oauth',
};

const TOKEN = ['xoxb', 'reader', 'test'].join('-');

/** A Slack Web API double answering each method from `answers`, recording every request. */
function slackDouble(answers: Record<string, (url: URL) => Response>) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetch: ChatFetch = async (url: URL, init: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    const method = url.pathname.split('/').at(-1) ?? '';
    const answer = answers[method];
    if (!answer) throw new Error(`no answer for ${method}`);
    return answer(url);
  };
  return { fetch, requests };
}

const ok = (payload: Record<string, unknown>): Response => Response.json({ ok: true, ...payload });

describe('the Slack chat reader', (): void => {
  it('resolves documented channels across pages, in the order they were named', async (): Promise<void> => {
    const double = slackDouble({
      'conversations.list': (url) =>
        url.searchParams.get('cursor') === null
          ? ok({
              channels: [{ id: 'C2', name: 'revops' }],
              response_metadata: { next_cursor: 'page-2' },
            })
          : ok({ channels: [{ id: 'C1', name: 'Revops-Asks' }] }),
    });
    const reader = slackChatReader(slack, { credential: TOKEN, fetch: double.fetch });
    await expect(reader.listChannels(['revops-asks', 'revops'])).resolves.toEqual([
      { id: 'C1', name: 'revops-asks' },
      { id: 'C2', name: 'revops' },
    ]);
    expect(double.requests[0]!.url.searchParams.get('types')).toBe('public_channel');
  });

  it('refuses a documented channel the app cannot see, and a cursor that repeats', async (): Promise<void> => {
    const missing = slackDouble({ 'conversations.list': () => ok({ channels: [] }) });
    await expect(
      slackChatReader(slack, { credential: TOKEN, fetch: missing.fetch }).listChannels(['ops']),
    ).rejects.toThrow('Slack channels are not visible: #ops.');
    const looping = slackDouble({
      'conversations.list': () => ok({ channels: [], response_metadata: { next_cursor: 'again' } }),
    });
    await expect(
      slackChatReader(slack, { credential: TOKEN, fetch: looping.fetch }).listChannels(['ops']),
    ).rejects.toThrow('repeated a cursor');
    expect(looping.requests.length).toBeLessThan(MAX_CHANNEL_PAGES);
  });

  it('reads a channel from a moment on, across pages, with each author mark', async (): Promise<void> => {
    const double = slackDouble({
      'conversations.history': (url) =>
        url.searchParams.get('cursor') === null
          ? ok({
              messages: [
                { ts: '1.2', text: 'hi <@U1>', user: 'U9', thread_ts: '1.0' },
                { ts: '1.1', text: 'posted as Priya', bot_id: 'B1', app_id: 'A1' },
                { ts: '1.05', subtype: 'channel_join' },
              ],
              response_metadata: { next_cursor: 'older' },
            })
          : ok({ messages: [{ ts: '1.0', text: 'first' }] }),
    });
    const reader = slackChatReader(slack, { credential: TOKEN, fetch: double.fetch });
    await expect(reader.readSince('C1', 1_700_000_000_000)).resolves.toEqual([
      { ts: '1.2', text: 'hi <@U1>', user: 'U9', threadTs: '1.0' },
      { ts: '1.1', text: 'posted as Priya', botId: 'B1', appId: 'A1' },
      { ts: '1.0', text: 'first' },
    ]);
    const query = double.requests[0]!.url.searchParams;
    expect(query.get('channel')).toBe('C1');
    expect(query.get('oldest')).toBe('1700000000');
    expect(query.get('inclusive')).toBe('true');
  });

  it('reads the replies under one message', async (): Promise<void> => {
    const double = slackDouble({
      'conversations.replies': () => ok({ messages: [{ ts: '2.1', text: 'approve', user: 'U2' }] }),
    });
    const reader = slackChatReader(slack, { credential: TOKEN, fetch: double.fetch });
    await expect(reader.readThread('D1', '2.0')).resolves.toEqual([
      { ts: '2.1', text: 'approve', user: 'U2' },
    ]);
    expect(double.requests[0]!.url.searchParams.get('ts')).toBe('2.0');
    expect(double.requests[0]!.url.searchParams.has('oldest')).toBe(false);
  });

  it('answers a rate limit or a server error as a transient, and a refusal as a failure', async (): Promise<void> => {
    for (const answer of [
      new Response('{"ok":false,"error":"ratelimited"}', { status: 429 }),
      Response.json({ ok: false, error: 'ratelimited' }),
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    ]) {
      const double = slackDouble({ 'conversations.history': () => answer.clone() });
      await expect(
        slackChatReader(slack, { credential: TOKEN, fetch: double.fetch }).readSince('C1'),
      ).rejects.toBeInstanceOf(TransientProviderError);
    }
    const refused = slackDouble({
      'conversations.history': () => Response.json({ ok: false, error: 'not_in_channel' }),
    });
    const failure = slackChatReader(slack, { credential: TOKEN, fetch: refused.fetch }).readSince(
      'C1',
    );
    await expect(failure).rejects.toThrow('Slack conversations.history failed: not_in_channel');
    await expect(failure).rejects.not.toBeInstanceOf(TransientProviderError);
    // The provider's code travels on the refusal, so a caller matches it without reading prose.
    await expect(failure).rejects.toBeInstanceOf(ChatReadRefused);
    await expect(failure).rejects.toMatchObject({ code: 'not_in_channel' });
  });

  it('calls no method the probe did not allow, and sends the key only as a bearer', async (): Promise<void> => {
    const double = slackDouble({
      'auth.test': () => ok({ user_id: 'U1', bot_id: 'B1', team_id: 'T1' }),
    });
    const narrow = slackChatReader(
      { ...slack, toolAllowlist: ['auth.test'] },
      { credential: TOKEN, fetch: double.fetch },
    );
    await expect(narrow.readThread('D1', '2.0')).rejects.toThrow(
      'Connected Slack surface does not allow conversations.replies.',
    );
    expect(double.requests).toEqual([]);
    await expect(narrow.identity()).resolves.toEqual({
      userId: 'U1',
      botId: 'B1',
      workspaceId: 'T1',
    });
    const [request] = double.requests;
    expect(new Headers(request!.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(request!.url.href).not.toContain(TOKEN);
    expect(request!.init.redirect).toBe('error');
  });

  it('reads the local proof service when the deployment points Slack there', async (): Promise<void> => {
    const double = slackDouble({ 'auth.test': () => ok({ user_id: 'U1' }) });
    await slackChatReader(slack, {
      credential: TOKEN,
      fetch: double.fetch,
      slackApiBase: new URL('http://fake-slack/api/'),
    }).identity();
    expect(double.requests[0]!.url.href).toBe('http://fake-slack/api/auth.test');
  });

  it('never posts itself: it names the action the gate applies, credential in the header', (): void => {
    const reader = slackChatReader(slack, { credential: TOKEN, fetch: slackDouble({}).fetch });
    const action = reader.postAction({ channel: 'C1', text: 'Done.', threadTs: '1.2' });
    expect(JSON.stringify(action)).not.toContain(TOKEN);
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || parsed.action.kind !== 'http.request') throw new Error('not a request');
    expect(parsed.action.bodyJson).toEqual({ channel: 'C1', text: 'Done.', thread_ts: '1.2' });
    expect(toolRefusal(parsed.action, slack)).toBeUndefined();
    expect(httpSecretPlacementRefusal(parsed.action)).toBeUndefined();
  });
});

describe("the Slack reader's name for a member (the second pre-tag's recorded item)", (): void => {
  const named = { ...slack, toolAllowlist: [...SLACK_METHODS, 'users.info'] };

  it('gives the name Slack shows: the display name, else the full name, else the handle', async (): Promise<void> => {
    const double = slackDouble({
      'users.info': (url) =>
        url.searchParams.get('user') === 'UPRIYA'
          ? ok({
              user: { name: 'priya', real_name: 'Priya Shah', profile: { display_name: 'Priya' } },
            })
          : ok({ user: { name: 'sam', real_name: 'Sam Lee', profile: { display_name: ' ' } } }),
    });
    const reader = slackChatReader(named, { credential: TOKEN, fetch: double.fetch });
    expect(await reader.memberName('UPRIYA')).toBe('Priya');
    expect(await reader.memberName('USAM')).toBe('Sam Lee');
  });

  it("asks nothing where the card's policy names no users.info, and gives no name for Slack's refusal", async (): Promise<void> => {
    const double = slackDouble({
      'users.info': () => Response.json({ ok: false, error: 'user_not_found' }),
    });
    expect(
      await slackChatReader(slack, { credential: TOKEN, fetch: double.fetch }).memberName('UGONE'),
    ).toBeUndefined();
    expect(double.requests).toHaveLength(0);
    expect(
      await slackChatReader(named, { credential: TOKEN, fetch: double.fetch }).memberName('UGONE'),
    ).toBeUndefined();
  });

  it("passes on a refusal that is a misconfiguration, for intake to note, and keeps a name to one short line (the second pass's code reader)", async (): Promise<void> => {
    const refusing = slackDouble({
      'users.info': () => Response.json({ ok: false, error: 'missing_scope' }),
    });
    await expect(
      slackChatReader(named, { credential: TOKEN, fetch: refusing.fetch }).memberName('UPRIYA'),
    ).rejects.toBeInstanceOf(ChatReadRefused);
    const long = slackDouble({
      'users.info': () =>
        ok({ user: { profile: { display_name: `Priya\n  ${'Shah '.repeat(40)}` } } }),
    });
    const name = await slackChatReader(named, { credential: TOKEN, fetch: long.fetch }).memberName(
      'UPRIYA',
    );
    expect(name?.length).toBeLessThanOrEqual(80);
    expect(name).not.toMatch(/\s{2,}|\n/);
    expect(name?.startsWith('Priya Shah Shah')).toBe(true);
  });

  it('answers a rate limit as a transient for the caller to note', async (): Promise<void> => {
    const double = slackDouble({
      'users.info': () => Response.json({ ok: false, error: 'ratelimited' }, { status: 429 }),
    });
    await expect(
      slackChatReader(named, { credential: TOKEN, fetch: double.fetch }).memberName('UPRIYA'),
    ).rejects.toBeInstanceOf(TransientProviderError);
  });
});

describe('choosing a chat reader by rung', (): void => {
  const fetch = slackDouble({}).fetch;

  it('reads Slack over its documented Web API', (): void => {
    expect(chatReaderFor(slack, { credential: TOKEN, fetch })).toMatchObject({ ok: true });
  });

  it('says why another rung or another chat system has no reader yet', (): void => {
    const teams = {
      ...slack,
      slug: 'teams',
      displayName: 'Microsoft Teams',
      endpoint: 'https://graph.microsoft.com/v1.0/',
    };
    expect(chatReaderFor(teams, { credential: TOKEN, fetch })).toEqual({
      ok: false,
      reason:
        "Day0 reads chat over a documented API only through Slack's Web API, so it has no reader for Microsoft Teams at https://graph.microsoft.com/v1.0/.",
    });
    for (const path of ['mcp', 'browser-driven'] as const) {
      const result = chatReaderFor({ ...slack, path }, { credential: TOKEN, fetch });
      expect(result).toMatchObject({ ok: false });
      expect(result.ok ? '' : result.reason).toContain(`no chat reader on the ${path} rung yet`);
    }
    expect(
      chatReaderFor({ ...slack, path: undefined }, { credential: TOKEN, fetch }),
    ).toMatchObject({ ok: false });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSlack, type FakeSlack } from './spawn';

let BASE = '';
let fake: FakeSlack;

async function api(
  method: string,
  token: string,
  body = '',
): Promise<Record<string, unknown>> {
  return (await (
    await fetch(`${BASE}/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    })
  ).json()) as Record<string, unknown>;
}

beforeAll(async (): Promise<void> => {
  fake = await startFakeSlack();
  BASE = fake.base;
}, 20_000);

afterAll((): void => {
  fake?.stop();
});

describe('the isolated Slack provisioning proof', (): void => {
  it('creates an app, redirects one install and exchanges its code', async (): Promise<void> => {
    const created = await api(
      'apps.manifest.create',
      'xoxe-day0-fake-configuration-token',
      new URLSearchParams({ manifest: '{"display_information":{"name":"Day0"}}' }).toString(),
    );
    expect(created).toMatchObject({ ok: true, app_id: 'A_DAY0_FAKE' });

    const authorise = new URL(`${BASE}/oauth/v2/authorize`);
    authorise.searchParams.set('redirect_uri', 'http://127.0.0.1:3000/api/oauth/slack');
    authorise.searchParams.set('state', 'signed-state');
    const redirected = await fetch(authorise, { redirect: 'manual' });
    expect(redirected.headers.get('location')).toBe(
      'http://127.0.0.1:3000/api/oauth/slack?code=day0-fake-authorisation-code&state=signed-state',
    );

    const credentials = created.credentials as Record<string, string>;
    const exchanged = await api(
      'oauth.v2.access',
      '',
      new URLSearchParams({
        client_secret: credentials.client_secret,
        code: 'day0-fake-authorisation-code',
      }).toString(),
    );
    expect(exchanged).toMatchObject({ ok: true, bot_user_id: 'U_DAY0_BOT' });
  });

  it('probes a dedicated identity and reports documented channels as not joined', async (): Promise<void> => {
    const token = 'xoxb-day0-fake-dedicated-token';
    expect(await api('auth.test', token)).toMatchObject({ ok: true, user_id: 'U_DAY0_BOT' });
    expect(await api('users.lookupByEmail', token, 'email=operator%40example.test')).toMatchObject({
      user: { id: 'U_DAY0_MANAGER' },
    });
    expect(await api('conversations.open', token)).toMatchObject({
      channel: { id: 'D_DAY0_MANAGER' },
    });
    expect(await api('conversations.list', token)).toMatchObject({
      channels: [
        { name: 'revops', is_member: false },
        { name: 'revops-asks', is_member: false },
      ],
    });
  });

  it('accepts a private manager note without retaining its body', async (): Promise<void> => {
    const posted = await api(
      'chat.postMessage',
      'xoxb-day0-fake-dedicated-token',
      JSON.stringify({ channel: 'D_DAY0_MANAGER', text: 'isolated proof note' }),
    );
    expect(posted).toMatchObject({
      ok: true,
      channel: 'D_DAY0_MANAGER',
      message: { ts: expect.any(String) },
    });
    const proof = await (await fetch(`${BASE}/proof`)).text();
    expect(proof).toContain('chat.postMessage');
    expect(proof).not.toContain('isolated proof note');
  });

  it('exposes counts for proof without exposing any credential', async (): Promise<void> => {
    const response = await fetch(`${BASE}/proof`);
    const payload = (await response.json()) as {
      calls: Record<string, number>;
      requestLog: Array<{ sequence: number; method: string; at: number }>;
    };
    expect(payload.calls).toMatchObject({
      'apps.manifest.create': 1,
      'oauth.v2.access': 1,
      'chat.postMessage': 1,
    });
    expect(payload.requestLog).toContainEqual({
      sequence: expect.any(Number),
      method: 'chat.postMessage',
      at: expect.any(Number),
    });
    const proof = JSON.stringify(payload);
    expect(proof).not.toContain('xoxe-');
    expect(proof).not.toContain('xoxb-');
    expect(proof).not.toContain('client-secret');
    expect(proof).not.toContain('isolated proof note');
  });

  it('resets only count and timing evidence', async (): Promise<void> => {
    expect((await fetch(`${BASE}/reset`, { method: 'POST' })).ok).toBe(true);
    await api('auth.test', 'xoxb-day0-fake-dedicated-token');
    const proof = (await (await fetch(`${BASE}/proof`)).json()) as {
      calls: Record<string, number>;
      requestLog: Array<{ sequence: number; method: string }>;
    };
    expect(proof.calls).toEqual({ 'auth.test': 1 });
    expect(proof.requestLog).toEqual([
      { sequence: 1, method: 'auth.test', at: expect.any(Number) },
    ]);
  });

  describe('reads its parameters where Slack reads them', (): void => {
    const token = ['xoxb', 'day0', 'fake', 'dedicated', 'token'].join('-');
    const call = async (
      verb: 'GET' | 'POST',
      path: string,
      contentType?: string,
      body?: string,
    ): Promise<Record<string, unknown>> =>
      (await (
        await fetch(`${BASE}/api/${path}`, {
          method: verb,
          headers: { authorization: `Bearer ${token}`, ...(contentType ? { 'content-type': contentType } : {}) },
          body,
        })
      ).json()) as Record<string, unknown>;
    const FORM = 'application/x-www-form-urlencoded';
    const JSON_TYPE = 'application/json; charset=utf-8';

    it('answers a thread read whose channel and ts are in the query, under GET and POST', async (): Promise<void> => {
      for (const verb of ['GET', 'POST'] as const) {
        expect(await call(verb, 'conversations.replies?channel=C_REVOPS_ASKS&ts=1787817600.000001')).toMatchObject({
          ok: true,
          messages: [{ ts: '1787817600.000001', thread_ts: '1787817600.000001' }],
          has_more: false,
        });
      }
    });

    it('answers a history read whose channel is in a form body', async (): Promise<void> => {
      expect(await call('POST', 'conversations.history', FORM, 'channel=C_REVOPS&limit=5')).toMatchObject({
        ok: true,
        messages: [],
        has_more: false,
      });
    });

    it('does not read a JSON body on a read method: the channel was never named', async (): Promise<void> => {
      const body = JSON.stringify({ channel: 'C_REVOPS_ASKS', ts: '1787817600.000001' });
      expect(await call('POST', 'conversations.replies', JSON_TYPE, body)).toEqual({ ok: false, error: 'channel_not_found' });
      expect(await call('POST', 'conversations.history', JSON_TYPE, body)).toEqual({ ok: false, error: 'channel_not_found' });
      expect(await call('POST', 'users.lookupByEmail', JSON_TYPE, '{"email":"operator@example.test"}')).toEqual({
        ok: false,
        error: 'users_not_found',
      });
    });

    it('refuses a channel it does not have, and a thread read with no ts', async (): Promise<void> => {
      expect(await call('GET', 'conversations.replies?channel=C_ELSEWHERE&ts=1787817600.000001')).toEqual({
        ok: false,
        error: 'channel_not_found',
      });
      expect(await call('GET', 'conversations.replies?channel=C_REVOPS&thread_ts=1787817600.000001')).toEqual({
        ok: false,
        error: 'invalid_arguments',
      });
    });

    it('still reads a JSON body on the write methods that take one', async (): Promise<void> => {
      expect(
        await call('POST', 'chat.postMessage', JSON_TYPE, JSON.stringify({ channel: 'C_REVOPS', text: 'a note' })),
      ).toMatchObject({ ok: true, channel: 'C_REVOPS' });
    });
  });
});

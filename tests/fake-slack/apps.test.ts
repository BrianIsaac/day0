import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_BOT_TOKEN, startFakeSlack, type FakeSlack } from './spawn';

/*
 * Fake Slack's employees' own apps (wave 11, 11-AS): the configuration token and its rotation
 * (S2), one app per employee with its own bot, a bot token's revoke taking the bot out of its
 * channels (S1), the re-join of a public channel (RM4), and an app's deletion or uninstall (S4).
 * Each case starts its own fake, so no case reads another's state.
 */

/** The configuration pair the fake starts with, as IT would hand it to the setup verb. */
const CONFIGURATION_TOKEN = ['xoxe', 'day0', 'fake', 'configuration', 'token'].join('-');
const CONFIGURATION_REFRESH = ['xoxe', 'day0', 'fake', 'configuration', 'refresh'].join('-');

let fake: FakeSlack;

beforeEach(async (): Promise<void> => {
  fake = await startFakeSlack();
}, 20_000);

afterEach((): void => {
  fake?.stop();
});

async function api(
  method: string,
  token: string,
  form: Readonly<Record<string, string>> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${fake.base}/api/${method}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
  return (await response.json()) as Record<string, unknown>;
}

interface CreatedApp {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

async function createApp(configurationToken: string = CONFIGURATION_TOKEN): Promise<CreatedApp> {
  const created = await api('apps.manifest.create', configurationToken, {
    manifest: '{"display_information":{"name":"Day0"}}',
  });
  expect(created.ok).toBe(true);
  const credentials = created.credentials as Record<string, string>;
  return {
    appId: String(created.app_id),
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
  };
}

/** Run one app's install the way the administrator's click does, and exchange its code. */
async function install(app: CreatedApp): Promise<{ token: string; botUserId: string }> {
  const authorise = new URL(`${fake.base}/oauth/v2/authorize`);
  authorise.searchParams.set('client_id', app.clientId);
  authorise.searchParams.set('redirect_uri', 'https://day0.example.test/api/oauth/slack');
  authorise.searchParams.set('state', 'signed-state');
  const redirected = await fetch(authorise, { redirect: 'manual' });
  const code = new URL(String(redirected.headers.get('location'))).searchParams.get('code');
  const exchanged = await api('oauth.v2.access', '', {
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code: String(code),
  });
  expect(exchanged.ok).toBe(true);
  return { token: String(exchanged.access_token), botUserId: String(exchanged.bot_user_id) };
}

async function membership(token: string): Promise<Record<string, boolean>> {
  const listed = await api('conversations.list', token, { types: 'public_channel' });
  const channels = listed.channels as Array<{ name: string; is_member: boolean }>;
  return Object.fromEntries(channels.map((channel) => [channel.name, channel.is_member]));
}

async function proof(): Promise<Record<string, unknown>> {
  return (await (await fetch(`${fake.base}/proof`)).json()) as Record<string, unknown>;
}

describe("fake Slack's configuration token (S2)", (): void => {
  it('rotates the pair: the new token works, the old one and the used refresh token do not', async (): Promise<void> => {
    const rotated = await api('tooling.tokens.rotate', '', {
      refresh_token: CONFIGURATION_REFRESH,
    });
    expect(rotated).toMatchObject({ ok: true });
    const token = String(rotated.token);
    const refresh = String(rotated.refresh_token);
    expect(token).not.toBe(CONFIGURATION_TOKEN);
    expect(refresh).not.toBe(CONFIGURATION_REFRESH);
    expect(Number(rotated.exp) - Number(rotated.iat)).toBe(12 * 60 * 60);

    expect(await api('apps.manifest.create', CONFIGURATION_TOKEN, { manifest: '{}' })).toEqual({
      ok: false,
      error: 'invalid_auth',
    });
    expect((await createApp(token)).appId).toBe('A_DAY0_FAKE');
    expect(
      await api('tooling.tokens.rotate', '', { refresh_token: CONFIGURATION_REFRESH }),
    ).toEqual({ ok: false, error: 'invalid_refresh_token' });
    expect(await api('tooling.tokens.rotate', '', { refresh_token: refresh })).toMatchObject({
      ok: true,
    });
    expect(await proof()).toMatchObject({ configurationRotations: 2 });
  });
});

describe("fake Slack's employees' own apps", (): void => {
  it('creates one app per call, each with its own client and, once installed, its own bot', async (): Promise<void> => {
    const first = await createApp();
    const second = await createApp();
    expect(first.appId).toBe('A_DAY0_FAKE');
    expect(second.appId).not.toBe(first.appId);
    expect(second.clientId).not.toBe(first.clientId);

    expect(
      await api('auth.test', ['xoxb', 'day0', 'fake', 'dedicated', 'token', '2'].join('-')),
    ).toEqual({
      ok: false,
      error: 'invalid_auth',
    });
    const installed = await install(second);
    expect(installed.token).not.toBe(FAKE_BOT_TOKEN);
    expect(await api('auth.test', installed.token)).toMatchObject({
      ok: true,
      user_id: installed.botUserId,
    });
    expect(installed.botUserId).not.toBe('U_DAY0_BOT');
    expect((await proof()).apps).toEqual([first.appId, second.appId]);
  });

  it("refuses one app's code exchanged with another app's secret", async (): Promise<void> => {
    await createApp();
    const second = await createApp();
    const authorise = new URL(`${fake.base}/oauth/v2/authorize`);
    authorise.searchParams.set('client_id', second.clientId);
    authorise.searchParams.set('redirect_uri', 'https://day0.example.test/api/oauth/slack');
    authorise.searchParams.set('state', 'signed-state');
    const code = new URL(
      String((await fetch(authorise, { redirect: 'manual' })).headers.get('location')),
    ).searchParams.get('code');
    expect(
      await api('oauth.v2.access', '', {
        client_id: second.clientId,
        client_secret: 'day0-fake-client-secret',
        code: String(code),
      }),
    ).toEqual({ ok: false, error: 'invalid_code' });
  });
});

describe("a bot token's revoke and the re-join (S1, RM4)", (): void => {
  it('joins a public channel, and a revoked bot leaves every channel while its app stays', async (): Promise<void> => {
    await createApp();
    const app = await createApp();
    const bot = await install(app);
    expect(await api('conversations.join', bot.token, { channel: 'C_REVOPS' })).toMatchObject({
      ok: true,
      channel: { id: 'C_REVOPS', name: 'revops' },
    });
    expect(await membership(bot.token)).toEqual({ revops: true, 'revops-asks': false });
    expect(await membership(FAKE_BOT_TOKEN)).toEqual({ revops: false, 'revops-asks': false });

    expect(await api('auth.revoke', bot.token)).toEqual({ ok: true, revoked: true });
    expect(await api('auth.test', bot.token)).toEqual({ ok: false, error: 'invalid_auth' });
    expect((await proof()).apps).toContain(app.appId);

    const renewed = await install(app);
    expect(renewed.token).toBe(bot.token);
    expect(await membership(renewed.token)).toEqual({ revops: false, 'revops-asks': false });
    expect(await api('conversations.join', renewed.token, { channel: 'C_REVOPS' })).toMatchObject({
      ok: true,
    });
    expect(await membership(renewed.token)).toEqual({ revops: true, 'revops-asks': false });
  });

  it('refuses to join a channel it does not have', async (): Promise<void> => {
    expect(await api('conversations.join', FAKE_BOT_TOKEN, { channel: 'C_NOWHERE' })).toEqual({
      ok: false,
      error: 'channel_not_found',
    });
  });
});

describe("an app's deletion and uninstall (S4)", (): void => {
  it('deletes only with the current configuration token, ending the app and its bot', async (): Promise<void> => {
    await createApp();
    const app = await createApp();
    const bot = await install(app);
    const rotated = await api('tooling.tokens.rotate', '', {
      refresh_token: CONFIGURATION_REFRESH,
    });
    expect(await api('apps.manifest.delete', CONFIGURATION_TOKEN, { app_id: app.appId })).toEqual({
      ok: false,
      error: 'invalid_auth',
    });
    expect(await api('apps.manifest.delete', String(rotated.token), { app_id: app.appId })).toEqual(
      { ok: true },
    );
    expect(await api('auth.test', bot.token)).toEqual({ ok: false, error: 'invalid_auth' });
    expect((await proof()).apps).toEqual(['A_DAY0_FAKE']);
    expect(await api('auth.test', FAKE_BOT_TOKEN)).toMatchObject({ ok: true });
  });

  it("uninstalls one app by its own bot and client credentials, and no other app's", async (): Promise<void> => {
    const first = await createApp();
    const app = await createApp();
    const bot = await install(app);
    expect(
      await api('apps.uninstall', bot.token, {
        client_id: first.clientId,
        client_secret: first.clientSecret,
      }),
    ).toEqual({ ok: false, error: 'bad_client_secret' });
    expect(
      await api('apps.uninstall', bot.token, {
        client_id: app.clientId,
        client_secret: app.clientSecret,
      }),
    ).toEqual({ ok: true });
    expect(await api('auth.test', bot.token)).toEqual({ ok: false, error: 'invalid_auth' });
    expect(await api('auth.test', FAKE_BOT_TOKEN)).toMatchObject({ ok: true });
  });

  it('names no token or secret in its proof', async (): Promise<void> => {
    const app = await createApp();
    await install(app);
    await api('tooling.tokens.rotate', '', { refresh_token: CONFIGURATION_REFRESH });
    const shown = JSON.stringify(await proof());
    expect(shown).not.toContain('xoxe-');
    expect(shown).not.toContain('xoxb-');
    expect(shown).not.toContain('client-secret');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeSlack, type FakeSlack } from './spawn';

/*
 * Fake Slack's App Home messages tab (W12V-7), as the walk on real Slack found it: a manager can
 * send a message to an app only where its manifest opens the messages tab for writing; otherwise
 * the DM says "Sending messages to this app has been turned off." `apps.manifest.export` and
 * `apps.manifest.update` read and change an app's manifest with the configuration token. Day0's
 * own posts keep their text and the mentions Slack would read in it, so an escaped `<!here>` reads
 * back as text. Each case starts its own fake.
 */

const CONFIGURATION_TOKEN = ['xoxe', 'day0', 'fake', 'configuration', 'token'].join('-');

/** The App Home the walk validated on real Slack beside the kit's manifest. */
const WRITABLE = {
  home_tab_enabled: false,
  messages_tab_enabled: true,
  messages_tab_read_only_enabled: false,
};

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
  body: Readonly<Record<string, string>> | Record<string, unknown>,
  json = false,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${fake.base}/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': json
        ? 'application/json; charset=utf-8'
        : 'application/x-www-form-urlencoded',
    },
    body: json
      ? JSON.stringify(body)
      : new URLSearchParams(body as Record<string, string>).toString(),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function proof(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${fake.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** Create and install an app from a manifest with or without the walk's App Home. */
async function installedApp(appHome?: typeof WRITABLE): Promise<{ appId: string; bot: string }> {
  const created = await api('apps.manifest.create', CONFIGURATION_TOKEN, {
    manifest: JSON.stringify({
      display_information: { name: 'Iris (Day0)' },
      features: {
        bot_user: { display_name: 'Iris (Day0)' },
        ...(appHome ? { app_home: appHome } : {}),
      },
      oauth_config: {
        redirect_urls: ['https://day0.example.test/api/oauth/slack'],
        scopes: { bot: ['chat:write', 'im:history'] },
      },
    }),
  });
  const credentials = created.credentials as { client_id: string; client_secret: string };
  const authorised = await fetch(
    `${fake.base}/oauth/v2/authorize?client_id=${credentials.client_id}&redirect_uri=https://day0.example.test/cb&state=s`,
    { redirect: 'manual' },
  );
  const code = new URL(authorised.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const access = await fetch(`${fake.base}/api/oauth.v2.access`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
    }).toString(),
  });
  const bot = ((await access.json()) as { access_token: string }).access_token;
  return { appId: String(created.app_id), bot };
}

describe('fake Slack: the messages tab', (): void => {
  it('refuses the manager’s message to an app whose manifest leaves the tab off, in Slack’s words', async (): Promise<void> => {
    const { appId } = await installedApp();
    expect(await proof('/proof/manager-message', { appId, text: 'approve uacgcm' })).toEqual({
      ok: false,
      error: 'messages_tab_off',
      shown: 'Sending messages to this app has been turned off.',
    });
  });

  it('delivers the manager’s message to an app whose manifest opens the tab, read by the DM’s history', async (): Promise<void> => {
    const { appId, bot } = await installedApp(WRITABLE);
    const sent = await proof('/proof/manager-message', { appId, text: 'approve uacgcm' });
    expect(sent).toMatchObject({ ok: true, channel: 'D_DAY0_MANAGER' });
    const history = await api('conversations.history', bot, { channel: 'D_DAY0_MANAGER' });
    expect(history.messages).toEqual([
      { type: 'message', user: 'U_DAY0_MANAGER', text: 'approve uacgcm', ts: sent.ts },
    ]);
    const later = await api('conversations.history', bot, {
      channel: 'D_DAY0_MANAGER',
      oldest: String(sent.ts),
    });
    expect(later.messages).toEqual([]);
  });

  it('exports an app’s manifest and opens its tab by an update with the configuration token', async (): Promise<void> => {
    const { appId } = await installedApp();
    const exported = await api('apps.manifest.export', CONFIGURATION_TOKEN, { app_id: appId });
    const manifest = exported.manifest as { features: Record<string, unknown> };
    expect(manifest.features.app_home).toBeUndefined();
    const updated = await api('apps.manifest.update', CONFIGURATION_TOKEN, {
      app_id: appId,
      manifest: JSON.stringify({
        ...manifest,
        features: { ...manifest.features, app_home: WRITABLE },
      }),
    });
    expect(updated).toEqual({ ok: true, app_id: appId, permissions_updated: false });
    expect(await proof('/proof/manager-message', { appId, text: 'approve uacgcm' })).toMatchObject({
      ok: true,
    });
  });

  it('keeps of Day0’s post only its markup: an escaped mention as text, an unescaped one as a mention', async (): Promise<void> => {
    const { bot } = await installedApp(WRITABLE);
    await api(
      'chat.postMessage',
      bot,
      { channel: 'D_DAY0_MANAGER', text: 'Iris wrote “&lt;!here&gt; &amp; &lt;@U0SAM&gt;”.' },
      true,
    );
    await api(
      'chat.postMessage',
      bot,
      { channel: 'D_DAY0_MANAGER', text: 'Raw <!here> <#C0X|x>' },
      true,
    );
    const shown = (await (await fetch(`${fake.base}/proof`)).json()) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(
      shown.messages.map((message) => [message.mentions, message.escapedMarkup, message.text]),
    ).toEqual([
      [[], ['&lt;!here&gt;', '&lt;@U0SAM&gt;'], undefined],
      [['<!here>', '<#C0X|x>'], [], undefined],
    ]);
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../fake-slack/server.js', import.meta.url));
const PORT = 8124;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;

async function ready(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      // The child has not bound the socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the fake Slack service did not start');
}

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
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FAKE_SLACK_PORT: String(PORT) },
    stdio: 'ignore',
  });
  await ready();
}, 20_000);

afterAll((): void => {
  child?.kill('SIGTERM');
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
    expect(await api('users.lookupByEmail', token)).toMatchObject({
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

  it('exposes counts for proof without exposing any credential', async (): Promise<void> => {
    const proof = await (await fetch(`${BASE}/proof`)).text();
    expect(proof).toContain('apps.manifest.create');
    expect(proof).toContain('oauth.v2.access');
    expect(proof).not.toContain('xoxe-');
    expect(proof).not.toContain('xoxb-');
    expect(proof).not.toContain('client-secret');
  });
});

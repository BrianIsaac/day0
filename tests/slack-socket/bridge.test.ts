import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridge, type Bridge } from '../../slack-socket/bridge.js';
import { FAKE_BOT_TOKEN, startFakeSlack, type FakeSlack } from '../fake-slack/spawn';

/*
 * The Socket Mode bridge (wave 12, 12-M; RM7) against the real fake Slack, with a stand-in for
 * the backend's three internal routes: the apps list, a connection's URL (opened with the app's
 * app-level token, which the bridge never sees) and the press. Each case starts its own fake.
 */

const SECRET = 'bridge-secret-for-tests';

interface Backend {
  readonly url: string;
  readonly presses: Array<{ surfaceId: string; payload: Record<string, unknown> }>;
  readonly authorisations: string[];
  apps: Array<{ surfaceId: string; appId: string }>;
  /** How many press calls answer 503 before one is taken. */
  failPresses: number;
  /** How many connection URLs were handed out. */
  opened: number;
  stop(): Promise<void>;
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

async function startBackend(fake: FakeSlack, appLevelToken: string): Promise<Backend> {
  const state = {
    presses: [] as Backend['presses'],
    authorisations: [] as string[],
    apps: [{ surfaceId: 'surface-mateo', appId: 'A_DAY0_FAKE' }],
    failPresses: 0,
    opened: 0,
  };
  const server: Server = createServer((request, response): void => {
    void (async (): Promise<void> => {
      state.authorisations.push(String(request.headers.authorization));
      const body = await bodyOf(request);
      const reply = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (request.headers.authorization !== `Bearer ${SECRET}`) return reply(401, {});
      if (request.url === '/slack-socket/apps') return reply(200, { apps: state.apps });
      if (request.url === '/slack-socket/connection') {
        if (!state.apps.some((app) => app.surfaceId === body.surfaceId)) return reply(404, {});
        const opened = (await (
          await fetch(`${fake.base}/api/apps.connections.open`, {
            method: 'POST',
            headers: { authorization: `Bearer ${appLevelToken}` },
          })
        ).json()) as { url: string };
        state.opened += 1;
        return reply(200, { url: opened.url });
      }
      if (request.url === '/slack-socket/press') {
        if (state.failPresses > 0) {
          state.failPresses -= 1;
          return reply(503, {});
        }
        state.presses.push(body as Backend['presses'][number]);
        return reply(200, { status: 'decided' });
      }
      return reply(404, {});
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    stop: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

let fake: FakeSlack;
let backend: Backend;
let bridge: Bridge | undefined;
const logged: Array<Record<string, unknown>> = [];

beforeEach(async (): Promise<void> => {
  fake = await startFakeSlack();
  const generated = (await (
    await fetch(`${fake.base}/proof/app-level-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'A_DAY0_FAKE' }),
    })
  ).json()) as { token: string };
  backend = await startBackend(fake, generated.token);
  logged.length = 0;
}, 20_000);

afterEach(async (): Promise<void> => {
  bridge?.stop();
  bridge = undefined;
  await backend.stop();
  fake.stop();
});

function start(
  overrides: {
    readonly syncIntervalMs?: number;
    readonly helloTimeoutMs?: number;
    readonly maxConnectionMs?: number;
    readonly WebSocket?: typeof WebSocket;
  } = {},
): Bridge {
  bridge = createBridge({
    backendUrl: backend.url,
    secret: SECRET,
    log: (line): void => void logged.push(line),
    syncIntervalMs: overrides.syncIntervalMs ?? 60_000,
    reconnectFirstMs: 50,
    pressRetryFirstMs: 20,
    ...(overrides.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: overrides.helloTimeoutMs }),
    ...(overrides.maxConnectionMs === undefined
      ? {}
      : { maxConnectionMs: overrides.maxConnectionMs }),
    ...(overrides.WebSocket === undefined ? {} : { WebSocket: overrides.WebSocket }),
  });
  return bridge;
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function proof(): Promise<{
  socketConnections: Record<string, number>;
  presses: Array<{ delivered: boolean; acknowledged?: boolean }>;
}> {
  return (await (await fetch(`${fake.base}/proof`)).json()) as never;
}

/** A request with buttons posted by the first app's bot, and a press of its button in Slack. */
async function postAndPress(button: 'approve' | 'reject'): Promise<Record<string, unknown>> {
  const posted = (await (
    await fetch(`${fake.base}/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${FAKE_BOT_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'D_DAY0_MANAGER',
        text: 'Decide this.',
        blocks: [
          {
            type: 'actions',
            block_id: 'day0-decision-ab3xyz',
            elements: ['approve', 'reject'].map((verb) => ({
              type: 'button',
              action_id: `day0.decision.${verb}`,
              value: 'ab3xyz',
              text: { type: 'plain_text', text: verb },
            })),
          },
        ],
      }),
    })
  ).json()) as { ts: string };
  return (await (
    await fetch(`${fake.base}/proof/press`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'D_DAY0_MANAGER', ts: posted.ts, button }),
    })
  ).json()) as Record<string, unknown>;
}

describe('the Socket Mode bridge (wave 12, 12-M; RM7)', (): void => {
  it('connects each listed app, acknowledges a press and hands it to the backend with the secret', async (): Promise<void> => {
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    expect(await postAndPress('approve')).toMatchObject({ delivered: true, acknowledged: true });
    await until(() => backend.presses.length === 1, 'the press at the backend');
    expect(backend.presses[0]).toMatchObject({
      surfaceId: 'surface-mateo',
      payload: { type: 'block_actions', actions: [{ action_id: 'day0.decision.approve' }] },
    });
    expect(new Set(backend.authorisations)).toEqual(new Set([`Bearer ${SECRET}`]));
    expect(running.status()).toMatchObject({
      synced: true,
      apps: [{ appId: 'A_DAY0_FAKE', connected: true, sockets: 1 }],
    });
  });

  it('opens the next connection before closing the last when Slack asks for a refresh', async (): Promise<void> => {
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    await fetch(`${fake.base}/proof/disconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'A_DAY0_FAKE', reason: 'refresh_requested' }),
    });
    await until(() => backend.opened === 2, 'the second connection URL');
    await until(
      async () => (await proof()).socketConnections.A_DAY0_FAKE === 1,
      'the old connection closed',
    );
    expect(await postAndPress('reject')).toMatchObject({ delivered: true, acknowledged: true });
    await until(() => backend.presses.length === 1, 'the press after the refresh');
  });

  it('reconnects after its connection drops, and a press then reaches the backend', async (): Promise<void> => {
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    // The fake's reset drops every connection, as a restart of Slack's side would.
    await fetch(`${fake.base}/reset`, { method: 'POST' });
    await fetch(`${fake.base}/proof/app-level-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'A_DAY0_FAKE' }),
    });
    await until(() => backend.opened >= 2, 'a new connection URL');
    await until(() => running.status().apps.some((app) => app.connected), 'the new hello');
    expect(await postAndPress('approve')).toMatchObject({ delivered: true, acknowledged: true });
    await until(() => backend.presses.length === 1, 'the press after the reconnect');
  });

  it('offers a press again when the backend could not take it', async (): Promise<void> => {
    backend.failPresses = 2;
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    expect(await postAndPress('approve')).toMatchObject({ delivered: true, acknowledged: true });
    await until(() => backend.presses.length === 1, 'the press on the third offer');
  });

  it('closes the connection of an app no longer listed', async (): Promise<void> => {
    const running = start({ syncIntervalMs: 50 });
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    backend.apps = [];
    await until(() => running.status().apps.length === 0, 'the app dropped');
    await until(
      async () => ((await proof()).socketConnections.A_DAY0_FAKE ?? 0) === 0,
      'the connection closed',
    );
  });

  it('never logs a connection URL, whose ticket opens the app’s socket', async (): Promise<void> => {
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    expect(JSON.stringify(logged)).not.toMatch(/ticket=|ws:\/\//);
  });
});

describe('the Socket Mode bridge under failure (12-M second pass)', (): void => {
  it('closes a connection whose hello names another app, and reports the app not connected', async (): Promise<void> => {
    // A second app in the fake, whose token the backend hands out for the first app's card.
    const configuration = ['xoxe', 'day0', 'fake', 'configuration', 'token'].join('-');
    const manifest = JSON.stringify({
      display_information: { name: 'x' },
      oauth_config: {
        redirect_urls: ['https://day0.example/api/oauth/slack'],
        scopes: { bot: ['chat:write'] },
      },
    });
    for (let index = 0; index < 2; index += 1) {
      await fetch(`${fake.base}/api/apps.manifest.create`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${configuration}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ manifest }).toString(),
      });
    }
    const other = (await (
      await fetch(`${fake.base}/proof/app-level-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: 'A_DAY0_FAKE_2' }),
      })
    ).json()) as { token: string };
    await backend.stop();
    backend = await startBackend(fake, other.token);
    const running = start();
    await running.start();
    await until(
      () => logged.some((line) => line.message === 'the connection is for another app'),
      'the mismatch',
    );
    expect(running.status().apps).toEqual([
      expect.objectContaining({ appId: 'A_DAY0_FAKE', connected: false }),
    ]);
    await until(
      async () => ((await proof()).socketConnections.A_DAY0_FAKE_2 ?? 0) === 0,
      'the wrong connection closed',
    );
  });

  it('gives up a connection that never says hello, and opens another', async (): Promise<void> => {
    const sockets: Array<{ closed: boolean }> = [];
    class SilentSocket extends EventTarget {
      closed = false;
      constructor() {
        super();
        sockets.push(this);
      }
      send(): void {}
      close(): void {
        this.closed = true;
        this.dispatchEvent(new Event('close'));
      }
    }
    const running = start({
      helloTimeoutMs: 50,
      WebSocket: SilentSocket as unknown as typeof WebSocket,
    });
    await running.start();
    await until(() => sockets.length >= 2, 'a second connection');
    expect(sockets[0]!.closed).toBe(true);
    expect(running.status().apps[0]?.connected).toBe(false);
  });

  it('opens nothing for an open still in flight when it is stopped', async (): Promise<void> => {
    const running = start();
    const starting = running.start();
    running.stop();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await proof()).socketConnections.A_DAY0_FAKE ?? 0).toBe(0);
  });

  it('offers a press again for longer than a backend restart takes', async (): Promise<void> => {
    backend.failPresses = 6;
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    expect(await postAndPress('approve')).toMatchObject({ delivered: true, acknowledged: true });
    await until(() => backend.presses.length === 1, 'the press on the seventh offer');
  });

  it('opens the next connection before a long-lived one could have gone half-open', async (): Promise<void> => {
    const running = start({ maxConnectionMs: 200 });
    await running.start();
    await until(() => backend.opened >= 3, 'two refreshes');
    await until(
      async () => (await proof()).socketConnections.A_DAY0_FAKE === 1,
      'one connection kept',
    );
    expect(running.status().apps[0]?.connected).toBe(true);
  });
});

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBridge,
  FAREWELL_TIMEOUT_MS,
  FAREWELL_WAIT_MS,
  REPORT_PAGE,
  reportPages,
  responseUrlOf,
  type Bridge,
} from '../../slack-socket/bridge.js';
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
  apps: Array<{ surfaceId: string; appId: string; appName?: string; tokenRef?: string }>;
  /** Every heartbeat the bridge reported, in order (D-6 (b)). */
  readonly heartbeats: Array<{ apps: Array<Record<string, unknown>> }>;
  /** What the heartbeat route answers: 404 is a backend from before 0.17.0. */
  heartbeatStatus: number;
  /** How long the heartbeat route takes to answer a report naming a live app. */
  liveHeartbeatDelayMs: number;
  /** How many press calls answer 503 before one is taken. */
  failPresses: number;
  /** What a press call answers instead of taking it (a 4xx), when set. */
  refusePresses: number | undefined;
  /** How many connection URLs are refused (502) before one is handed out. */
  failConnections: number;
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
    apps: [
      {
        surfaceId: 'surface-mateo',
        appId: 'A_DAY0_FAKE',
        appName: 'Mateo (Day0)',
        tokenRef: 'credential-1',
      },
    ] as Backend['apps'],
    failPresses: 0,
    refusePresses: undefined as number | undefined,
    failConnections: 0,
    opened: 0,
    heartbeats: [] as Backend['heartbeats'],
    heartbeatStatus: 200,
    liveHeartbeatDelayMs: 0,
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
        if (state.failConnections > 0) {
          state.failConnections -= 1;
          return reply(502, { error: 'slack refused' });
        }
        const opened = (await (
          await fetch(`${fake.base}/api/apps.connections.open`, {
            method: 'POST',
            headers: { authorization: `Bearer ${appLevelToken}` },
          })
        ).json()) as { url: string };
        state.opened += 1;
        return reply(200, { url: opened.url });
      }
      if (request.url === '/slack-socket/heartbeat') {
        if (state.heartbeatStatus !== 200) return reply(state.heartbeatStatus, {});
        const report = body as Backend['heartbeats'][number];
        if (report.apps.some((app) => app.live === true) && state.liveHeartbeatDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.liveHeartbeatDelayMs));
        }
        // Kept in the order the backend finishes them, as its rows would be written.
        state.heartbeats.push(report);
        return reply(200, { written: 1 });
      }
      if (request.url === '/slack-socket/press') {
        if (state.refusePresses !== undefined) return reply(state.refusePresses, {});
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
  await bridge?.stop();
  bridge = undefined;
  await backend.stop();
  fake.stop();
});

function start(
  overrides: {
    readonly syncIntervalMs?: number;
    readonly helloTimeoutMs?: number;
    readonly maxConnectionMs?: number;
    readonly stableAfterMs?: number;
    readonly pressRetryWindowMs?: number;
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
    ...(overrides.stableAfterMs === undefined ? {} : { stableAfterMs: overrides.stableAfterMs }),
    ...(overrides.pressRetryWindowMs === undefined
      ? {}
      : { pressRetryWindowMs: overrides.pressRetryWindowMs }),
  });
  return bridge;
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // What the backend and the bridge saw, so a timeout says why (W14-R37).
  throw new Error(
    `timed out waiting for ${what}: the backend opened ${backend.opened}, the bridge logged ${JSON.stringify(logged.slice(-8))}`,
  );
}

async function proof(): Promise<{
  socketConnections: Record<string, number>;
  presses: Array<{ delivered: boolean; acknowledged?: boolean }>;
  responses: Array<Record<string, unknown>>;
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
      // The app's name rides along, so check:access names the card (W12-R32).
      apps: [{ appId: 'A_DAY0_FAKE', appName: 'Mateo (Day0)', connected: true, sockets: 1 }],
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

  it('dials again with the new token when the card’s app-level token is replaced (W12V-6)', async (): Promise<void> => {
    // The walk's row 4: another app's token landed on the card, and the bridge kept the
    // connection opened with the earlier token until a restart.
    const running = start({ syncIntervalMs: 50 });
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    const before = backend.opened;
    backend.apps = [{ ...backend.apps[0]!, tokenRef: 'credential-2' }];
    await until(() => backend.opened > before, 'a new connection asked for');
    await until(() => running.status().apps.some((app) => app.connected), 'the new hello');
    expect(logged).toContainEqual(
      expect.objectContaining({
        message: 'the app-level token was replaced; dialling again',
        appId: 'A_DAY0_FAKE',
      }),
    );
    expect(logged.some((line) => line.message === 'app no longer carries presses')).toBe(false);
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
    const stopping = running.stop();
    await starting;
    await stopping;
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

  it('forgets its earlier failures once a connection has lived long enough, so a later drop dials again at once (W12-R21)', async (): Promise<void> => {
    backend.failConnections = 3;
    const running = start({ stableAfterMs: 100 });
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    await new Promise((resolve) => setTimeout(resolve, 150));
    logged.length = 0;
    // The fake's reset drops the connection with no disconnect frame, as a network break would.
    await fetch(`${fake.base}/reset`, { method: 'POST' });
    await fetch(`${fake.base}/proof/app-level-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'A_DAY0_FAKE' }),
    });
    await until(
      () => logged.some((line) => line.message === 'dialling again'),
      'the retry after the drop',
    );
    expect(logged.find((line) => line.message === 'dialling again')).toMatchObject({
      appId: 'A_DAY0_FAKE',
      inMs: 50,
    });
  });

  it('keeps backing off a connection that drops before it was stable (W12-R21)', async (): Promise<void> => {
    backend.failConnections = 3;
    const running = start({ stableAfterMs: 60_000 });
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    logged.length = 0;
    await fetch(`${fake.base}/reset`, { method: 'POST' });
    await until(
      () => logged.some((line) => line.message === 'dialling again'),
      'the retry after the drop',
    );
    expect(logged.find((line) => line.message === 'dialling again')).toMatchObject({
      inMs: 400,
    });
  });

  it('tells the person who pressed when the backend refused a press it acknowledged (W12-R22)', async (): Promise<void> => {
    backend.refusePresses = 404;
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    expect(await postAndPress('approve')).toMatchObject({ delivered: true, acknowledged: true });
    await until(async () => (await proof()).responses.length === 1, 'the notice');
    expect((await proof()).responses[0]).toEqual({
      channel: 'D_DAY0_MANAGER',
      ts: expect.any(String),
      response_type: 'ephemeral',
      replace_original: false,
      // Re-worded for the design pass: a press the backend refused gets the same answer again, so
      // the presser is not told to press again.
      text: 'Day0 could not take this press, so nothing was decided. Decide in day0.',
    });
    expect(logged).toContainEqual(
      expect.objectContaining({ message: 'press given up', appId: 'A_DAY0_FAKE', told: true }),
    );
  });

  it('tells the person who pressed when the backend could not take a press in time (W12-R22)', async (): Promise<void> => {
    backend.failPresses = 1_000;
    const running = start({ pressRetryWindowMs: 200 });
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    expect(await postAndPress('reject')).toMatchObject({ delivered: true, acknowledged: true });
    await until(async () => (await proof()).responses.length === 1, 'the notice');
    expect(backend.presses).toEqual([]);
    expect((await proof()).responses[0]?.text).toBe(
      'Day0 did not receive this press, so nothing was decided. Press it again in a minute, or decide in day0.',
    );
  });

  it('offers a press again when the backend answers 429 or 408, which a later offer may get past (13-FS second pass)', async (): Promise<void> => {
    backend.refusePresses = 429;
    const running = start({ pressRetryWindowMs: 200 });
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    expect(await postAndPress('approve')).toMatchObject({ delivered: true, acknowledged: true });
    await until(async () => (await proof()).responses.length === 1, 'the notice');
    expect((await proof()).responses[0]?.text).toBe(
      'Day0 did not receive this press, so nothing was decided. Press it again in a minute, or decide in day0.',
    );
    expect(
      logged.filter((line) => line.message === 'press not handed over').length,
    ).toBeGreaterThan(0);
  });

  it('keeps refreshing when the connection a refresh replaced is slow to close (found by the pre-tag gate)', async (): Promise<void> => {
    // A replaced connection still closing when the next refresh is due: the bridge holds two, and
    // the refresh it skipped then was never scheduled again, so it stopped refreshing for good.
    class SlowToClose extends WebSocket {
      override close(code?: number, reason?: string): void {
        setTimeout(() => super.close(code, reason), 400);
      }
    }
    const running = start({
      maxConnectionMs: 100,
      WebSocket: SlowToClose as unknown as typeof WebSocket,
    });
    await running.start();
    await until(() => backend.opened >= 4, 'three refreshes');
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

describe('the Socket Mode bridge’s heartbeat (wave 13, 13-FS; D-6 (b))', (): void => {
  /** The newest report's entry for the listed app. */
  function lastReport(): Record<string, unknown> | undefined {
    return backend.heartbeats.at(-1)?.apps.find((app) => app.surfaceId === 'surface-mateo');
  }

  it('reports each app it holds after its sync, and the app live as soon as its connection is greeted', async (): Promise<void> => {
    const running = start();
    await running.start();
    await until(() => backend.heartbeats.length >= 1, 'the first report');
    await until(() => lastReport()?.live === true, 'the app reported live');
    expect(lastReport()).toMatchObject({
      surfaceId: 'surface-mateo',
      appId: 'A_DAY0_FAKE',
      live: true,
      liveSince: expect.any(Number),
    });
    expect(new Set(backend.authorisations)).toEqual(new Set([`Bearer ${SECRET}`]));
  });

  it('reports again at every sync, so the backend can tell a bridge that runs from one that stopped', async (): Promise<void> => {
    const running = start({ syncIntervalMs: 50 });
    await running.start();
    await until(() => lastReport()?.live === true, 'the app reported live');
    const reports = backend.heartbeats.length;
    await until(() => backend.heartbeats.length >= reports + 2, 'two more syncs reported');
  });

  it('reports the app not live, with why, when its connection could not be opened', async (): Promise<void> => {
    backend.apps = [{ surfaceId: 'surface-mateo', appId: 'A_DAY0_FAKE' }];
    const running = start({
      syncIntervalMs: 50,
      WebSocket: class {
        constructor() {
          throw new Error('refused by the test');
        }
      } as unknown as typeof WebSocket,
    });
    await running.start();
    await until(() => typeof lastReport()?.failure === 'string', 'the failure reported');
    expect(lastReport()).toMatchObject({
      live: false,
      failure: 'the connection URL was refused: refused by the test',
    });
  });

  it('reports every app not live as it stops, so the card does not wait for the report to age', async (): Promise<void> => {
    const running = start();
    await running.start();
    await until(() => lastReport()?.live === true, 'the app reported live');
    await running.stop();
    bridge = undefined;
    expect(lastReport()).toMatchObject({ surfaceId: 'surface-mateo', live: false });
  });

  it('sends its farewell only after a report already on the wire, so the last row written is down (13-FS second pass)', async (): Promise<void> => {
    backend.liveHeartbeatDelayMs = 300;
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    // The greeting's live report is now on the wire, slower to answer than the farewell.
    await running.stop();
    bridge = undefined;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lastReport()).toMatchObject({ surfaceId: 'surface-mateo', live: false });
  });

  it('reports an app it drops as down once, so its row does not read live until it ages (W13-R11)', async (): Promise<void> => {
    const running = start({ syncIntervalMs: 50 });
    await running.start();
    await until(() => lastReport()?.live === true, 'the app reported live');
    backend.apps = [];
    await until(() => running.status().apps.length === 0, 'the app dropped');
    await until(() => lastReport()?.live === false, 'the app reported down');
    expect(lastReport()).toEqual({ surfaceId: 'surface-mateo', appId: 'A_DAY0_FAKE', live: false });
    // Said once: a bridge holding nothing reports nothing more.
    const reports = backend.heartbeats.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(backend.heartbeats.length).toBe(reports);
  });

  it('reports a dropped app down at the next report the backend takes, when the first is lost (the second pass)', async (): Promise<void> => {
    const running = start({ syncIntervalMs: 50 });
    await running.start();
    await until(() => lastReport()?.live === true, 'the app reported live');
    backend.heartbeatStatus = 503;
    backend.apps = [];
    await until(() => running.status().apps.length === 0, 'the app dropped');
    await new Promise((resolve) => setTimeout(resolve, 150));
    backend.heartbeatStatus = 200;
    await until(
      () => lastReport()?.live === false,
      'the app reported down once the backend took it',
    );
  });

  it('stops within the compose grace when a report on the wire hangs, its farewell sent all the same (W13-R17)', async (): Promise<void> => {
    backend.liveHeartbeatDelayMs = 20_000;
    const running = start();
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    const began = Date.now();
    await running.stop();
    bridge = undefined;
    expect(Date.now() - began).toBeLessThan(FAREWELL_WAIT_MS + FAREWELL_TIMEOUT_MS + 500);
    expect(FAREWELL_WAIT_MS + FAREWELL_TIMEOUT_MS).toBeLessThan(5_000);
    expect(lastReport()).toMatchObject({ surfaceId: 'surface-mateo', live: false });
  });

  it('reports in pages the backend takes in one call (W13-R17)', (): void => {
    const apps = Array.from({ length: REPORT_PAGE * 2 + 1 }, (_, index) => ({
      surfaceId: `s${index}`,
      appId: 'A0OPS',
      live: false,
    }));
    const pages = reportPages({ apps });
    expect(pages.map((page) => page.apps.length)).toEqual([REPORT_PAGE, REPORT_PAGE, 1]);
    expect(pages.flatMap((page) => page.apps)).toEqual(apps);
  });

  it('reports nothing while it holds no app, rather than an empty list every sync (13-FS second pass)', async (): Promise<void> => {
    backend.apps = [];
    const running = start({ syncIntervalMs: 50 });
    await running.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(backend.heartbeats).toEqual([]);
  });

  it('says once, not at every sync, that a backend from before 0.17.0 takes no heartbeat', async (): Promise<void> => {
    backend.heartbeatStatus = 404;
    const running = start({ syncIntervalMs: 50 });
    await running.start();
    await until(() => running.status().apps.some((app) => app.connected), 'the hello');
    const opened = backend.opened;
    await until(() => backend.opened >= opened && logged.length > 0, 'a sync or two');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      logged.filter((line) => line.message === 'the heartbeat could not be reported'),
    ).toHaveLength(1);
  });
});

describe('responseUrlOf (W12-R22)', (): void => {
  it('posts only to Slack’s own response_url over https, or to the host the app’s connection came from', (): void => {
    const at = (response_url: unknown, host?: string): string | undefined =>
      responseUrlOf({ response_url }, host)?.href;
    expect(at('https://hooks.slack.com/actions/T0/1/abc')).toBe(
      'https://hooks.slack.com/actions/T0/1/abc',
    );
    // Only Slack's own hook host, on its default port (13-FS second pass).
    expect(at('https://example.slack.com/actions/T0/1/abc')).toBeUndefined();
    expect(at('https://hooks.slack.com:8443/actions/T0/1/abc')).toBeUndefined();
    expect(at('http://hooks.slack.com/actions/T0/1/abc')).toBeUndefined();
    expect(at('https://hooks.slack.com.example/actions')).toBeUndefined();
    expect(at('https://example.com/actions')).toBeUndefined();
    expect(at('http://fake-slack:8090/actions/1', 'fake-slack:8090')).toBe(
      'http://fake-slack:8090/actions/1',
    );
    expect(at('not a url', 'fake-slack:8090')).toBeUndefined();
    expect(at(undefined)).toBeUndefined();
  });
});

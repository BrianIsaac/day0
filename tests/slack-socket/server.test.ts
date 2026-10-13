import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wayOutOf } from '../../slack-socket/bridge.js';
import { startFakeSlack, type FakeSlack } from '../fake-slack/spawn';

/*
 * The `slack-socket` service behind a customer's HTTP proxy (wave 17, 17-P; RM31 (a), V17-6): the
 * real `server.js`, started as the compose service starts it, with a forward proxy double as its
 * way out, a stand-in for the backend's bridge routes and the real fake Slack. Slack is named by
 * a host only the proxy can resolve, as on a network with no direct route out.
 */

const SERVER = fileURLToPath(new URL('../../slack-socket/server.js', import.meta.url));
const SECRET = 'bridge-secret-for-tests';
/** A name that resolves nowhere: only a proxy that is asked for it can reach the fake. */
const SLACK_HOST = 'wss-primary.slack.test';

interface Listening {
  readonly port: number;
  stop(): Promise<void>;
}

async function listening(server: Server): Promise<Listening> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    stop: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', (): void => {
      const { port } = probe.address() as AddressInfo;
      probe.close((): void => resolve(port));
    });
  });
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/**
 * A forward proxy double: every tunnel it is asked for is recorded by the name it was asked for
 * and carried to the fake Slack, and a plain request (which a proxied call to the backend would
 * be) is recorded and refused.
 */
async function startProxy(slackPort: () => number): Promise<Listening & { seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response): void => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(502).end();
  });
  server.on('connect', (request, client, head): void => {
    seen.push(`CONNECT ${request.url}`);
    const upstream = connect(slackPort(), '127.0.0.1', (): void => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (): void => void client.destroy());
    client.on('error', (): void => void upstream.destroy());
  });
  return Object.assign(await listening(server), { seen });
}

/** The backend's bridge routes: one app, and a connection URL that names Slack by its own host. */
async function startBackend(
  fake: FakeSlack,
  appLevelToken: string,
): Promise<Listening & { calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((request, response): void => {
    void (async (): Promise<void> => {
      calls.push(String(request.url));
      const body = await bodyOf(request);
      const reply = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (request.headers.authorization !== `Bearer ${SECRET}`) return reply(401, {});
      if (request.url === '/slack-socket/apps') {
        return reply(200, { apps: [{ surfaceId: 'surface-mateo', appId: 'A_DAY0_FAKE' }] });
      }
      if (request.url === '/slack-socket/connection' && body.surfaceId === 'surface-mateo') {
        const opened = (await (
          await fetch(`${fake.base}/api/apps.connections.open`, {
            method: 'POST',
            headers: { authorization: `Bearer ${appLevelToken}` },
          })
        ).json()) as { url: string };
        return reply(200, { url: opened.url.replace('127.0.0.1', SLACK_HOST) });
      }
      if (request.url === '/slack-socket/heartbeat') return reply(200, { written: 1 });
      return reply(404, {});
    })().catch((): void => {
      // The fake went away at teardown with a call in flight: answered as a backend that cannot
      // reach Slack, where the bridge is still there to hear it.
      if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
    });
  });
  return Object.assign(await listening(server), { calls });
}

let fake: FakeSlack;
let backend: Awaited<ReturnType<typeof startBackend>>;
let proxy: Awaited<ReturnType<typeof startProxy>>;
let child: ChildProcess | undefined;
let output = '';

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
  proxy = await startProxy(() => Number(new URL(fake.base).port));
  output = '';
}, 20_000);

afterEach(async (): Promise<void> => {
  const service = child;
  child = undefined;
  if (service !== undefined && service.exitCode === null) {
    const exited = new Promise<void>((resolve) => service.once('exit', () => resolve()));
    service.kill('SIGTERM');
    await exited;
  }
  await proxy.stop();
  await backend.stop();
  fake.stop();
});

/** Start the service as compose does, with the given way out, and answer its health address. */
async function startService(wayOut: Readonly<Record<string, string>>): Promise<string> {
  const healthPort = await freePort();
  // Its own environment and nothing of this process's: a proxy this machine's shell names must
  // not reach it.
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    DAY0_SOCKET_BRIDGE_SECRET: SECRET,
    DAY0_SOCKET_BACKEND_URL: `http://127.0.0.1:${backend.port}`,
    SLACK_SOCKET_HEALTH_PORT: String(healthPort),
    ...wayOut,
  };
  const service = spawn(process.execPath, [SERVER], {
    env: environment as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout?.on('data', (chunk: Buffer): void => void (output += String(chunk)));
  service.stderr?.on('data', (chunk: Buffer): void => void (output += String(chunk)));
  child = service;
  return `http://127.0.0.1:${healthPort}/healthz`;
}

async function connected(health: string): Promise<boolean> {
  try {
    const status = (await (await fetch(health)).json()) as {
      apps?: Array<{ connected: boolean }>;
    };
    return status.apps?.[0]?.connected === true;
  } catch {
    // The service has not bound its health port yet.
    return false;
  }
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for ${what}: the proxy saw ${JSON.stringify(proxy.seen)}, the backend ` +
      `${JSON.stringify(backend.calls)}, the service printed ${output.slice(-600)}`,
  );
}

/** The lines the service logged, parsed; Node's own warnings on stderr are not among them. */
function logged(): Array<Record<string, unknown>> {
  return output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the slack-socket service behind an HTTP proxy', (): void => {
  it('opens its socket to Slack through the proxy, and calls the backend directly', async (): Promise<void> => {
    const proxyAddress = `http://day0:hunter2@127.0.0.1:${proxy.port}`;
    const health = await startService({
      HTTPS_PROXY: proxyAddress,
      HTTP_PROXY: proxyAddress,
      NO_PROXY: 'localhost,127.0.0.1,backend',
      NODE_USE_ENV_PROXY: '1',
    });
    await until(() => connected(health), 'the app to hold a connection');

    // The only thing the proxy carried is the tunnel to Slack, asked for by Slack's own name.
    const slackPort = new URL(fake.base).port;
    expect(new Set(proxy.seen)).toEqual(new Set([`CONNECT ${SLACK_HOST}:${slackPort}`]));
    expect(backend.calls).toEqual(
      expect.arrayContaining(['/slack-socket/apps', '/slack-socket/connection']),
    );
    // It says which way out it took, by host and port and never the proxy's password.
    const started = logged().find((line) => line.message === 'started');
    expect(started?.wayOut).toBe(`the proxy at 127.0.0.1:${proxy.port}`);
    expect(output).not.toContain('hunter2');
  }, 30_000);

  it('says so, loudly, when a proxy is named and this process would not read it', async (): Promise<void> => {
    const health = await startService({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` });
    await until(
      async () => logged().some((line) => line.message === 'started') || (await connected(health)),
      'the service to start',
    );
    const warned = logged().find((line) => line.level === 'error');
    expect(warned?.message).toBe(
      'HTTPS_PROXY names a proxy and this process does not read it: NODE_USE_ENV_PROXY is not 1. ' +
        'The socket to Slack is dialled directly, which a network with no direct route out refuses.',
    );
    expect(logged().find((line) => line.message === 'started')?.wayOut).toBe('direct');
    expect(proxy.seen).toEqual([]);
  }, 30_000);
});

describe('the way out the bridge reports', (): void => {
  it('is direct when no proxy is named', (): void => {
    expect(wayOutOf({}, 'v22.23.2')).toEqual({ wayOut: 'direct' });
    expect(wayOutOf({ NO_PROXY: 'backend', NODE_USE_ENV_PROXY: '1' }, 'v22.23.2')).toEqual({
      wayOut: 'direct',
    });
  });

  it('is the proxy, by host and port, when Node reads it', (): void => {
    expect(
      wayOutOf(
        { HTTPS_PROXY: 'http://u:p@proxy.acme.test:3128', NODE_USE_ENV_PROXY: '1' },
        'v22.23.2',
      ),
    ).toEqual({ wayOut: 'the proxy at proxy.acme.test:3128' });
  });

  it('is direct, with the reason, on a Node too old to read one', (): void => {
    expect(
      wayOutOf({ HTTPS_PROXY: 'http://proxy.acme.test:3128', NODE_USE_ENV_PROXY: '1' }, 'v22.12.0'),
    ).toEqual({
      wayOut: 'direct',
      ignored:
        'HTTPS_PROXY names a proxy and this process does not read it: this Node (v22.12.0) is ' +
        'older than 22.21.0. The socket to Slack is dialled directly, which a network with no ' +
        'direct route out refuses.',
    });
  });
});

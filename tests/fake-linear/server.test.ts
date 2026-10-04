import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createSecretMcpClient } from '../../src/surfaces/mcp-client';
import { hasHostTool } from '../setup/host-tools';
import { MCP_INVALID_TOKEN } from '../fixtures/linear/linear-oauth-2026-10-02';

const SERVER = fileURLToPath(new URL('../../fake-linear/server.js', import.meta.url));
const HEALTHCHECK = fileURLToPath(new URL('../../fake-linear/healthcheck.js', import.meta.url));
const MAKE_TLS = fileURLToPath(new URL('../../fake-linear/make-tls.sh', import.meta.url));
const REDIRECT = 'http://127.0.0.1:3580/api/oauth/linear';

const children: ChildProcess[] = [];
const scratch: string[] = [];

afterAll((): void => {
  for (const child of children) child.kill('SIGTERM');
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', (): void => {
      const { port } = probe.address() as AddressInfo;
      probe.close((): void => resolve(port));
    });
  });
}

/** Start the listener on a port of its own and wait for its health. */
async function start(env: Record<string, string> = {}): Promise<{ port: number; base: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      FAKE_LINEAR_PORT: String(port),
      FAKE_LINEAR_REDIRECT_URIS: REDIRECT,
      ...env,
    },
    stdio: 'ignore',
  });
  children.push(child);
  const healthy = (): boolean =>
    spawnSync(process.execPath, [HEALTHCHECK], {
      env: { ...process.env, FAKE_LINEAR_PORT: String(port), ...env },
    }).status === 0;
  for (let attempt = 0; attempt < 60 && !healthy(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthy()) throw new Error('the fake Linear did not start');
  return { port, base: `http://127.0.0.1:${port}` };
}

describe('the fake Linear listener', (): void => {
  it('serves the default shared app its client-credentials token over plain HTTP', async (): Promise<void> => {
    const { base } = await start();
    const answer = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'day0-fake-linear-shared',
        client_secret: 'day0-fake-linear-shared-secret',
        scope: 'read,write,app:assignable',
      }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ scope: 'app:assignable read write' });
  });

  it('takes its apps, people and workspace from the environment', async (): Promise<void> => {
    const { base } = await start({
      FAKE_LINEAR_PEOPLE: JSON.stringify([
        {
          id: 'p-1',
          name: 'Ines',
          displayName: 'ines',
          email: 'ines@acme.test',
          admin: true,
          apiKey: 'lin_api_day0_fake_ines',
        },
      ]),
      FAKE_LINEAR_WORKSPACE: JSON.stringify({ teams: [{ key: 'FIN', name: 'Finance close' }] }),
    });
    const answer = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { authorization: 'lin_api_day0_fake_ines', 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { name } teams { nodes { key } } }' }),
    });
    expect(await answer.json()).toEqual({
      data: { viewer: { name: 'Ines' }, teams: { nodes: [{ key: 'FIN' }] } },
    });
  });

  it("answers Day0's own MCP client: it connects with an app actor's token and lists the tools", async (): Promise<void> => {
    const { base } = await start();
    const token = (
      (await (
        await fetch(`${base}/oauth/token`, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: 'day0-fake-linear-shared',
            client_secret: 'day0-fake-linear-shared-secret',
            scope: 'read,write,app:assignable',
          }),
        })
      ).json()) as { access_token: string }
    ).access_token;
    const client = createSecretMcpClient({
      servers: {
        linear: {
          url: new URL(`${base}/mcp`),
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        },
      },
    });
    try {
      const tools = await client.listTools();
      expect(Object.keys(tools)).toHaveLength(66);
      expect(Object.keys(tools)).toContain('linear_save_comment');
    } finally {
      await client.disconnect();
    }
  });

  it('refuses a token it does not hold over the wire as recorded', async (): Promise<void> => {
    const { base } = await start();
    const answer = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer lin_oauth_never_issued',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(answer.status).toBe(401);
    expect(await answer.text()).toBe(MCP_INVALID_TOKEN.body);
  });

  it.skipIf(!hasHostTool('openssl'))(
    "serves https under Linear's names with a certificate its throwaway CA signed (needs openssl)",
    async (): Promise<void> => {
      const directory = mkdtempSync(join(tmpdir(), 'fake-linear-tls-'));
      scratch.push(directory);
      const made = spawnSync('bash', [MAKE_TLS, directory], { encoding: 'utf8' });
      expect(made.status, made.stderr).toBe(0);
      const { port } = await start({ FAKE_LINEAR_TLS_DIR: directory });
      const ca = readFileSync(join(directory, 'ca.pem'));
      for (const servername of ['api.linear.app', 'linear.app', 'mcp.linear.app']) {
        const status = await new Promise<number>((resolve, reject) => {
          const probe = httpsRequest(
            {
              host: '127.0.0.1',
              port,
              path: '/healthz',
              servername,
              ca,
              headers: { host: servername },
            },
            (response) => {
              response.resume();
              resolve(response.statusCode ?? 0);
            },
          );
          probe.on('error', reject);
          probe.end();
        });
        expect(status, servername).toBe(200);
      }
      expect(readFileSync(join(directory, 'cas.pem'), 'utf8')).toBe(ca.toString());
      // Only what the overlay mounts: the CA's serial is kept with its key, which is deleted.
      expect(readdirSync(directory).sort()).toEqual([
        'bundle.pem',
        'ca.pem',
        'cas.pem',
        'cert.pem',
        'key.pem',
      ]);
    },
  );
});

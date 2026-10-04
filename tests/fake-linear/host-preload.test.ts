import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LINEAR_HOSTS, rerouteOf } from '../../fake-linear/host-reroute.mjs';

const PRELOAD = fileURLToPath(new URL('../../fake-linear/host-preload.mjs', import.meta.url));
const FAKE = 'https://127.0.0.1:3647';

describe("the bed's host preload", (): void => {
  it("sends each of Linear's three hosts to the fake, keeping the path and the query", (): void => {
    expect(LINEAR_HOSTS).toEqual(['api.linear.app', 'linear.app', 'mcp.linear.app']);
    for (const host of LINEAR_HOSTS) {
      expect(rerouteOf(new URL(`https://${host}/oauth/token?x=1`), FAKE)).toEqual({
        rerouted: new URL(`${FAKE}/oauth/token?x=1`),
      });
    }
  });

  it('refuses any other linear.app host, so a bed never reaches Linear itself', (): void => {
    expect(rerouteOf(new URL('https://uploads.linear.app/file'), FAKE)).toEqual({
      refused: expect.stringContaining('uploads.linear.app'),
    });
  });

  it('leaves every other address alone, a look-alike host included', (): void => {
    expect(rerouteOf(new URL('https://slack.com/api/auth.test'), FAKE)).toBeUndefined();
    expect(rerouteOf(new URL('https://notlinear.app/x'), FAKE)).toBeUndefined();
  });
});

describe('the preload in a Node process', (): void => {
  let server: Server;
  let base = '';
  const seen: string[] = [];

  beforeAll(async (): Promise<void> => {
    server = createServer((request, response): void => {
      seen.push(`${request.method} ${request.url}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async (): Promise<void> => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("routes the process's fetch to api.linear.app to the fake, body and all", async (): Promise<void> => {
    const script =
      "const r = await fetch('https://api.linear.app/oauth/revoke', { method: 'POST', body: 'token=x' });" +
      'console.log(r.status);';
    // Spawned, not run synchronously: the fake below answers on this process's own event loop.
    const child = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const run = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, NODE_OPTIONS: `--import ${PRELOAD}`, FAKE_LINEAR_HOST_URL: base },
      });
      let stdout = '';
      run.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      run.on('close', (status) => resolve({ status, stdout }));
    });
    expect(child.stdout.trim()).toBe('200');
    expect(seen).toContain('POST /oauth/revoke');
  });
});

describe('the preload loaded without the fake named', (): void => {
  it('stops the process rather than let a fetch reach Linear', async (): Promise<void> => {
    // Empty is unset to the preload, which trims the value.
    const env = { ...process.env, NODE_OPTIONS: `--import ${PRELOAD}`, FAKE_LINEAR_HOST_URL: '' };
    const run = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', 'console.log("ran")'], {
        env,
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('close', (status) => resolve({ status, stderr }));
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('FAKE_LINEAR_HOST_URL');
  });
});

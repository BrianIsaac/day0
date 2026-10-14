import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAKE_BOT_TOKEN, startFakeSlack } from './spawn';

const SERVER = fileURLToPath(new URL('../../fake-slack/server.js', import.meta.url));

/*
 * How a test starts the fake Slack (18-G). The harness used to ask the system for a free port,
 * let it go and start the fake on it; under the gate's load another worker's fake took the port
 * in between, this fake died of EADDRINUSE unseen, and the test talked to the other one until
 * its file stopped it ("slack could not be reached", an empty body, another file's calls).
 */
describe('startFakeSlack (18-G)', (): void => {
  it('starts the fake on a port it binds itself, which it says on its first line', async (): Promise<void> => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, FAKE_SLACK_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const [line] = (await once(createInterface({ input: child.stdout }), 'line')) as [string];
      const port = Number(/^fake-slack listening on (\d+)$/.exec(line)?.[1]);
      expect(port).toBeGreaterThan(0);
      expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({ ok: true });
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('refuses a fake whose process ends before it listens, with what the process said', async (): Promise<void> => {
    await expect(
      startFakeSlack({ NODE_OPTIONS: '--require ./no-such-preload-for-18-g.cjs' }),
    ).rejects.toThrow(/the fake Slack service ended before it listened.*no-such-preload-for-18-g/s);
  });

  it('answers nothing more once it is stopped, not even on a connection already open', async (): Promise<void> => {
    // A fake that only closed its listener went on answering kept-alive connections for seconds,
    // and a WebSocket's upgrade rode one: a case that stopped the fake found it connected (18-G).
    const fake = await startFakeSlack();
    const { hostname, port } = new URL(fake.base);
    const open = request({ host: hostname, port, method: 'POST', path: '/api/auth.test' });
    const answered = new Promise<string>((resolve) => {
      open.on('response', (response) => resolve(`answered ${response.statusCode}`));
      open.on('error', (error: NodeJS.ErrnoException) => resolve(`ended: ${error.code}`));
    });
    open.write('token=');
    await once(open, 'socket');
    fake.stop();
    // Stopped once it refuses a new connection; the request above is still being written.
    for (;;) {
      const probe = connect(Number(port), hostname);
      const refused = await new Promise<boolean>((resolve) => {
        probe.once('connect', () => resolve(false));
        probe.once('error', () => resolve(true));
      });
      probe.destroy();
      if (refused) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    open.end(FAKE_BOT_TOKEN);
    expect(await answered).toMatch(/^ended: /);
  });

  it('gives each fake started at once its own process, whose evidence no other fake shares', async (): Promise<void> => {
    const fakes = await Promise.all(Array.from({ length: 4 }, async () => await startFakeSlack()));
    try {
      expect(new Set(fakes.map((fake) => fake.base)).size).toBe(4);
      await fetch(`${fakes[0]!.base}/api/chat.postMessage`, {
        method: 'POST',
        headers: { authorization: `Bearer ${FAKE_BOT_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'D_DAY0_MANAGER', text: 'Only the first.' }),
      });
      const posts = await Promise.all(
        fakes.map(async (fake) => {
          const proof = (await (await fetch(`${fake.base}/proof`)).json()) as {
            postsByChannel: Record<string, number>;
          };
          return proof.postsByChannel.D_DAY0_MANAGER ?? 0;
        }),
      );
      expect(posts).toEqual([1, 0, 0, 0]);
    } finally {
      for (const fake of fakes) fake.stop();
    }
  });
});

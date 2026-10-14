import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

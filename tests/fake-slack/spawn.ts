import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../fake-slack/server.js', import.meta.url));

/** The bot token the fake accepts, assembled here so no file carries it whole. */
export const FAKE_BOT_TOKEN = ['xoxb', 'day0', 'fake', 'dedicated', 'token'].join('-');

export interface FakeSlack {
  base: string;
  stop: () => void;
}

/**
 * A port nothing listens on. A fixed port let two checkouts running this
 * file at once share one server, and each read the other's call counts.
 *
 * Returns:
 *   The port the operating system handed out.
 */
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

async function ready(base: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // The child has not bound the socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the fake Slack service did not start');
}

/**
 * Start the fake Slack service on its own port.
 *
 * Returns:
 *   The service's base URL and the call that stops it.
 */
export async function startFakeSlack(): Promise<FakeSlack> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FAKE_SLACK_PORT: String(port) },
    stdio: 'ignore',
  });
  await ready(base);
  return { base, stop: (): void => void child.kill('SIGTERM') };
}

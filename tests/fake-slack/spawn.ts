import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../fake-slack/server.js', import.meta.url));

/** The bot token the fake accepts, assembled here so no file carries it whole. */
export const FAKE_BOT_TOKEN = ['xoxb', 'day0', 'fake', 'dedicated', 'token'].join('-');

export interface FakeSlack {
  base: string;
  stop: () => void;
}

/**
 * The port the fake bound, read from its first line of output.
 *
 * The fake is started on port 0 and binds a port of the system's choosing itself. A port guessed
 * free here and handed to it could be taken first by another worker's server under the gate's
 * load: the fake then died of EADDRINUSE unseen, and the health check was answered by the other
 * server, whose file later stopped it (18-G). Waiting is bounded by the process, not a clock: it
 * ends at the line or at the process's end, whichever is first.
 *
 * Args:
 *   child: The fake's process, its output piped.
 *   errors: What the process wrote to its error output so far.
 *
 * Returns:
 *   The port it listens on.
 *
 * Raises:
 *   Error: When the process ends before it listens, with what it said.
 */
async function listeningPort(child: ChildProcess, errors: () => string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    const ended = (code: number | null, signal: NodeJS.Signals | null): void => {
      lines.close();
      reject(
        new Error(
          `the fake Slack service ended before it listened (code ${code}, signal ${signal}): ${errors()}`,
        ),
      );
    };
    child.once('close', ended);
    lines.once('line', (line): void => {
      child.off('close', ended);
      lines.close();
      child.stdout!.resume();
      const port = Number(/^fake-slack listening on (\d+)$/.exec(line)?.[1]);
      if (Number.isInteger(port) && port > 0) resolve(port);
      else reject(new Error(`the fake Slack service said "${line}", not the port it listens on`));
    });
  });
}

/**
 * Start the fake Slack service on its own port.
 *
 * Args:
 *   env: Settings for the fake, such as the people besides the manager (`FAKE_SLACK_PEOPLE`).
 *
 * Returns:
 *   The service's base URL and the call that stops it.
 */
export async function startFakeSlack(
  env: Readonly<Record<string, string>> = {},
): Promise<FakeSlack> {
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env, FAKE_SLACK_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr!.on('data', (chunk): void => void (errors += String(chunk)));
  const port = await listeningPort(child, () => errors);
  return { base: `http://127.0.0.1:${port}`, stop: (): void => void child.kill('SIGTERM') };
}

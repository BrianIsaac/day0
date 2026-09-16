/// <reference types="node" />
/**
 * `pnpm dev`: print the unlock URL, then serve the app on this installation's
 * port.
 *
 * The port is one setting read in three places (`pnpm setup:local --app-port`
 * writes it, the URL printer names it, this serves on it): `PORT` from the
 * shell wins, then `DAY0_APP_PORT` in `.env.local`, then 3000. Until this
 * script existed the server was pinned to 3000 in package.json while the URL
 * followed `PORT`, so a second stack on another port printed an address
 * nothing answered on.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENV_FILE = '.env.local';
const APP_PORT_VAR = 'DAY0_APP_PORT';
const DEFAULT_APP_PORT = '3000';

/**
 * The app port: the shell's `PORT`, else the file's `DAY0_APP_PORT`, else 3000.
 *
 * Args:
 *   shellPort: `process.env.PORT`.
 *   envText: The env file's text, or undefined when there is none.
 *
 * Returns:
 *   The port as a string.
 */
export function resolveAppPort(shellPort: string | undefined, envText: string | undefined): string {
  const fromShell = (shellPort ?? '').trim();
  if (fromShell !== '') return fromShell;
  for (const line of (envText ?? '').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[1] === APP_PORT_VAR) {
      const value = match[2].trim().replace(/^"(.*)"$/, '$1');
      if (value !== '') return value;
    }
  }
  return DEFAULT_APP_PORT;
}

function main(): void {
  const port = resolveAppPort(
    process.env.PORT,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined,
  );
  const url = spawnSync('tsx', ['scripts/dev-no-auth-key.ts', 'url'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: port },
  });
  if (url.status !== 0) {
    process.exit(url.status ?? 1);
  }
  const server = spawn('next', ['dev', '-H', 'localhost', '-p', port], {
    stdio: 'inherit',
    env: { ...process.env, PORT: port },
  });
  // Ctrl-C reaches both processes as the foreground group; this one only
  // waits for the server and reports its exit.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, (): void => {
      server.kill(signal);
    });
  }
  server.on('exit', (code: number | null, signal: NodeJS.Signals | null): void => {
    process.exit(code ?? (signal ? 130 : 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

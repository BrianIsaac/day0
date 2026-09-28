/// <reference types="node" />
/**
 * `pnpm dev`: print the unlock URL, then serve the app on this installation's
 * address and port.
 *
 * The port is one setting read in three places (`pnpm setup:local --app-port`
 * writes it, the URL printer names it, this serves on it): `PORT` from the
 * shell wins, then `DAY0_APP_PORT` in `.env.local`, then 3000. Until this
 * script existed the server was pinned to 3000 in package.json while the URL
 * followed `PORT`, so a second stack on another port printed an address
 * nothing answered on.
 *
 * The address is a setting the same way (`DAY0_APP_HOST`, loopback by name
 * unless set), so an app run somewhere other than the operator's own
 * shell - a container that must bind every interface - says so in one place
 * rather than editing this file.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ENV_FILE = '.env.local';
const APP_PORT_VAR = 'DAY0_APP_PORT';
const DEFAULT_APP_PORT = '3000';
const APP_HOST_VAR = 'DAY0_APP_HOST';
const DEFAULT_APP_HOST = 'localhost';

/** One name's value in the env file's text, unquoted, or undefined when unset or empty. */
function fromEnvText(envText: string | undefined, name: string): string | undefined {
  for (const line of (envText ?? '').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match && match[1] === name) {
      const value = match[2].trim().replace(/^"(.*)"$/, '$1');
      if (value !== '') return value;
    }
  }
  return undefined;
}

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
  return fromEnvText(envText, APP_PORT_VAR) ?? DEFAULT_APP_PORT;
}

/**
 * The address the app binds: the shell's `DAY0_APP_HOST`, else the file's, else `localhost`.
 *
 * @param shellHost - `process.env.DAY0_APP_HOST`.
 * @param envText - The env file's text, or undefined when there is none.
 * @returns The host name or address `next dev -H` is given.
 */
export function resolveAppHost(shellHost: string | undefined, envText: string | undefined): string {
  const fromShell = (shellHost ?? '').trim();
  if (fromShell !== '') return fromShell;
  return fromEnvText(envText, APP_HOST_VAR) ?? DEFAULT_APP_HOST;
}

/**
 * Next's anonymous usage report switch for a server this product starts: off
 * unless the shell sets it (C-34), since a local run reports nothing it was
 * not asked to. `next dev` is the one command of ours that reports while it
 * runs; the gate's build takes the switch from the workflow.
 *
 * @param shell - The environment the operator ran the command from.
 */
export function nextTelemetrySetting(shell: Readonly<Record<string, string | undefined>>): {
  NEXT_TELEMETRY_DISABLED: string;
} {
  return { NEXT_TELEMETRY_DISABLED: shell.NEXT_TELEMETRY_DISABLED ?? '1' };
}

/**
 * The environment `next dev` runs with: the shell's, the chosen port, and
 * Next's telemetry off unless the shell says otherwise.
 *
 * @param shell - The environment the operator ran `pnpm dev` from.
 * @param port - The port the server binds.
 */
export function devServerEnvironment<Shell extends Readonly<Record<string, string | undefined>>>(
  shell: Shell,
  port: string,
): Shell & { PORT: string; NEXT_TELEMETRY_DISABLED: string } {
  return { ...shell, PORT: port, ...nextTelemetrySetting(shell) };
}

function main(): void {
  const envText = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined;
  const port = resolveAppPort(process.env.PORT, envText);
  const host = resolveAppHost(process.env[APP_HOST_VAR], envText);
  const url = spawnSync('tsx', ['scripts/dev-no-auth-key.ts', 'url'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: port },
  });
  if (url.status !== 0) {
    process.exit(url.status ?? 1);
  }
  const server = spawn('next', ['dev', '-H', host, '-p', port], {
    stdio: 'inherit',
    env: devServerEnvironment(process.env, port),
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

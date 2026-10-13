/// <reference types="node" />
/**
 * `pnpm start`: serve the built app behind the customer's reverse proxy.
 *
 * The address is loopback unless `DAY0_APP_HOST` widens it (the shell's, then
 * `.env.local`'s), so the app's plain port is not on the customer's network
 * beside the proxy that terminates TLS for it (wave 17, P-1). Until this
 * script existed `pnpm start` was `next start -p 3000` with no address, which
 * binds every interface. The port follows the rule `pnpm dev` already has:
 * `PORT` from the shell, then `DAY0_APP_PORT` in `.env.local`, then 3000.
 *
 * Where `.env.local` names a proxy on the way out (`HTTPS_PROXY`,
 * `HTTP_PROXY`, `NO_PROXY`), Node is started with it: Next reads the file
 * after Node has started, and Node reads a proxy from its environment only at
 * its start (RM31 (a)). A Node too old to read one is refused here rather
 * than left to dial out directly.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromEnvText, resolveAppPort } from './dev';
import {
  hostProxyEnvironment,
  proxyConfigured,
  proxyForDisplay,
  proxyNodeGap,
  proxySettings,
  type ProxySettings,
} from './lib/proxy-env';

const ENV_FILE = '.env.local';
const APP_HOST_VAR = 'DAY0_APP_HOST';

/** The address `pnpm start` binds unless `DAY0_APP_HOST` names another: loopback, by address. */
export const START_HOST = '127.0.0.1';

type Shell = Readonly<Record<string, string | undefined>>;

/**
 * The address the app binds: the shell's `DAY0_APP_HOST`, else the file's, else loopback. By
 * address rather than by name, since a proxy on this machine forwards to `127.0.0.1` and
 * `localhost` may bind the IPv6 loopback alone.
 *
 * @param shellHost - `process.env.DAY0_APP_HOST`.
 * @param envText - The env file's text, or undefined when there is none.
 */
export function resolveStartHost(
  shellHost: string | undefined,
  envText: string | undefined,
): string {
  const fromShell = (shellHost ?? '').trim();
  if (fromShell !== '') return fromShell;
  return fromEnvText(envText, APP_HOST_VAR) ?? START_HOST;
}

/** What `next` is given: the built app, on one address and port. */
export function startArguments(host: string, port: string): string[] {
  return ['start', '-H', host, '-p', port];
}

/** The way out as the shell names it, else as the file does, one name at a time. */
function wayOut(shell: Shell, envText: string | undefined): ProxySettings {
  return proxySettings((name) => (shell[name] ?? '').trim() || fromEnvText(envText, name));
}

/**
 * The environment `next start` runs with: the shell's, the chosen port, the proxy on the way out
 * when one is named, and Next's own usage telemetry off unless the shell names its switch. Next
 * sends its maker figures from a start unless told not to before it starts, and
 * `telemetry.nextjs.org` is a host no list Day0 prints names (found at a bed's forward proxy, 13
 * October 2026; docs/running/egress.md). The build is told the same by its script.
 *
 * @param shell - The environment `pnpm start` was run from.
 * @param envText - The env file's text, or undefined when there is none.
 * @param port - The port the server binds.
 */
export function startEnvironment<Given extends Shell>(
  shell: Given,
  envText: string | undefined,
  port: string,
): Given & Record<string, string | undefined> {
  return {
    NEXT_TELEMETRY_DISABLED: '1',
    ...shell,
    PORT: port,
    ...hostProxyEnvironment(wayOut(shell, envText)),
  };
}

/**
 * Why the app is not started, or undefined when it may be: a proxy is named and this Node would
 * ignore it.
 *
 * @param shell - The environment `pnpm start` was run from.
 * @param envText - The env file's text, or undefined when there is none.
 * @param nodeVersion - `process.version`.
 */
export function startRefusal(
  shell: Shell,
  envText: string | undefined,
  nodeVersion: string,
): string | undefined {
  return proxyNodeGap(nodeVersion, wayOut(shell, envText));
}

function main(): void {
  const envText = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined;
  const refusal = startRefusal(process.env, envText, process.version);
  if (refusal !== undefined) {
    console.error(`error: ${refusal} Nothing was started.`);
    process.exit(1);
  }
  const port = resolveAppPort(process.env.PORT, envText);
  const host = resolveStartHost(process.env[APP_HOST_VAR], envText);
  const proxy = wayOut(process.env, envText);
  if (proxyConfigured(proxy)) {
    const address = proxy.httpsProxy ?? proxy.httpProxy ?? '';
    console.log(
      `The app's requests go out through the proxy at ${proxyForDisplay(address)} ` +
        '(docs/running/egress.md).',
    );
  }
  const server = spawn('next', startArguments(host, port), {
    stdio: 'inherit',
    env: startEnvironment(process.env, envText, port),
  });
  // Ctrl-C reaches both processes as the foreground group; a service manager's
  // stop reaches this one, which hands it on and reports the server's exit.
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

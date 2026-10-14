/// <reference types="node" />

/*
 * The way out through a customer's HTTP proxy (wave 17, 17-P; RM31 (a)). A site that allows no
 * direct route to the internet names its proxy once, in `.env.local`, by the names every HTTP
 * client already reads. The compose file hands them to each service that reaches out; this module
 * is what the processes started on this machine (the app under `pnpm start`, the setup's children,
 * the checks and their probes) are given, since Node reads a proxy from its environment only when
 * `NODE_USE_ENV_PROXY=1` is set before it starts, and Next reads `.env.local` after.
 */

/** The names the way out is given by: the three every client reads, and Node's own switch. */
export const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
] as const;

/** The first Node on the 22 line that reads a proxy from the environment. */
export const ENV_PROXY_NODE = '22.21.0';

/**
 * This machine's own names, which never go through a proxy: the backend's published port is here.
 * The two every address Day0 writes for this machine uses, and both are among the services' own
 * list, so a check run with this in its environment still asks no more of the deployment than
 * `pnpm sync:env` put there.
 */
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1'] as const;

/**
 * What never takes the proxy from inside a container: the container itself, this machine as a
 * container names it, and every compose service another one dials by name. The compose file
 * begins each service's `NO_PROXY` with this list, and `pnpm sync:env` puts it on the deployment
 * (`deploymentNoProxy`); `tests/docker-compose.test.ts` holds the two to each other.
 */
export const SERVICE_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  'host.docker.internal',
  'backend',
  'dashboard',
  'model',
  'redactor',
  'docs-notion-mcp',
  'notion-mcp',
  'slack-socket',
  'looker-tile',
  'playwright-mcp',
  'nango-server',
  'nango-db',
  'nango-redis',
] as const;

/**
 * `NO_PROXY` as the deployment must hold it when a proxy is named: the services' own list, then
 * what the customer's IT listed, as given.
 *
 * The backend's Node executor runs each function with the deployment's variables in place of the
 * container's (an allow-list of six names survives, and the proxy names are not among them),
 * while Node's proxy agent, built when the executor started, keeps the proxy and reads `NO_PROXY`
 * again at every request. Without this value on the deployment, every request a Node action
 * makes takes the proxy, its own calls back to the backend at `127.0.0.1` among them, and each
 * fails there (found on the bed `day0-w17p`, 13 October 2026; docs/running/egress.md).
 *
 * @param named - `NO_PROXY` as `.env.local` gives it.
 */
export function deploymentNoProxy(named: string | undefined): string {
  const given = (named ?? '').trim();
  return `${SERVICE_NO_PROXY.join(',')}${given === '' ? '' : `,${given}`}`;
}

/** The names an exclusion list holds, trimmed, none empty. */
export function noProxyEntries(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Whether Node keeps an address out of the proxy under this exclusion list: only where both of
 * the clients it reads the list with (`fetch`, and `node:http`'s own agent) keep it out, since
 * Day0's processes use both. A name keeps out itself alone; a leading `.` or `*.` keeps out the
 * names under it and not itself (`fetch` proxies the bare domain); a port narrows an entry to it;
 * `*` keeps out everything; an address range is never read. As Node 22.23.2 answered, each case
 * kept in `tests/fixtures/proxy/node-22.23.2-no-proxy.json` (W17-R27): until 0.22.0 `check:setup`
 * read `acme.com` as keeping out `day0.acme.com`, which Node sends to the proxy.
 *
 * @param address - The URL asked for.
 * @param noProxy - `NO_PROXY` as written.
 */
export function keptOutOfProxy(address: string, noProxy: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return noProxyEntries(noProxy).some((entry) => {
    if (entry === '*') return true;
    const [, named = entry, narrowed] = /^(.+):(\d+)$/.exec(entry) ?? [];
    if (narrowed !== undefined && narrowed !== port) return false;
    const name = named.toLowerCase();
    if (name.startsWith('.')) return host.endsWith(name);
    if (name.startsWith('*.')) return host.endsWith(name.slice(1));
    return host === name;
  });
}

/**
 * The names the deployment's `NO_PROXY` lacks: every one of the services' own list and of the
 * list as configured must be there, in any order and however often. Compared by what is
 * excluded rather than letter for letter, since the same list reaches a check through the
 * setup with this machine's names put before it.
 *
 * @param held - `NO_PROXY` as the deployment holds it.
 * @param named - `NO_PROXY` as configured.
 */
export function missingFromDeployment(
  held: string | undefined,
  named: string | undefined,
): string[] {
  const present = new Set(noProxyEntries(held).map((entry) => entry.toLowerCase()));
  return [...new Set([...SERVICE_NO_PROXY, ...noProxyEntries(named)])].filter(
    (entry) => !present.has(entry.toLowerCase()),
  );
}

/** The way out as configured; a name that is unset or empty is absent. */
export interface ProxySettings {
  readonly httpsProxy?: string;
  readonly httpProxy?: string;
  readonly noProxy?: string;
  /** `NODE_USE_ENV_PROXY` as given, which only `1` turns on. */
  readonly useEnvProxy?: string;
}

/**
 * The way out as the environment names it.
 *
 * @param read - One name's value: the shell's, the env file's, or the two layered.
 */
export function proxySettings(read: (name: string) => string | undefined): ProxySettings {
  const value = (name: string): string | undefined => read(name)?.trim() || undefined;
  const httpsProxy = value('HTTPS_PROXY');
  const httpProxy = value('HTTP_PROXY');
  const noProxy = value('NO_PROXY');
  const useEnvProxy = value('NODE_USE_ENV_PROXY');
  return {
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
    ...(useEnvProxy === undefined ? {} : { useEnvProxy }),
  };
}

/** Whether a proxy is named at all: an exclusion list alone sends nothing anywhere. */
export function proxyConfigured(settings: ProxySettings): boolean {
  return settings.httpsProxy !== undefined || settings.httpProxy !== undefined;
}

/**
 * An exclusion list holding the names that must always be reached directly, then the ones the
 * customer's IT gave, each once.
 *
 * @param named - `NO_PROXY` as configured.
 * @param always - The names Day0 itself never proxies.
 */
export function mergedNoProxy(named: string | undefined, always: readonly string[]): string {
  const kept = noProxyEntries(named).filter(
    (entry) => !always.some((name) => name.toLowerCase() === entry.toLowerCase()),
  );
  return [...always, ...kept].join(',');
}

/**
 * What a Node process on this machine is started with so its requests take the proxy: the proxy's
 * address, this machine's own names kept out of it, and Node's switch. Nothing when no proxy is
 * named, so an install without one starts exactly as before.
 *
 * @param settings - The way out as configured.
 */
export function hostProxyEnvironment(settings: ProxySettings): Record<string, string> {
  if (!proxyConfigured(settings)) return {};
  return {
    ...(settings.httpsProxy === undefined ? {} : { HTTPS_PROXY: settings.httpsProxy }),
    ...(settings.httpProxy === undefined ? {} : { HTTP_PROXY: settings.httpProxy }),
    NO_PROXY: mergedNoProxy(settings.noProxy, LOOPBACK_NO_PROXY),
    NODE_USE_ENV_PROXY: '1',
  };
}

/**
 * What a command on this machine must be started again with so that it, and every child it
 * starts, takes the way out the install names: undefined when it already holds it, or when no
 * proxy is named.
 *
 * A check run by hand starts in a shell that names no proxy while `.env.local` does. Its own
 * requests would then dial out directly, and its Convex CLI children, handed the file's values as
 * written, would send their calls to this machine's backend to the proxy (found on the bed
 * `day0-w17p`, 13 October 2026: nine refused, and two findings that were not so). Started by the
 * setup, or once restarted, it holds exactly this and runs as it is.
 *
 * @param shell - The environment the command was started with.
 * @param file - The env file's values.
 */
export function restartEnvironment(
  shell: Readonly<Record<string, string | undefined>>,
  file: Readonly<Record<string, string | undefined>>,
): Record<string, string> | undefined {
  const wanted = hostProxyEnvironment(
    proxySettings((name) => (shell[name] ?? '').trim() || file[name]),
  );
  return Object.entries(wanted).some(([name, value]) => shell[name] !== value) ? wanted : undefined;
}

/**
 * Whether a Node reads `NODE_USE_ENV_PROXY`: 22.21.0 or later on the 22 line, and 24 or later (the
 * 23 line ended without it).
 *
 * @param version - `process.version`.
 */
export function nodeReadsEnvProxy(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 22 && minor >= 21);
}

/**
 * Why a proxy that is named would be ignored by this Node, or undefined when it is read (or none
 * is named). A process that ignored it would dial out directly, which a site with no direct route
 * meets as timeouts with no cause.
 *
 * @param version - `process.version`.
 * @param settings - The way out as configured.
 */
export function proxyNodeGap(version: string, settings: ProxySettings): string | undefined {
  if (!proxyConfigured(settings) || nodeReadsEnvProxy(version)) return undefined;
  const name = settings.httpsProxy !== undefined ? 'HTTPS_PROXY' : 'HTTP_PROXY';
  return (
    `${name} names a proxy, and this Node (${version}) does not read one from the ` +
    `environment: Node ${ENV_PROXY_NODE} or later does. Its requests would go out directly.`
  );
}

/**
 * A proxy's address for a line a person reads: its host and port, never the user and password an
 * authenticating proxy's address carries.
 *
 * @param address - The proxy's URL as configured.
 */
export function proxyForDisplay(address: string): string {
  // Not a URL a client can use: said as that, so the value (which may hold a password) is never
  // echoed, and a host and port written without a scheme is not shown as an empty host.
  return usableProxyAddress(address) ? new URL(address).host : 'an address that is not a URL';
}

/** Whether a proxy's address is one an HTTP client can use: an http or https URL with a host. */
function usableProxyAddress(address: string): boolean {
  try {
    const url = new URL(address);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host !== '';
  } catch {
    return false;
  }
}

/**
 * Why a named proxy cannot be used, or undefined when each address is one a client can use (or
 * none is named). The usual slip is the host and port with no scheme, which a URL parser reads as
 * a scheme and no host; a client given that dials nothing it can name. Said by the setting's name
 * and never its value, which may hold a password.
 *
 * @param settings - The way out as configured.
 */
export function proxyAddressGap(settings: ProxySettings): string | undefined {
  const unusable = (
    [
      ['HTTPS_PROXY', settings.httpsProxy],
      ['HTTP_PROXY', settings.httpProxy],
    ] as const
  ).find(([, address]) => address !== undefined && !usableProxyAddress(address));
  return unusable === undefined
    ? undefined
    : `${unusable[0]} is not an address a client can use: write it as http://<host>:<port>.`;
}

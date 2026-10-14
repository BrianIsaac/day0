/// <reference types="node" />

/*
 * The way out through a customer's HTTP proxy (wave 17, 17-P; RM31 (a)). A site that allows no
 * direct route to the internet names its proxy once, in `.env.local`, by the names every HTTP
 * client already reads. The compose file hands them to each service that reaches out; this module
 * is what the processes started on this machine (the app under `pnpm start`, the setup's children,
 * the checks and their probes) are given, since Node reads a proxy from its environment only when
 * `NODE_USE_ENV_PROXY=1` is set before it starts, and Next reads `.env.local` after.
 *
 * `.env.local` is read alone (wave 18, D-9 (a)): a proxy the shell names and the file does not
 * reaches no process Day0 starts, no compose service and not the deployment, and `check:setup`
 * says the shell named one. Until 0.22.0 the shell's names won here and the sync's did not, so
 * the deployment lost its NO_PROXY while the backend took the shell's proxy (W17-R25).
 */

/** The names the way out is given by: the three every client reads, and Node's own switch. */
export const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
] as const;

/**
 * Every name a client on this machine reads a proxy from, in both the cases it is written: curl
 * and git read the lower-case ones, and `ALL_PROXY` too. None of them is taken from the shell.
 */
export const SHELL_PROXY_NAMES = [
  ...PROXY_VARIABLES,
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'all_proxy',
] as const;

/** The names of these that name a proxy, rather than what is kept out of one or Node's switch. */
const SHELL_PROXY_ADDRESSES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

/**
 * Set on every process Day0 starts where the shell named a proxy `.env.local` does not: the
 * names, never the value, so `check:setup` can say so wherever in the chain it runs.
 */
export const SHELL_PROXY_MARK = 'DAY0_SHELL_PROXY';

/**
 * What quiets Node's `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental`, which every
 * process started with its proxy switch on printed (W17-R28). Given wherever the switch is.
 */
export const QUIET_PROXY_WARNING = '--disable-warning=UNDICI-EHPA';

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

/** An environment's values, the unset ones left out. */
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The shell's names that name a proxy the file does not (empty, or another), in the shell's
 * spelling. A name the file has no upper-case twin for (`ALL_PROXY`) is one the file never names.
 *
 * @param shell - The environment a command was started with.
 * @param file - The env file's values.
 */
export function shellOnlyProxy(shell: Environment, file: Environment): string[] {
  return SHELL_PROXY_ADDRESSES.filter((name) => {
    const given = (shell[name] ?? '').trim();
    return given !== '' && given !== (file[name.toUpperCase()] ?? '').trim();
  });
}

/**
 * `check:setup`'s and the setup's note where the shell names a proxy the file does not, read
 * from the shell or from the mark a parent left once it had set the shell's names aside; undefined
 * where it names none (wave 18, section 7's draft).
 *
 * @param shell - The environment the command runs with.
 * @param file - The env file's values.
 */
export function shellProxyNote(shell: Environment, file: Environment): string | undefined {
  const direct = shellOnlyProxy(shell, file);
  const names =
    direct.length > 0
      ? direct
      : (shell[SHELL_PROXY_MARK] ?? '').split(',').filter((name) => name.trim() !== '');
  if (names.length === 0) return undefined;
  const listed =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const settings = proxySettings((name) => file[name]);
  const address = settings.httpsProxy ?? settings.httpProxy;
  const way =
    address === undefined ? 'directly' : `through the proxy at ${proxyForDisplay(address)}`;
  return (
    `The shell names a proxy (${listed}) that .env.local does not. Day0 reads .env.local only, ` +
    `so it goes out ${way}: name the proxy in .env.local, or unset it in the shell.`
  );
}

/**
 * The shell with none of its proxy names, and the mark naming those the file does not: what
 * every process Day0 starts is given before the file's own way out is added.
 */
function withoutShellProxy(shell: Environment, file: Environment): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(shell)) {
    if (value === undefined || name === SHELL_PROXY_MARK) continue;
    if ((SHELL_PROXY_NAMES as readonly string[]).includes(name)) continue;
    kept[name] = value;
  }
  const unread = shellOnlyProxy(shell, file);
  const mark = unread.length > 0 ? unread.join(',') : shell[SHELL_PROXY_MARK];
  return mark === undefined || mark === '' ? kept : { ...kept, [SHELL_PROXY_MARK]: mark };
}

/**
 * What a Node process Day0 starts on this machine runs with (D-9 (a)): the shell's environment
 * without its proxy names, then the way out `.env.local` names, with this machine's own names
 * kept out of it, Node's switch and the flag that quiets the switch's warning. So the setup's
 * children, a check run by hand and `pnpm start` take the proxy from the one place it is written.
 *
 * @param shell - The environment the command was started with.
 * @param file - The env file's values.
 */
export function processEnvironment(shell: Environment, file: Environment): Record<string, string> {
  const environment = withoutShellProxy(shell, file);
  const proxy = hostProxyEnvironment(proxySettings((name) => file[name]));
  if (Object.keys(proxy).length === 0) return environment;
  const options = (environment.NODE_OPTIONS ?? '').trim();
  return {
    ...environment,
    ...proxy,
    NODE_OPTIONS: options.split(/\s+/).includes(QUIET_PROXY_WARNING)
      ? options
      : `${options} ${QUIET_PROXY_WARNING}`.trim(),
  };
}

/**
 * What `docker compose` runs with (P-1 (a)): the shell without its proxy names, then the file's
 * own as written, an explicit map. Compose prefers the process environment to `--env-file` when
 * it fills `${HTTPS_PROXY}` in, so a shell's proxy would otherwise reach every service.
 *
 * @param shell - The environment the command was started with.
 * @param file - The env file's values.
 */
export function composeEnvironment(shell: Environment, file: Environment): Record<string, string> {
  const environment = withoutShellProxy(shell, file);
  for (const name of PROXY_VARIABLES) {
    const value = (file[name] ?? '').trim();
    if (value !== '') environment[name] = value;
  }
  return environment;
}

/**
 * What a command on this machine must be started again with so that it, and every child it
 * starts, takes the way out the install names and nothing the shell names: undefined when it
 * already holds that.
 *
 * A check run by hand starts in a shell that names no proxy while `.env.local` does. Its own
 * requests would then dial out directly, and its Convex CLI children, handed the file's values as
 * written, would send their calls to this machine's backend to the proxy (found on the bed
 * `day0-w17p`, 13 October 2026: nine refused, and two findings that were not so). A shell that
 * names a proxy the file does not is started again without it (D-9 (a)). Started by the setup,
 * or once restarted, it holds exactly this and runs as it is.
 *
 * @param shell - The environment the command was started with.
 * @param file - The env file's values.
 * @returns The whole environment to start again with.
 */
export function restartEnvironment(
  shell: Environment,
  file: Environment,
): Record<string, string> | undefined {
  const wanted = processEnvironment(shell, file);
  const names = new Set([
    ...SHELL_PROXY_NAMES,
    SHELL_PROXY_MARK,
    'NODE_OPTIONS',
    ...Object.keys(wanted),
  ]);
  return [...names].some((name) => (shell[name] ?? undefined) !== wanted[name])
    ? wanted
    : undefined;
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

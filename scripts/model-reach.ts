/**
 * Whether the backend container can reach the model address it will call.
 *
 * The Day-1 chat streams from Next on the host and the charter is synthesised
 * by a Convex Node action inside the backend container, so an address the
 * host reaches and the container does not gives a 1:1 that works and a
 * charter that never arrives: the bed's own stop (pass 11, section 3b), an
 * endpoint on another Docker bridge. The setup refuses such an `--endpoint`
 * and `pnpm check:setup` reports it, both by dialling from inside the
 * container. The dial asks for the models list with no key, so nothing is
 * spent: any HTTP answer, a 401 included, means the address answers.
 */

/** How long the container waits for the model address, in seconds. */
const DIAL_SECONDS = 10;

/** What the dial found. */
export type ModelReach = 'reached' | 'unreachable' | 'unknown';

/** A dial's answer: what it found and the words that say so. */
export interface ModelDial {
  reach: ModelReach;
  detail: string;
}

/**
 * The `docker compose` arguments, after the project and env file, that dial an
 * OpenAI-compatible base URL's models list from the backend container. The
 * pinned backend image carries curl for its own healthcheck.
 *
 * Args:
 *   baseUrl: The address the backend calls (`CONVEX_OPENAI_BASE_URL`).
 *
 * Returns:
 *   Arguments for `docker compose`.
 */
export function containerDialArguments(baseUrl: string): string[] {
  return containerReachArguments(`${baseUrl.trim().replace(/\/+$/, '')}/models`);
}

/**
 * The `docker compose` arguments, after the project and env file, that ask one address from the
 * backend container with a GET and no credential, printing only the HTTP status (`000` when
 * nothing answered, with curl's reason on stderr). `check:access` asks each vendor's address
 * this way, so a pass says the deployment itself reaches it.
 *
 * @param address - The address to ask.
 */
export function containerReachArguments(address: string): string[] {
  return [
    'exec',
    '-T',
    'backend',
    'curl',
    '-sS',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    String(DIAL_SECONDS),
    address,
  ];
}

/** The first non-blank line of a tool's output, trimmed. */
export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line: string): string => line.trim())
      .find((line: string): boolean => line !== '') ?? ''
  );
}

/**
 * Read what the dial printed. curl prints a three-digit status whether or not
 * anything answered (`000` when nothing did), so output without one means the
 * container never ran it: a stopped backend, or Docker itself refusing.
 *
 * Args:
 *   result: The `docker compose exec` exit status and both streams.
 *
 * Returns:
 *   Reached with the HTTP status, unreachable with curl's reason, or unknown.
 */
export function readContainerDial(result: {
  status: number | null;
  stdout: string;
  stderr: string;
}): ModelDial {
  const code = result.stdout.trim();
  if (!/^\d{3}$/.test(code)) {
    return { reach: 'unknown', detail: firstLine(result.stderr) || 'the dial did not run' };
  }
  if (code === '000') {
    return { reach: 'unreachable', detail: firstLine(result.stderr) || 'nothing answered' };
  }
  return { reach: 'reached', detail: `HTTP ${code}` };
}

/**
 * What to do about an address the container cannot reach, by the kind of
 * address it is: a bare name is another container's, which must join this
 * project's network; a private or host address is published on the host,
 * which the container reaches as `host.docker.internal`; anything else is
 * outbound, which a proxy or firewall is usually stopping.
 *
 * Args:
 *   baseUrl: The unreachable address.
 *   project: The Compose project, whose network is `<project>_default`.
 *
 * Returns:
 *   The fix, one line each.
 */
export function unreachableFix(baseUrl: string, project: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return [
      `${baseUrl} is not a URL. Set CONVEX_OPENAI_BASE_URL to the address the backend calls.`,
    ];
  }
  const port = parsed.port === '' ? '' : `:${parsed.port}`;
  const path = parsed.pathname.replace(/\/+$/, '');
  const onHost = `${parsed.protocol}//host.docker.internal${port}${path}`;
  if (!parsed.hostname.includes('.') && !parsed.hostname.includes(':')) {
    return [
      `${parsed.hostname} is a container name, and the backend is on the ${project}_default network.`,
      `Attach that container to it (\`docker network connect ${project}_default <its container>\`),`,
      `or publish its port on this host and use ${onHost}.`,
    ];
  }
  if (/^(10|127|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(parsed.hostname)) {
    return [
      `${parsed.hostname} is a private address the backend container cannot route to; a server`,
      `on this machine is ${onHost} from inside it. Set CONVEX_OPENAI_BASE_URL to that,`,
      "or attach the server's container to this project's network and use its name.",
    ];
  }
  return [
    `The backend container has no route to ${parsed.host}. A proxy or firewall on this`,
    "machine or network is the usual reason; containers do not inherit the host's proxy settings.",
  ];
}

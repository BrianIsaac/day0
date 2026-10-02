import { isSlackApiEndpoint } from './slack-endpoint';

/*
 * The access request (the access plan, section 4.5; A24) and the rule it starts from: which of
 * the organisation's systems a card needs. Pure, so the card, the manager's DM and the export
 * build the same words from the same row, and so the deployment's guards (the pasted-key refusal,
 * the connection's system key) read a card's system one way.
 */

/** A plain system key: lower-case words joined by hyphens (`slack`, `google-workspace`). */
const PLAIN_SYSTEM_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The prefix of an MCP server's system key, followed by the server's host. */
const MCP_SYSTEM_PREFIX = 'mcp:';

/** One DNS host name, lower-case: what follows the MCP prefix. */
const HOST_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Whether a value is an organisation system key: a plain lower-case key (`slack`, `linear`,
 * `github`, ...) or `mcp:<host>` for a generic MCP server (the access plan, section 4.1).
 *
 * @param value - The key as given.
 */
export function isOrganisationSystemKey(value: string): boolean {
  if (value.startsWith(MCP_SYSTEM_PREFIX)) {
    return HOST_NAME.test(value.slice(MCP_SYSTEM_PREFIX.length));
  }
  return PLAIN_SYSTEM_KEY.test(value);
}

/**
 * The systems the access kit knows by an API host, each with the hosts that name it: the host
 * itself or any subdomain of it. Slack is read off its Web API base (`isSlackApiEndpoint`),
 * never off a host alone, as everywhere else Slack is recognised.
 */
const SYSTEM_HOSTS: ReadonlyArray<{ readonly system: string; readonly hosts: readonly string[] }> =
  [
    { system: 'linear', hosts: ['linear.app'] },
    { system: 'github', hosts: ['github.com'] },
    { system: 'atlassian', hosts: ['atlassian.net', 'atlassian.com'] },
    { system: 'notion', hosts: ['notion.com'] },
    { system: 'microsoft', hosts: ['graph.microsoft.com'] },
    { system: 'google', hosts: ['googleapis.com'] },
  ];

/** The parts of a card the system rule reads. */
export interface SystemCard {
  readonly endpoint?: string;
  readonly path?: string;
}

/** Whether a host is a domain or one of its subdomains. */
function hostWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The organisation system a card needs, read off its endpoint: Slack's Web API base, a host the
 * access kit knows, and on the MCP rung any other server by its host. A card with no endpoint, or
 * one on a host nobody registers for the organisation, needs no organisation system, and keeps
 * the paths it has today.
 *
 * @param card - The card's endpoint and rung.
 * @returns The system key, or undefined when the card needs none.
 */
export function organisationSystemOf(card: SystemCard): string | undefined {
  if (card.endpoint === undefined) return undefined;
  if (isSlackApiEndpoint(card.endpoint)) return 'slack';
  let url: URL;
  try {
    url = new URL(card.endpoint);
  } catch {
    // Not an address: a card orientation could not place names no system.
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase();
  const known = SYSTEM_HOSTS.find((entry) =>
    entry.hosts.some((domain: string): boolean => hostWithin(host, domain)),
  );
  if (known !== undefined) return known.system;
  if (card.path === 'mcp' && HOST_NAME.test(host)) return `${MCP_SYSTEM_PREFIX}${host}`;
  return undefined;
}

/**
 * Why a card refuses a pasted credential: its system has an active organisation connection, so
 * the card's credential comes from that connection, never from a paste (the access plan,
 * section 4.1). Says nothing of the value.
 *
 * @param displayName - The system's name as the connection shows it.
 */
export function organisationConnectedRefusal(displayName: string): string {
  return `${displayName} is connected for your organisation by IT, so this card connects through that connection, never a pasted key. Nothing was stored.`;
}

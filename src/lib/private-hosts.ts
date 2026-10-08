import { isIP } from 'node:net';
import { isDiallablePrivateAddress, isNonPublicAddress } from './network-addresses';

/**
 * The operator's list of hosts inside their own network that day0 may reach.
 *
 * Every remote address a caller can name (an MCP server, a git repository) is
 * held to the public internet by default, because a deployment that fetches
 * whatever a page or a person names would otherwise be a way into the network
 * it runs in. A customer-local deployment runs inside that network on purpose,
 * and its systems are there too, so the operator names the ones day0 may reach
 * in `DAY0_PRIVATE_HOSTS`: host names, IP addresses, or `.suffix` for every
 * host under a domain. Nothing is admitted by pattern beyond that.
 */

/** The environment name the allowlist is read from. */
export const PRIVATE_HOSTS_VAR = 'DAY0_PRIVATE_HOSTS';

/** Parsed allowlist: exact names and addresses, and dot-led suffixes. */
export interface PrivateHostAllowlist {
  readonly names: readonly string[];
  readonly suffixes: readonly string[];
}

/** A host name or address the way two spellings of one host compare. */
function hostKey(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

const HOST_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Parse a host list in the private list's grammar, naming the variable it came from.
 *
 * @param variable - The environment name a refusal names.
 * @param value - The variable's value: entries separated by commas or whitespace.
 * @throws Error naming the variable when an entry is not a host name, an IP address or a
 *   `.suffix`, or names loopback, link-local, multicast, an unspecified address or `localhost`.
 */
function hostList(variable: string, value: string | undefined): PrivateHostAllowlist {
  const names: string[] = [];
  const suffixes: string[] = [];
  for (const entry of (value ?? '').split(/[\s,]+/).filter(Boolean)) {
    const key = hostKey(entry);
    const suffix = key.startsWith('.') ? key.slice(1) : undefined;
    if (
      (isIP(key) !== 0 && !isDiallablePrivateAddress(key)) ||
      key === 'localhost' ||
      key.endsWith('.localhost')
    ) {
      throw new Error(
        `${variable} lists "${entry}", which is this machine or an address day0 never ` +
          'dials (loopback, link-local, multicast or unspecified), listed or not.',
      );
    }
    // A suffix whose last label is a number would match IP literals by pattern.
    if (suffix !== undefined && HOST_NAME.test(suffix) && !/(?:^|\.)\d+$/.test(suffix)) {
      suffixes.push(`.${suffix}`);
    } else if (suffix === undefined && (isIP(key) !== 0 || HOST_NAME.test(key))) {
      names.push(key);
    } else {
      throw new Error(
        `${variable} entries are host names, IP addresses or .suffix forms, ` +
          `separated by commas or spaces; "${entry}" is none of those.`,
      );
    }
  }
  return { names, suffixes };
}

/**
 * Parse the allowlist.
 *
 * @param value - The variable's value: entries separated by commas or whitespace.
 * @returns The names and suffixes, lower-cased, without a trailing dot or IPv6 brackets.
 * @throws Error naming the variable when an entry is not a host name, an IP address or a
 *   `.suffix`, or names loopback, link-local, multicast, an unspecified address or `localhost`.
 */
export function privateHostAllowlist(value: string | undefined): PrivateHostAllowlist {
  return hostList(PRIVATE_HOSTS_VAR, value);
}

/**
 * Whether the operator listed this host.
 *
 * A `.suffix` entry admits every host under it and not the bare domain, so
 * `.corp.internal` admits `mcp.corp.internal` and not `corp.internal`.
 *
 * @param hostname - A URL's hostname, brackets and trailing dot allowed.
 * @param allowlist - The parsed allowlist.
 */
export function isPrivateHostAllowed(hostname: string, allowlist: PrivateHostAllowlist): boolean {
  return isListed(hostname, allowlist);
}

/** Whether a host is a name in a list or under one of its suffixes. */
function isListed(hostname: string, list: PrivateHostAllowlist): boolean {
  const key = hostKey(hostname);
  return list.names.includes(key) || list.suffixes.some((suffix) => key.endsWith(suffix));
}

/** The allowlist this process's environment configures. */
export function configuredPrivateHosts(): PrivateHostAllowlist {
  return privateHostAllowlist(process.env[PRIVATE_HOSTS_VAR]);
}

/**
 * The operator's list of git hosts day0 may clone from beyond GitHub and GitLab.
 *
 * A public code host such as Gitee or JiHu, or the customer's own, is not a
 * host inside the operator's network, so it does not belong in
 * `DAY0_PRIVATE_HOSTS`, where listing it would let every reader that honours
 * that list (an MCP server's, a git repository's) treat it as private. This
 * list is read by the git reader alone: a listed host is cloned on the clone
 * path, resolved once and pinned to its checked address as a private host is,
 * and is never a private host anywhere else. Its grammar is the private list's.
 */
export const GIT_HOSTS_VAR = 'DAY0_GIT_HOSTS';

/**
 * Parse the git hosts list.
 *
 * @param value - The variable's value: entries separated by commas or whitespace.
 * @returns The names and suffixes, as the private list's parser returns them.
 * @throws Error naming `DAY0_GIT_HOSTS` for an entry the private list would refuse, or an IP
 *   address that is not public, which is a private host and listed as one.
 */
export function gitHostAllowlist(value: string | undefined): PrivateHostAllowlist {
  const list = hostList(GIT_HOSTS_VAR, value);
  const inside = list.names.find((name) => isIP(name) !== 0 && isNonPublicAddress(name));
  if (inside !== undefined) {
    throw new Error(
      `${GIT_HOSTS_VAR} lists "${inside}", an address that is not public: list a host inside ` +
        `your network in ${PRIVATE_HOSTS_VAR} instead.`,
    );
  }
  return list;
}

/**
 * Whether the operator listed this host as a git host.
 *
 * @param hostname - A URL's hostname, brackets and trailing dot allowed.
 * @param list - The parsed git hosts list.
 */
export function isGitHostListed(hostname: string, list: PrivateHostAllowlist): boolean {
  return isListed(hostname, list);
}

/** The git hosts list this process's environment configures. */
export function configuredGitHosts(): PrivateHostAllowlist {
  return gitHostAllowlist(process.env[GIT_HOSTS_VAR]);
}

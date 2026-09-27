import { isIP } from 'node:net';
import { isDiallablePrivateAddress } from './network-addresses';

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
 * Parse the allowlist.
 *
 * @param value - The variable's value: entries separated by commas or whitespace.
 * @returns The names and suffixes, lower-cased, without a trailing dot or IPv6 brackets.
 * @throws Error naming the variable when an entry is not a host name, an IP address or a
 *   `.suffix`, or names loopback, link-local, multicast, an unspecified address or `localhost`.
 */
export function privateHostAllowlist(value: string | undefined): PrivateHostAllowlist {
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
        `${PRIVATE_HOSTS_VAR} lists "${entry}", which is this machine or an address day0 never ` +
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
        `${PRIVATE_HOSTS_VAR} entries are host names, IP addresses or .suffix forms, ` +
          `separated by commas or spaces; "${entry}" is none of those.`,
      );
    }
  }
  return { names, suffixes };
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
  const key = hostKey(hostname);
  return allowlist.names.includes(key) || allowlist.suffixes.some((suffix) => key.endsWith(suffix));
}

/** The allowlist this process's environment configures. */
export function configuredPrivateHosts(): PrivateHostAllowlist {
  return privateHostAllowlist(process.env[PRIVATE_HOSTS_VAR]);
}

import { isIP } from 'node:net';
import { isDiallablePrivateAddress } from '../lib/network-addresses';
import {
  configuredPrivateHosts,
  isPrivateHostAllowed,
  PRIVATE_HOSTS_VAR,
  type PrivateHostAllowlist,
} from '../lib/private-hosts';

/**
 * Which web UIs the browser rung opens.
 *
 * The browser rung signs in to a documented web UI with a stored login, so a page reached over
 * plain http hands that login to every hop between the driver and the server. Over https any host
 * is opened; over plain http only a host the operator listed in `DAY0_PRIVATE_HOSTS`, as a server
 * inside their own network, the rule the MCP rung already holds a private host to (M20, R9 of the
 * wave 3.5 review). Orientation applies it before it proposes a web UI and the probe again before
 * it opens one, and the executor before every browser action (W14-R31), so a card approved
 * before the rule, or a list changed since, is held to it too. Over either scheme it opens no
 * address that is this machine's own or one Day0 never dials (W14-R34): `localhost`, loopback,
 * link-local (where a cloud's metadata lives), multicast, unspecified.
 */

/** Whether a host is this machine's own name or an address literal Day0 never dials. */
function isNeverOpenedHost(hostname: string): boolean {
  // Without the root's trailing dot: `localhost.` is `localhost`.
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && !isDiallablePrivateAddress(host);
}

/**
 * Why the browser rung does not open a web UI, or `undefined` when it does.
 *
 * @param url - The documented web UI address.
 * @param privateHosts - The operator's private-host list; the environment's when omitted. A list
 *   the environment cannot parse admits no plaintext page, and the refusal says why.
 * @returns The refusal, worded for the card, or `undefined` for an address the rung opens.
 */
export function webUiAddressRefusal(
  url: string,
  privateHosts?: PrivateHostAllowlist,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL: the rung has nothing it could open.
    return `The web UI ${url} is not a valid address, so Day0 does not open it.`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `The web UI ${url} is not an http or https address, so Day0 does not open it.`;
  }
  // Said before the list's advice: the list refuses these hosts, so listing one would break every
  // private-host check (W14-R32).
  if (isNeverOpenedHost(parsed.hostname)) {
    return `The web UI ${url} is at this machine\u2019s own address or one Day0 never opens (loopback, link-local, multicast or unspecified), which ${PRIVATE_HOSTS_VAR} cannot list. Document the address the web UI has on your network, by its host name or IP.`;
  }
  if (parsed.protocol === 'https:') return undefined;
  let listed: PrivateHostAllowlist;
  try {
    listed = privateHosts ?? configuredPrivateHosts();
  } catch (error) {
    return `The web UI ${url} is plain http, and ${PRIVATE_HOSTS_VAR} cannot be read, so no plain http page is opened: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (isPrivateHostAllowed(parsed.hostname, listed)) return undefined;
  // What to do first: the card's reason is cut at 300 characters (W14-R32).
  return `Document the https address of the web UI ${url}, or list its host in ${PRIVATE_HOSTS_VAR} if it is inside this network: it is plain http on a host ${PRIVATE_HOSTS_VAR} does not list, so Day0 does not open it (a sign-in there would cross the network unencrypted).`;
}

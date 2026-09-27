import { BlockList, isIP } from 'node:net';

/**
 * Which addresses day0 dials for a name a caller supplied (an MCP server, a
 * git repository).
 *
 * A name that is not listed in `DAY0_PRIVATE_HOSTS` must answer with public
 * addresses only; a listed one may answer with a private address too, never
 * with one that reaches this machine or the cloud's metadata service. The
 * callers resolve a name once, check every answer here, and dial only what
 * they checked.
 */

const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

/**
 * The one IPv6 range that is globally routable unicast.
 *
 * A denylist of IPv6 ranges cannot be finished: loopback, link-local and
 * unique-local were listed, but `fec0::1` (site-local), `::7f00:1`
 * (IPv4-compatible) and `64:ff9b::7f00:1` (NAT64) were not, and
 * `2002:7f00:1::1` reaches 127.0.0.1 through a 6to4 relay. An address is
 * admitted only if it is inside global unicast and outside the transition and
 * documentation ranges carved out of it above.
 */
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

/** Addresses a listed private host may still never resolve to. */
const NEVER_DIALLED_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NEVER_DIALLED_V4.addSubnet(network, prefix, 'ipv4');
}

/** IPv6 unique-local addresses, the private range a listed host may answer with. */
const UNIQUE_LOCAL_V6 = new BlockList();
UNIQUE_LOCAL_V6.addSubnet('fc00::', 7, 'ipv6');

/** Whether one resolved address is outside every public range. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NON_PUBLIC_ADDRESSES.check(address, 'ipv4');
  if (family === 6) {
    return !GLOBAL_UNICAST_V6.check(address, 'ipv6') || NON_PUBLIC_ADDRESSES.check(address, 'ipv6');
  }
  return true;
}

/**
 * Whether a host the operator listed in `DAY0_PRIVATE_HOSTS` may answer with
 * this address: private or public, never loopback, link-local (where cloud
 * metadata lives), multicast or unspecified.
 */
export function isDiallablePrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NEVER_DIALLED_V4.check(address, 'ipv4');
  if (family === 6) return UNIQUE_LOCAL_V6.check(address, 'ipv6') || !isNonPublicAddress(address);
  return false;
}

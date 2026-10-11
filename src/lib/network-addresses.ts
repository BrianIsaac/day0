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

/** NAT64's well-known prefix (RFC 6052): an IPv4 address carried in the last 32 bits. */
const NAT64_PREFIX = new BlockList();
NAT64_PREFIX.addSubnet('64:ff9b::', 96, 'ipv6');

/** The range a fake-IP proxy answers every name from (RFC 2544's benchmarking range). */
const FAKE_IP_RANGE = new BlockList();
FAKE_IP_RANGE.addSubnet('198.18.0.0', 15, 'ipv4');

/** The 16-bit groups of an IPv6 address, `::` and a dotted tail expanded. */
function ipv6Groups(address: string): number[] {
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text =
    dotted === null
      ? address
      : `${dotted[1]}${((Number(dotted[2]) << 8) | Number(dotted[3])).toString(16)}:${((Number(dotted[4]) << 8) | Number(dotted[5])).toString(16)}`;
  const [head = '', tail] = text.split('::');
  const groups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * The IPv4 address a NAT64 address carries (`64:ff9b::808:808` is 8.8.8.8), or nothing for any
 * other address. An IPv6-only network answers every IPv4 host this way, so the address is as
 * public, or as private, as the one it carries (W14-R43).
 */
function nat64Embedded(address: string): string | undefined {
  if (isIP(address) !== 6 || !NAT64_PREFIX.check(address, 'ipv6')) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Whether one resolved address is outside every public range. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return NON_PUBLIC_ADDRESSES.check(address, 'ipv4');
  if (family === 6) {
    const embedded = nat64Embedded(address);
    if (embedded !== undefined) return isNonPublicAddress(embedded);
    return !GLOBAL_UNICAST_V6.check(address, 'ipv6') || NON_PUBLIC_ADDRESSES.check(address, 'ipv6');
  }
  return true;
}

/**
 * Whether an address is one a fake-IP proxy hands out (198.18.0.0/15): such a proxy answers every
 * name, public or not, from this range and maps it back itself, so the address says nothing of
 * what it reaches. It stays non-public; a refusal names it so the operator knows the cause
 * (W14-R43).
 */
export function isFakeIpAddress(address: string): boolean {
  return isIP(address) === 4 && FAKE_IP_RANGE.check(address, 'ipv4');
}

/**
 * Whether a host the operator listed in `DAY0_PRIVATE_HOSTS` may answer with
 * this address: private or public, never loopback, link-local (where cloud
 * metadata lives), multicast or unspecified.
 */
export function isDiallablePrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NEVER_DIALLED_V4.check(address, 'ipv4');
  if (family === 6) {
    const embedded = nat64Embedded(address);
    if (embedded !== undefined) return isDiallablePrivateAddress(embedded);
    return UNIQUE_LOCAL_V6.check(address, 'ipv6') || !isNonPublicAddress(address);
  }
  return false;
}

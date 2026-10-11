import { describe, expect, it } from 'vitest';
import {
  isDiallablePrivateAddress,
  isFakeIpAddress,
  isNonPublicAddress,
} from '../../../src/lib/network-addresses';

describe('network addresses', (): void => {
  it('counts only global unicast outside the reserved ranges as public', (): void => {
    expect(isNonPublicAddress('93.184.216.34')).toBe(false);
    expect(isNonPublicAddress('2606:4700::1111')).toBe(false);
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      'fd00::1',
      '::1',
      '2002:7f00:1::1',
    ]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
    expect(isNonPublicAddress('not-an-address')).toBe(true);
  });

  it('reads a NAT64 address by the IPv4 address it carries, public or not (W14-R43)', (): void => {
    // 64:ff9b::/96 is how an IPv6-only network reaches IPv4: the last 32 bits are the address.
    expect(isNonPublicAddress('64:ff9b::808:808')).toBe(false);
    expect(isNonPublicAddress('64:ff9b::5db8:d822')).toBe(false);
    expect(isDiallablePrivateAddress('64:ff9b::808:808')).toBe(true);
    for (const address of ['64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1']) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
    // A listed host may answer a private address through the gateway, never loopback or metadata.
    expect(isDiallablePrivateAddress('64:ff9b::a00:1')).toBe(true);
    expect(isDiallablePrivateAddress('64:ff9b::7f00:1')).toBe(false);
    expect(isDiallablePrivateAddress('64:ff9b::a9fe:a9fe')).toBe(false);
    // Outside the well-known prefix nothing changes.
    expect(isNonPublicAddress('64:ff9c::808:808')).toBe(true);
  });

  it('knows the range a fake-IP proxy answers from, which stays non-public (W14-R43)', (): void => {
    expect(isFakeIpAddress('198.18.0.5')).toBe(true);
    expect(isFakeIpAddress('198.19.255.254')).toBe(true);
    expect(isFakeIpAddress('198.20.0.1')).toBe(false);
    expect(isFakeIpAddress('93.184.216.34')).toBe(false);
    expect(isNonPublicAddress('198.18.0.5')).toBe(true);
  });

  it('lets a listed host answer with a private or public address, never loopback, link-local or unspecified', (): void => {
    for (const address of ['10.0.0.1', '192.168.1.5', 'fd12::5', '93.184.216.34']) {
      expect(isDiallablePrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '224.0.0.1',
    ]) {
      expect(isDiallablePrivateAddress(address), address).toBe(false);
    }
  });
});

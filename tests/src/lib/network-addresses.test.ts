import { describe, expect, it } from 'vitest';
import { isDiallablePrivateAddress, isNonPublicAddress } from '../../../src/lib/network-addresses';

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

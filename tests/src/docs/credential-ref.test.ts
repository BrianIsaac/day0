import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  credentialPageRef,
  credentialRefRange,
  credentialSourceRef,
  isValueKeyedRef,
} from '../../../src/docs/credential-ref';
import { credentialValueFingerprint } from '../../../src/lib/credential-crypto';

describe('credential source refs', (): void => {
  it('keys a credential source ref by the page and the value fingerprint, for one value or several', (): void => {
    const fingerprint = '0123456789abcdef0123456789abcdef';
    expect(credentialSourceRef('page', fingerprint)).toBe(`page#credential=${fingerprint}`);
    expect(credentialSourceRef('guides/page.md#intro', fingerprint)).toBe(
      `guides/page.md#intro#credential=${fingerprint}`,
    );
  });

  it('refuses to key a ref by anything but a value fingerprint, so no position or label can reach one', (): void => {
    for (const notAFingerprint of [
      '1-linear%20service%20token',
      '',
      '0123456789ABCDEF0123456789ABCDEF',
      '0123456789abcdef',
    ]) {
      expect(() => credentialSourceRef('page', notAFingerprint)).toThrow(
        'A credential source ref is keyed by a value fingerprint.',
      );
    }
  });

  it('tells a value-keyed ref from the page-only and position-and-label refs stored before it', (): void => {
    const fingerprint = 'fedcba9876543210fedcba9876543210';
    expect(isValueKeyedRef(credentialSourceRef('page', fingerprint))).toBe(true);
    expect(isValueKeyedRef('page')).toBe(false);
    expect(isValueKeyedRef('page#credential=1-linear%20service%20token')).toBe(false);
    // A label of 30 hex-looking characters still carries its position's dash.
    expect(isValueKeyedRef('page#credential=2-abcdef0123456789abcdef01234567')).toBe(false);
  });

  it('takes the fingerprint the deployment key gives a value', (): void => {
    const key = randomBytes(32).toString('base64');
    const ref = credentialSourceRef('page', credentialValueFingerprint('value', key, 'owner'));
    expect(isValueKeyedRef(ref)).toBe(true);
    expect(credentialPageRef(ref)).toBe('page');
  });

  it('reads the page back from a value-keyed ref and from both earlier shapes, and bounds those extending the page ref for an index range (D8)', (): void => {
    const pageRef = 'guides/page.md#intro';
    const { from, to } = credentialRefRange(pageRef);
    for (const ref of [
      credentialSourceRef(pageRef, '0123456789abcdef0123456789abcdef'),
      credentialSourceRef(pageRef, 'ffffffffffffffffffffffffffffffff'),
      `${pageRef}#credential=3-linear%20service%20token`,
    ]) {
      expect(credentialPageRef(ref)).toBe(pageRef);
      expect(ref >= from && ref <= to).toBe(true);
    }
    expect(credentialPageRef(pageRef)).toBe(pageRef);
    // Another page whose ref starts with this one sorts outside the range.
    for (const other of [pageRef, `${pageRef} copy`, `${pageRef} copy#credential=1-x`]) {
      expect(other >= from && other <= to).toBe(false);
    }
    expect(credentialPageRef('guides/page.md.bak')).toBe('guides/page.md.bak');
  });
});

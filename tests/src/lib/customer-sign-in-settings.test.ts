import { describe, expect, it } from 'vitest';
import {
  customerSignInGaps,
  publicOrigin,
  redirectUriOf,
  signedOutUriOf,
} from '../../../src/lib/customer-sign-in-settings';

const COMPLETE: Record<string, string> = {
  DAY0_OIDC_ISSUER: 'https://issuer.acme.test',
  DAY0_OIDC_AUDIENCE: 'day0-app',
  DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret',
  DAY0_OIDC_ALLOWED_DOMAINS: 'acme.test',
  DAY0_SESSION_SECRET: 's'.repeat(43),
  DAY0_PUBLIC_URL: 'https://day0.acme.test',
};

function reader(values: Record<string, string>): (name: string) => string | undefined {
  return (name: string): string | undefined => values[name];
}

describe('the public origin', (): void => {
  it('is an http(s) origin with nothing after it, a trailing slash dropped', (): void => {
    expect(publicOrigin(' https://day0.acme.test/ ')).toEqual({ origin: 'https://day0.acme.test' });
    expect(publicOrigin('http://localhost:3296')).toEqual({ origin: 'http://localhost:3296' });
  });

  it('is refused with a path, a query, credentials, another scheme, or nothing', (): void => {
    for (const value of [
      undefined,
      '',
      'day0.acme.test',
      'https://day0.acme.test/app',
      'https://day0.acme.test?x=1',
      'https://admin:pw@day0.acme.test',
      'ftp://day0.acme.test',
    ]) {
      expect(publicOrigin(value), String(value)).toHaveProperty('gap');
    }
  });

  it('gives the two addresses to register at the issuer', (): void => {
    expect(redirectUriOf('https://day0.acme.test')).toBe(
      'https://day0.acme.test/api/auth/oidc/callback',
    );
    expect(signedOutUriOf('https://day0.acme.test')).toBe(
      'https://day0.acme.test/api/auth/oidc/logout',
    );
  });
});

describe('what the sign-in still needs', (): void => {
  it('is nothing for a complete install', (): void => {
    expect(customerSignInGaps(reader(COMPLETE))).toEqual([]);
  });

  it('names each missing or malformed value, never the value itself', (): void => {
    const gaps = customerSignInGaps(
      reader({
        ...COMPLETE,
        DAY0_OIDC_CLIENT_SECRET: '',
        DAY0_OIDC_ALLOWED_DOMAINS: '@acme.test',
        DAY0_SESSION_SECRET: 'short',
        DAY0_PUBLIC_URL: '',
      }),
    ).join(' ');
    for (const name of [
      'DAY0_OIDC_CLIENT_SECRET',
      'DAY0_OIDC_ALLOWED_DOMAINS',
      'DAY0_SESSION_SECRET',
      'DAY0_PUBLIC_URL',
    ]) {
      expect(gaps).toContain(name);
    }
    expect(gaps).not.toContain('short');
    expect(customerSignInGaps(reader({ ...COMPLETE, DAY0_OIDC_ISSUER: '' })).join(' ')).toContain(
      'DAY0_OIDC_ISSUER is not set',
    );
  });
});

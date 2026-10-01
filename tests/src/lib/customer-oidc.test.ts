import { describe, expect, it } from 'vitest';
import * as customerOidc from '../../../src/lib/customer-oidc';
import {
  CUSTOMER_OIDC_EMAIL_TRUSTED_VAR,
  customerOidcEmailTrusted,
  customerOidcIssuer,
} from '../../../src/lib/customer-oidc';

/** An env reader over a plain record. */
function reader(values: Record<string, string>): (name: string) => string | undefined {
  return (name: string): string | undefined => values[name];
}

describe('the customer OIDC issuer', (): void => {
  it('is absent when no issuer is configured', (): void => {
    expect(customerOidcIssuer(reader({}))).toBeUndefined();
    expect(customerOidcIssuer(reader({ DAY0_OIDC_ISSUER: '  ' }))).toBeUndefined();
  });

  it('pairs the issuer with the audience its tokens carry', (): void => {
    expect(
      customerOidcIssuer(
        reader({
          DAY0_OIDC_ISSUER: ' https://sso.example.com/realms/ops ',
          DAY0_OIDC_AUDIENCE: 'day0',
        }),
      ),
    ).toEqual({ issuer: 'https://sso.example.com/realms/ops', audience: 'day0' });
  });

  it('refuses an issuer with no audience, since the deployment could not check whom a token is for', (): void => {
    expect(() =>
      customerOidcIssuer(reader({ DAY0_OIDC_ISSUER: 'https://sso.example.com' })),
    ).toThrow('DAY0_OIDC_AUDIENCE');
  });

  it('refuses an issuer that is not a plain https URL', (): void => {
    for (const issuer of [
      'http://sso.example.com',
      'sso.example.com',
      'https://admin:hunter2@sso.example.com',
      'https://sso.example.com/?tenant=1',
      'https://sso.example.com/#a',
    ]) {
      expect(() =>
        customerOidcIssuer(reader({ DAY0_OIDC_ISSUER: issuer, DAY0_OIDC_AUDIENCE: 'day0' })),
      ).toThrow('DAY0_OIDC_ISSUER');
    }
  });

  it('never repeats a refused issuer, which may carry a password', (): void => {
    expect(() =>
      customerOidcIssuer(
        reader({
          DAY0_OIDC_ISSUER: 'https://admin:hunter2@sso.example.com',
          DAY0_OIDC_AUDIENCE: 'x',
        }),
      ),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining('hunter2') }));
  });

  it('reads nothing a throwing reader refuses as configured', (): void => {
    const throwing = (): string | undefined => {
      throw new Error('AuthConfigMissingEnvironmentVariable');
    };
    expect(customerOidcIssuer(throwing)).toBeUndefined();
  });
});

describe("trusting the customer issuer's addresses (D3)", (): void => {
  it('is named DAY0_OIDC_EMAIL_TRUSTED', (): void => {
    expect(CUSTOMER_OIDC_EMAIL_TRUSTED_VAR).toBe('DAY0_OIDC_EMAIL_TRUSTED');
  });

  it('is on only when the flag says true, whatever its case and edges', (): void => {
    expect(customerOidcEmailTrusted(reader({ DAY0_OIDC_EMAIL_TRUSTED: 'true' }))).toBe(true);
    expect(customerOidcEmailTrusted(reader({ DAY0_OIDC_EMAIL_TRUSTED: ' TRUE ' }))).toBe(true);
  });

  it('is off by default, and for any other value, so a typo never widens whose address is believed', (): void => {
    for (const value of ['', 'false', 'yes', '1', 'on']) {
      expect(customerOidcEmailTrusted(reader({ DAY0_OIDC_EMAIL_TRUSTED: value })), value).toBe(
        false,
      );
    }
    expect(customerOidcEmailTrusted(reader({}))).toBe(false);
  });

  it('is off when the reader refuses the name, as the auth config does for an unset one', (): void => {
    const throwing = (): string | undefined => {
      throw new Error('AuthConfigMissingEnvironmentVariable');
    };
    expect(customerOidcEmailTrusted(throwing)).toBe(false);
  });
});

describe('the allowed domains', (): void => {
  it('reads a comma- or space-separated list, lower-cased and without repeats', (): void => {
    const { parseAllowedDomains } = customerOidc;
    expect(parseAllowedDomains(' Acme.com, acme.co.uk  ACME.com ')).toEqual([
      'acme.com',
      'acme.co.uk',
    ]);
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains('  ')).toEqual([]);
  });

  it('refuses an entry that is not a plain domain, naming it', (): void => {
    const { parseAllowedDomains } = customerOidc;
    for (const entry of ['@acme.com', 'https://acme.com', '*.acme.com', 'localhost', 'acme..com']) {
      expect(() => parseAllowedDomains(entry)).toThrow(/DAY0_OIDC_ALLOWED_DOMAINS/);
    }
  });
});

describe('the domain rule', (): void => {
  const { signInRefusal } = customerOidc;
  const okta = 'https://acme.okta.com';

  it('admits an address in an allowed domain, whatever the case of its domain', (): void => {
    expect(signInRefusal({ email: 'priya@ACME.com' }, ['acme.com'], okta)).toBeUndefined();
  });

  it('refuses an address in another domain, and a subdomain that is not listed', (): void => {
    expect(signInRefusal({ email: 'eve@rival.com' }, ['acme.com'], okta)).toBe('foreign-domain');
    expect(signInRefusal({ email: 'a@eu.acme.com' }, ['acme.com'], okta)).toBe('foreign-domain');
    expect(signInRefusal({ email: 'a@acme.com.evil.test' }, ['acme.com'], okta)).toBe(
      'foreign-domain',
    );
  });

  it('refuses a token with no address, and everyone when no domain is configured', (): void => {
    expect(signInRefusal({}, ['acme.com'], okta)).toBe('no-email');
    expect(signInRefusal({ email: 42 }, ['acme.com'], okta)).toBe('no-email');
    expect(signInRefusal({ email: 'priya@acme.com' }, [], okta)).toBe('no-domains');
  });

  it('refuses a Google account without the allowed Workspace in hd, whatever its address says', (): void => {
    const google = 'https://accounts.google.com';
    expect(signInRefusal({ email: 'priya@acme.com', hd: 'acme.com' }, ['acme.com'], google)).toBe(
      undefined,
    );
    expect(signInRefusal({ email: 'priya@acme.com' }, ['acme.com'], google)).toBe(
      'foreign-workspace',
    );
    expect(signInRefusal({ email: 'priya@acme.com', hd: 'rival.com' }, ['acme.com'], google)).toBe(
      'foreign-workspace',
    );
    expect(signInRefusal({ email: 'priya@acme.com', hd: 'rival.com' }, ['acme.com'], okta)).toBe(
      undefined,
    );
  });
});

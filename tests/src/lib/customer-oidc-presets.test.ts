import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_OIDC_PRESETS,
  entraIssuer,
  googleIssuer,
  oktaIssuer,
  providerOfIssuer,
} from '../../../src/lib/customer-oidc-presets';

const TENANT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('the provider presets', (): void => {
  it("forms Entra's issuer per tenant, and refuses common and the other aliases", (): void => {
    expect(entraIssuer(` ${TENANT.toUpperCase()} `)).toBe(
      `https://login.microsoftonline.com/${TENANT}/v2.0`,
    );
    for (const alias of ['common', 'organizations', 'Consumers']) {
      expect(() => entraIssuer(alias)).toThrow('every Microsoft tenant');
    }
    expect(() => entraIssuer('acme.onmicrosoft.com')).toThrow('GUID');
  });

  it("forms Okta's org server and a custom server's issuer", (): void => {
    expect(oktaIssuer('https://Acme.okta.com/')).toBe('https://acme.okta.com');
    expect(oktaIssuer('acme.okta.com', 'org')).toBe('https://acme.okta.com');
    expect(oktaIssuer('acme.okta.com', 'default')).toBe('https://acme.okta.com/oauth2/default');
    expect(() => oktaIssuer('acme', 'default')).toThrow('host name');
    expect(() => oktaIssuer('acme.okta.com', '../x')).toThrow('letters and digits');
  });

  it('reads the provider off the issuer', (): void => {
    expect(providerOfIssuer(googleIssuer())).toBe('google');
    expect(providerOfIssuer(entraIssuer(TENANT))).toBe('entra');
    expect(providerOfIssuer('https://acme.okta.com/oauth2/default')).toBe('okta');
    expect(providerOfIssuer('https://sso.acme.com', 'okta')).toBe('okta');
    expect(providerOfIssuer('https://sso.acme.com')).toBe('oidc');
  });

  it('asks every provider but Google for offline_access, and Google for its own parameters', (): void => {
    for (const provider of ['entra', 'okta', 'oidc'] as const) {
      expect(CUSTOMER_OIDC_PRESETS[provider].scopes).toContain('offline_access');
      expect(CUSTOMER_OIDC_PRESETS[provider].authorizationParameters).toEqual({});
    }
    expect(CUSTOMER_OIDC_PRESETS.google.scopes).not.toContain('offline_access');
    expect(CUSTOMER_OIDC_PRESETS.google.authorizationParameters).toEqual({
      access_type: 'offline',
      prompt: 'consent',
    });
    expect(CUSTOMER_OIDC_PRESETS.entra.verifiedAddressClaim).toBe('xms_edov');
  });
});

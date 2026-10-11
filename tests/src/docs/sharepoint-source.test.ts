import { describe, expect, it } from 'vitest';
import {
  parseSharePointLocator,
  parseSharePointSecret,
  sharePointLocator,
  sharePointReaderSecret,
} from '../../../src/docs/sharepoint-source';

describe('a SharePoint location', (): void => {
  it("is the site's own address, whatever page of the site the manager copied", (): void => {
    const stored = 'https://acme.sharepoint.com/sites/Runbooks';
    for (const typed of [
      ' https://acme.sharepoint.com/sites/Runbooks ',
      'https://ACME.sharepoint.com/sites/Runbooks/Shared%20Documents/Forms/AllItems.aspx?viewid=1',
      'https://acme.sharepoint.com/sites/Runbooks/SitePages/Home.aspx',
    ]) {
      expect(sharePointLocator(typed)).toBe(stored);
    }
    expect(parseSharePointLocator(stored)).toEqual({
      cloud: 'global',
      host: 'acme.sharepoint.com',
      path: '/sites/Runbooks',
    });
    expect(sharePointLocator('https://acme.sharepoint.com/teams/RevOps/Shared Documents')).toBe(
      'https://acme.sharepoint.com/teams/RevOps',
    );
  });

  it("names its cloud by its host: sharepoint.cn is the one 21Vianet operates, and a tenant's root site has no path", (): void => {
    expect(parseSharePointLocator('https://acme.sharepoint.cn/sites/Runbooks')).toEqual({
      cloud: 'china',
      host: 'acme.sharepoint.cn',
      path: '/sites/Runbooks',
    });
    expect(parseSharePointLocator(sharePointLocator('https://acme.sharepoint.com/'))).toEqual({
      cloud: 'global',
      host: 'acme.sharepoint.com',
      path: '',
    });
  });

  it('is refused on any other host, over http, or with anything beyond the site, without repeating it', (): void => {
    expect(sharePointLocator('https://example.com/sites/Runbooks')).toBe(
      'https://example.com/sites/Runbooks',
    );
    for (const locator of [
      'https://example.com/sites/Runbooks',
      'https://acme.sharepoint.com.evil.example/sites/Runbooks',
      'https://evil.example/acme.sharepoint.com/sites/Runbooks',
      'http://acme.sharepoint.com/sites/Runbooks',
      'https://acme.sharepoint.com/sites/Runbooks/Shared%20Documents',
      'https://acme.sharepoint.com/sites/Runbooks?web=1',
      'https://user:pass@acme.sharepoint.com/sites/Runbooks',
      'Runbooks',
    ]) {
      let message = '';
      try {
        parseSharePointLocator(locator);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, locator).toContain("A SharePoint location is a site's address");
      expect(message).not.toContain(locator);
    }
  });
});

describe('a SharePoint reader secret', (): void => {
  it('is the tenant ID, the client ID and the client secret joined by colons', (): void => {
    const app = {
      tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
      clientId: '6731de76-14a6-49ae-97bc-6eba6914391e',
      clientSecret: 'fixture~client.secret_value',
    };
    expect(
      parseSharePointSecret(sharePointReaderSecret({ ...app, tenantId: ` ${app.tenantId} ` })),
    ).toEqual(app);
    expect(parseSharePointSecret('acme.onmicrosoft.com:client-id:fixture-secret').tenantId).toBe(
      'acme.onmicrosoft.com',
    );
  });

  it('is refused when a value is missing or holds a space, without repeating it', (): void => {
    for (const secret of [
      'only-a-secret',
      'tenant:client',
      'tenant:client:two words',
      '::secret',
    ]) {
      let message = '';
      try {
        parseSharePointSecret(secret);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, secret).toBe(
        "A SharePoint secret is the app registration's tenant ID, client ID and client secret joined by colons, as tenant ID:client ID:client secret, with no spaces.",
      );
    }
  });
});

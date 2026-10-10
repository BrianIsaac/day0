import { describe, expect, it } from 'vitest';
import {
  checkConfluenceToken,
  confluenceCloudLocator,
  confluenceDataCenterLocator,
  parseConfluenceCloudLocator,
  parseConfluenceDataCenterLocator,
} from '../../../src/docs/confluence-source';

const CLOUD_ID = '1a11d016-8984-4c3e-b9ab-142dd06acb1b';

describe('a Confluence Cloud location', (): void => {
  it("is built from the cloud ID and the space's key, or its address in the browser", (): void => {
    const stored = `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/spaces/OPS`;
    expect(confluenceCloudLocator(CLOUD_ID.toUpperCase(), ' OPS ')).toBe(stored);
    expect(
      confluenceCloudLocator(CLOUD_ID, 'https://acme.atlassian.net/wiki/spaces/OPS/overview'),
    ).toBe(stored);
    expect(
      confluenceCloudLocator(
        CLOUD_ID,
        'https://acme.atlassian.net/wiki/spaces/OPS/pages/98311/Close',
      ),
    ).toBe(stored);
    expect(parseConfluenceCloudLocator(stored)).toEqual({ cloudId: CLOUD_ID, spaceKey: 'OPS' });
  });

  it('keeps a personal space, whose key opens with a tilde', (): void => {
    const stored = confluenceCloudLocator(CLOUD_ID, '~712020abc');
    expect(parseConfluenceCloudLocator(stored).spaceKey).toBe('~712020abc');
  });

  it('is refused when it names no space, another host or no cloud ID, without repeating it', (): void => {
    // What names no space is handed on as typed, for the link to refuse.
    expect(confluenceCloudLocator(CLOUD_ID, 'https://acme.atlassian.net/wiki/home')).toBe(
      'https://acme.atlassian.net/wiki/home',
    );
    for (const locator of [
      'https://acme.atlassian.net/wiki/home',
      `https://evil.example/ex/confluence/${CLOUD_ID}/wiki/spaces/OPS`,
      'https://api.atlassian.com/ex/confluence/not-a-cloud-id/wiki/spaces/OPS',
      `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/spaces/OPS?x=1`,
      `https://user:pass@api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/spaces/OPS`,
      `http://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/spaces/OPS`,
      'OPS',
    ]) {
      let message = '';
      try {
        parseConfluenceCloudLocator(locator);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("A Confluence Cloud location is the site's cloud ID and a space");
      expect(message).not.toContain(locator);
    }
  });
});

describe('a Confluence Data Center location', (): void => {
  it("is the server's address of the space, with its context path, however the browser showed it", (): void => {
    expect(
      confluenceDataCenterLocator('https://wiki.acme.corp/display/OPS/Close+the+quarter'),
    ).toBe('https://wiki.acme.corp/display/OPS');
    expect(
      confluenceDataCenterLocator('https://wiki.acme.corp:8443/confluence/spaces/OPS/overview'),
    ).toBe('https://wiki.acme.corp:8443/confluence/display/OPS');
    expect(
      parseConfluenceDataCenterLocator('https://wiki.acme.corp:8443/confluence/display/OPS'),
    ).toEqual({ base: 'https://wiki.acme.corp:8443/confluence', spaceKey: 'OPS' });
    expect(parseConfluenceDataCenterLocator('https://wiki.acme.corp/display/OPS')).toEqual({
      base: 'https://wiki.acme.corp',
      spaceKey: 'OPS',
    });
  });

  it('is refused over plain http, for a page by its ID, or with a user name in it', (): void => {
    expect(
      confluenceDataCenterLocator('https://wiki.acme.corp/pages/viewpage.action?pageId=1'),
    ).toBe('https://wiki.acme.corp/pages/viewpage.action?pageId=1');
    for (const locator of [
      'http://wiki.acme.corp/display/OPS',
      'https://wiki.acme.corp/pages/viewpage.action?pageId=1',
      'https://user:pass@wiki.acme.corp/display/OPS',
      'https://wiki.acme.corp/display/OPS#top',
      'not an address',
    ]) {
      expect(() => parseConfluenceDataCenterLocator(locator)).toThrow(
        "A Confluence Data Center location is a space's address as the browser shows it, over https",
      );
    }
  });
});

describe('a Confluence token', (): void => {
  it('is one line with no spaces, and a refusal never repeats it', (): void => {
    expect(() => checkConfluenceToken('fixture-confluence-token')).not.toThrow();
    let message = '';
    try {
      checkConfluenceToken('two words');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('A Confluence token is one line with no spaces, as Confluence showed it.');
  });
});

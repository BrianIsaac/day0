import { describe, expect, it } from 'vitest';
import {
  isReaderKind,
  READER_GUIDE_URLS,
  READER_KINDS,
  READER_WHERE,
  readerLinkValues,
} from '../../../app/documentation/reader-link';

/** A form's values, as the link form's uncontrolled fields give them. */
function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

describe('what the link form sends for a reader kind', (): void => {
  it('knows the five reader kinds from the rest, each with its guide and its location words', (): void => {
    const kinds = READER_KINDS.map(([kind]) => kind);
    expect(kinds).toEqual(['sharepoint', 'confluence-v2', 'confluence-dc', 'yuque', 'drive']);
    expect(['folder', 'git', 'urls', 'mcp', 'feishu'].filter(isReaderKind)).toEqual([]);
    for (const kind of kinds) {
      expect(isReaderKind(kind)).toBe(true);
      expect(READER_GUIDE_URLS[kind]).toMatch(/\/docs\/running\/reader-[a-z]+\.md$/);
      expect(READER_WHERE[kind].length).toBeGreaterThan(0);
    }
  });

  it('joins a SharePoint app registration and reduces a pasted address to its site', (): void => {
    expect(
      readerLinkValues(
        'sharepoint',
        'https://acme.sharepoint.com/sites/Runbooks/SitePages/Home.aspx',
        form({ tenantId: 'tenant', clientId: 'client', clientSecret: ' secret ' }),
      ),
    ).toEqual({
      locator: 'https://acme.sharepoint.com/sites/Runbooks',
      credential: 'tenant:client:secret',
    });
  });

  it('hands on what names nothing as it was typed, for the link to refuse in its own words', (): void => {
    expect(readerLinkValues('yuque', ' not an address ', form({ credential: 'token' }))).toEqual({
      locator: 'not an address',
      credential: 'token',
    });
    expect(readerLinkValues('drive', 'x', form({ credential: 'not json' })).credential).toBe(
      'not json',
    );
  });
});

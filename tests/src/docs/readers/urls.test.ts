import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { htmlPageTitle, parseUrlLocator, UrlsReader } from '../../../../src/docs/readers/urls';
import type { DocSourceRecord } from '../../../../src/docs/types';

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('URL documentation reader', (): void => {
  it('parses JSON arrays and newline-separated locators', (): void => {
    expect(parseUrlLocator('["https://example.com/a"]')).toHaveLength(1);
    expect(parseUrlLocator('https://example.com/a\nhttps://example.com/b')).toHaveLength(2);
    expect(() => parseUrlLocator('file:///private')).toThrow('HTTP or HTTPS');
  });

  it('converts bounded HTML pages to Markdown', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        return new Response('<html><head><title>Runbook &amp; guide</title></head><body><h1>Runbook</h1><p>Do the work.</p></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }),
    );
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: 'https://example.com/runbook',
    };
    const [page] = await new UrlsReader().listPages(source);
    expect(page.title).toBe('Runbook & guide');
    expect(page.markdown).toContain('# Runbook');
    expect(page.markdown).toContain('Do the work.');
  });

  it('extracts a plain fallback-safe HTML title', (): void => {
    expect(htmlPageTitle('<title>  Team   docs </title>', 'fallback')).toBe('Team docs');
    expect(htmlPageTitle('<p>none</p>', 'fallback')).toBe('fallback');
  });
});

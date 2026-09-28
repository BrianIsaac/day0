import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  htmlPageTitle,
  pageAccess,
  parseUrlLocator,
  UrlsReader,
} from '../../../../src/docs/readers/urls';
import type { DocSourceRecord } from '../../../../src/docs/types';
import { PROVIDER_BACKOFF } from '../../../../src/lib/transport-error';

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
        return new Response(
          '<html><head><title>Runbook &amp; guide</title></head><body><h1>Runbook</h1><p>Do the work.</p></body></html>',
          {
            headers: { 'content-type': 'text/html' },
          },
        );
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

  it('fetches only the URL range selected by a batch cursor', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      return new Response(`# ${url.endsWith('/one') ? 'One' : 'Two'}`, {
        headers: { 'content-type': 'text/markdown' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: 'https://example.com/one\nhttps://example.com/two',
    };
    const first = await new UrlsReader().listPageBatch(source, undefined, undefined, 1);
    expect(first.pages.map((page) => page.title)).toEqual(['One']);
    expect(first.nextCursor).toMatch(/^1@[0-9a-z]{7}$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits out a 429 and reads the page instead of failing the source', async (): Promise<void> => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        calls += 1;
        return calls === 1
          ? new Response('slow down', { status: 429, headers: { 'Retry-After': '4' } })
          : new Response('# Rate limited once', { headers: { 'content-type': 'text/markdown' } });
      }),
    );
    const waits: number[] = [];
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: 'https://example.com/one',
    };
    const reader = new UrlsReader({
      ...PROVIDER_BACKOFF,
      sleep: async (ms: number): Promise<void> => void waits.push(ms),
    });
    const [page] = await reader.listPages(source);
    expect(page?.title).toBe('Rate limited once');
    expect(waits).toEqual([4_000]);
  });

  it('names a page that fails and reads the rest of the batch (P5-11)', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/gone')) return new Response('missing', { status: 404 });
        if (url.endsWith('/huge')) {
          return new Response('x', { headers: { 'content-length': String(3 * 1024 * 1024) } });
        }
        if (url.startsWith('https://down.example')) {
          throw new TypeError('fetch failed', {
            cause: Object.assign(new Error('getaddrinfo ENOTFOUND down.example'), {
              code: 'ENOTFOUND',
            }),
          });
        }
        return new Response('# Kept', { headers: { 'content-type': 'text/markdown' } });
      }),
    );
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: [
        'https://example.com/gone',
        'https://example.com/kept',
        'https://example.com/huge',
        'https://down.example/page',
      ].join('\n'),
    };
    const batch = await new UrlsReader({
      ...PROVIDER_BACKOFF,
      sleep: async () => undefined,
    }).listPageBatch(source, undefined, undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual(['https://example.com/kept']);
    expect(batch.unread).toEqual([
      { ref: 'https://example.com/gone', reason: 'https://example.com/gone returned HTTP 404.' },
      { ref: 'https://example.com/huge', reason: 'https://example.com/huge exceeds 2 MiB.' },
      {
        ref: 'https://down.example/page',
        reason: 'fetch failed (getaddrinfo ENOTFOUND down.example)',
      },
    ]);
    expect(batch.nextCursor).toBeUndefined();
  });

  it('sends a wiki’s reader secret to its own site only, and follows no redirect off it (E-74)', async (): Promise<void> => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
        if (url.endsWith('/moved')) {
          return new Response(null, { status: 302, headers: { location: '/wiki/moved-here' } });
        }
        if (url.endsWith('/away')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://collector.example/steal' },
          });
        }
        return new Response('# Page', { headers: { 'content-type': 'text/markdown' } });
      }),
    );
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Wiki',
      kind: 'urls',
      locator: 'https://wiki.example/wiki/moved\nhttps://wiki.example/wiki/away',
    };
    const batch = await new UrlsReader().listPageBatch(source, 'wiki-token', undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual(['https://wiki.example/wiki/moved']);
    expect(batch.unread).toEqual([
      {
        ref: 'https://wiki.example/wiki/away',
        reason:
          'https://wiki.example/wiki/away redirects to https://collector.example; a page read with a secret is not followed off its site.',
      },
    ]);
    expect(seen).toEqual([
      { url: 'https://wiki.example/wiki/moved', authorization: 'Bearer wiki-token' },
      { url: 'https://wiki.example/wiki/moved-here', authorization: 'Bearer wiki-token' },
      { url: 'https://wiki.example/wiki/away', authorization: 'Bearer wiki-token' },
    ]);
  });

  it('refuses to read with a secret a list that spans more than one https site', (): void => {
    expect(() =>
      pageAccess([new URL('https://wiki.example/a'), new URL('https://other.example/b')], 'value'),
    ).toThrow('one https site');
    expect(pageAccess([new URL('http://wiki.example/a')], undefined)).toEqual({});
  });

  it('extracts a plain fallback-safe HTML title', (): void => {
    expect(htmlPageTitle('<title>  Team   docs </title>', 'fallback')).toBe('Team docs');
    expect(htmlPageTitle('<p>none</p>', 'fallback')).toBe('fallback');
  });
});

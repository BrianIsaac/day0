import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  htmlPageTitle,
  pageAccess,
  parseUrlLocator,
  UrlsReader,
  type PageConnection,
} from '../../../../src/docs/readers/urls';
import type { DocSourceRecord } from '../../../../src/docs/types';
import { privateHostAllowlist } from '../../../../src/lib/private-hosts';
import { PROVIDER_BACKOFF } from '../../../../src/lib/transport-error';

/**
 * A connection whose every page host answers with one public address and whose dial is the
 * given fetch, so no test resolves a name or opens a socket.
 */
function connectionTo(
  fetcher: (input: URL, init?: RequestInit) => Promise<Response>,
): PageConnection {
  return {
    resolve: async (): Promise<string[]> => ['93.184.215.14'],
    dial: () => fetcher,
    privateHosts: privateHostAllowlist(''),
  };
}

describe('URL documentation reader', (): void => {
  it('parses JSON arrays and newline-separated locators', (): void => {
    expect(parseUrlLocator('["https://example.com/a"]')).toHaveLength(1);
    expect(parseUrlLocator('https://example.com/a\nhttps://example.com/b')).toHaveLength(2);
    expect(() => parseUrlLocator('file:///private')).toThrow('HTTP or HTTPS');
  });

  it('converts bounded HTML pages to Markdown', async (): Promise<void> => {
    const connection = connectionTo(async (): Promise<Response> => {
      return new Response(
        '<html><head><title>Runbook &amp; guide</title></head><body><h1>Runbook</h1><p>Do the work.</p></body></html>',
        {
          headers: { 'content-type': 'text/html' },
        },
      );
    });
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: 'https://example.com/runbook',
    };
    const [page] = (
      await new UrlsReader(PROVIDER_BACKOFF, connection).listPageBatch(
        source,
        undefined,
        undefined,
        25,
      )
    ).pages;
    expect(page.title).toBe('Runbook & guide');
    expect(page.markdown).toContain('# Runbook');
    expect(page.markdown).toContain('Do the work.');
  });

  it('fetches only the URL range selected by a batch cursor', async (): Promise<void> => {
    const fetchMock = vi.fn(async (input: URL): Promise<Response> => {
      const url = String(input);
      return new Response(`# ${url.endsWith('/one') ? 'One' : 'Two'}`, {
        headers: { 'content-type': 'text/markdown' },
      });
    });
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: 'https://example.com/one\nhttps://example.com/two',
    };
    const first = await new UrlsReader(PROVIDER_BACKOFF, connectionTo(fetchMock)).listPageBatch(
      source,
      undefined,
      undefined,
      1,
    );
    expect(first.pages.map((page) => page.title)).toEqual(['One']);
    expect(first.nextCursor).toMatch(/^1@[0-9a-z]{7}$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits out a 429 and reads the page instead of failing the source', async (): Promise<void> => {
    let calls = 0;
    const connection = connectionTo(async (): Promise<Response> => {
      calls += 1;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '4' } })
        : new Response('# Rate limited once', { headers: { 'content-type': 'text/markdown' } });
    });
    const waits: number[] = [];
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: 'https://example.com/one',
    };
    const reader = new UrlsReader(
      {
        ...PROVIDER_BACKOFF,
        sleep: async (ms: number): Promise<void> => void waits.push(ms),
      },
      connection,
    );
    const [page] = (await reader.listPageBatch(source, undefined, undefined, 25)).pages;
    expect(page?.title).toBe('Rate limited once');
    expect(waits).toEqual([4_000]);
  });

  it('names a page that fails and reads the rest of the batch (P5-11)', async (): Promise<void> => {
    const connection = connectionTo(async (input: URL): Promise<Response> => {
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
    });
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
    const batch = await new UrlsReader(
      {
        ...PROVIDER_BACKOFF,
        sleep: async () => undefined,
      },
      connection,
    ).listPageBatch(source, undefined, undefined, 25);
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
    const connection = connectionTo(async (input: URL, init?: RequestInit): Promise<Response> => {
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
    });
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Wiki',
      kind: 'urls',
      locator: 'https://wiki.example/wiki/moved\nhttps://wiki.example/wiki/away',
    };
    const batch = await new UrlsReader(PROVIDER_BACKOFF, connection).listPageBatch(
      source,
      'wiki-token',
      undefined,
      25,
    );
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

  it('refuses http on a public host and a listed name that resolves to loopback (R9)', async (): Promise<void> => {
    const answers: Record<string, string[]> = {
      'docs.example.com': ['93.184.215.14'],
      'wiki.corp.internal': ['127.0.0.1'],
      'intranet.corp.internal': ['10.1.2.3'],
      'sneaky.example.com': ['10.0.0.8'],
    };
    const dialled: Array<{ url: string; addresses: readonly string[] }> = [];
    const reader = new UrlsReader(
      { ...PROVIDER_BACKOFF, sleep: async () => undefined },
      {
        resolve: async (hostname: string): Promise<string[]> => answers[hostname] ?? [],
        dial: (checked) => async (input: URL) => {
          dialled.push({ url: input.href, addresses: checked.addresses });
          return new Response('# Page', { headers: { 'content-type': 'text/markdown' } });
        },
        privateHosts: privateHostAllowlist('.corp.internal'),
      },
    );
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: [
        'http://docs.example.com/page',
        'https://docs.example.com/page',
        'https://wiki.corp.internal/start',
        'http://intranet.corp.internal/runbook',
        'https://sneaky.example.com/start',
      ].join('\n'),
    };
    const batch = await reader.listPageBatch(source, undefined, undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual([
      'https://docs.example.com/page',
      'http://intranet.corp.internal/runbook',
    ]);
    expect(batch.unread).toEqual([
      {
        ref: 'http://docs.example.com/page',
        reason:
          'http://docs.example.com/page is plain http on a host DAY0_PRIVATE_HOSTS does not list; Day0 reads a public page over https only.',
      },
      {
        ref: 'https://wiki.corp.internal/start',
        reason:
          'https://wiki.corp.internal/start: its host is listed in DAY0_PRIVATE_HOSTS but answers with a loopback, link-local, multicast or unspecified address, which Day0 never reads from.',
      },
      {
        ref: 'https://sneaky.example.com/start',
        reason:
          'https://sneaky.example.com/start: its host answers with a private, loopback, link-local or otherwise non-public address and DAY0_PRIVATE_HOSTS does not list it, so Day0 does not read it.',
      },
    ]);
    // Only the admitted pages were dialled, each at the addresses its check returned.
    expect(dialled).toEqual([
      { url: 'https://docs.example.com/page', addresses: ['93.184.215.14'] },
      { url: 'http://intranet.corp.internal/runbook', addresses: ['10.1.2.3'] },
    ]);
  });

  it('checks every address a redirect leads to before it follows it (R9)', async (): Promise<void> => {
    const dialled: string[] = [];
    const reader = new UrlsReader(PROVIDER_BACKOFF, {
      resolve: async (hostname: string): Promise<string[]> =>
        hostname === 'docs.example.com' ? ['93.184.215.14'] : ['169.254.169.254'],
      dial: () => async (input: URL) => {
        dialled.push(input.href);
        return input.pathname === '/moved'
          ? new Response(null, { status: 302, headers: { location: '/moved-here' } })
          : input.pathname === '/away'
            ? new Response(null, {
                status: 302,
                headers: { location: 'https://metadata.example.com/latest' },
              })
            : new Response('# Page', { headers: { 'content-type': 'text/markdown' } });
      },
      privateHosts: privateHostAllowlist(''),
    });
    const source: DocSourceRecord = {
      _id: 'source-urls' as Id<'docSources'>,
      label: 'Pages',
      kind: 'urls',
      locator: 'https://docs.example.com/moved\nhttps://docs.example.com/away',
    };
    const batch = await reader.listPageBatch(source, undefined, undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual(['https://docs.example.com/moved']);
    expect(batch.unread).toEqual([
      {
        ref: 'https://docs.example.com/away',
        reason:
          'https://metadata.example.com/latest: its host answers with a private, loopback, link-local or otherwise non-public address and DAY0_PRIVATE_HOSTS does not list it, so Day0 does not read it.',
      },
    ]);
    expect(dialled).toEqual([
      'https://docs.example.com/moved',
      'https://docs.example.com/moved-here',
      'https://docs.example.com/away',
    ]);
  });

  it('extracts a plain fallback-safe HTML title', (): void => {
    expect(htmlPageTitle('<title>  Team   docs </title>', 'fallback')).toBe('Team docs');
    expect(htmlPageTitle('<p>none</p>', 'fallback')).toBe('fallback');
  });
});

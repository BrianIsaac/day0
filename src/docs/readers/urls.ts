import TurndownService from 'turndown';
import { fetchWithBackoff, PROVIDER_BACKOFF, type BackoffPolicy } from '../../lib/transport-error';
import type { DocPage, DocSourceRecord } from '../types';
import {
  listingCursor,
  offsetInListing,
  splitPageReads,
  unreadReason,
  type DocumentationReader,
  type ReadPageBatch,
  type UnreadPage,
} from './batch';
import { markdownPageTitle } from './folder';
import { authorizationHeader } from './mcp';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/** The most redirects a page read with a secret follows, all within its site. */
const MAX_SECRET_REDIRECTS = 5;

/** How a page is fetched: the secret's header, and the one site it may be sent to. */
interface PageAccess {
  readonly authorization?: string;
  readonly origin?: string;
}

/**
 * The access a URL source's own secret gives (E-74): its authorization
 * header, sent only to the one https site the source lists.
 *
 * @param urls - Every page the source lists.
 * @param secret - The source's reader secret, when it was linked with one.
 * @throws Error when a secret would reach more than one site, or any over plain http.
 */
export function pageAccess(urls: readonly URL[], secret: string | undefined): PageAccess {
  if (secret === undefined) return {};
  const origins = new Set(urls.map((url: URL): string => url.origin));
  const [origin] = [...origins];
  if (origins.size !== 1 || !origin.startsWith('https://')) {
    throw new Error(
      'A reader secret belongs to one https site, and this source lists pages beyond one; relink it with pages of one site.',
    );
  }
  return { authorization: authorizationHeader(secret), origin };
}

/**
 * Parse a newline-separated or JSON-array URL locator.
 *
 * Args:
 *   locator: Stored URL source locator.
 *
 * Returns:
 *   Validated HTTP(S) page URLs.
 *
 * Raises:
 *   Error: If the list is empty or contains a different protocol.
 */
export function parseUrlLocator(locator: string): URL[] {
  let values: unknown;
  try {
    values = JSON.parse(locator);
  } catch {
    values = locator
      .split(/\r?\n/)
      .map((value: string): string => value.trim())
      .filter(Boolean);
  }
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((value) => typeof value === 'string')
  ) {
    throw new Error('URL documentation needs one or more HTTP(S) URLs.');
  }
  return values.map((value: string): URL => {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Documentation page URLs must use HTTP or HTTPS.');
    }
    return url;
  });
}

/**
 * Extract a useful title from an HTML document.
 *
 * Args:
 *   html: HTML page body.
 *   fallback: Host/path label used when no title exists.
 *
 * Returns:
 *   Decoded plain title text.
 */
export function htmlPageTitle(html: string, fallback: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return fallback;
  return match[1]
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reader for an explicit allowlist of web documentation pages. */
export class UrlsReader implements DocumentationReader {
  private readonly backoff: BackoffPolicy;

  /** @param backoff - How a rate-limited or failed page read is tried again. */
  constructor(backoff: BackoffPolicy = PROVIDER_BACKOFF) {
    this.backoff = backoff;
  }

  /**
   * Fetch a bounded range of listed pages.
   *
   * Args:
   *   source: Linked URL-list source.
   *   secret: The source's own reader secret, when a wiki behind a login needs one.
   *   cursor: Optional decimal URL offset.
   *   limit: Maximum pages to fetch.
   *
   * Returns:
   *   Bounded page batch, the listed pages that could not be read, and continuation cursor.
   */
  async listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<ReadPageBatch> {
    const urls = parseUrlLocator(source.locator);
    const access = pageAccess(urls, secret);
    const listing = urls.map((url: URL): string => url.href);
    const offset = offsetInListing(cursor, listing);
    const selected = urls.slice(offset, offset + limit);
    const reads = await this.fetchPages(source, selected, access);
    const nextOffset = offset + selected.length;
    return {
      ...splitPageReads(reads),
      nextCursor: nextOffset < urls.length ? listingCursor(nextOffset, listing) : undefined,
    };
  }

  /**
   * Fetch each listed page and normalise HTML to Markdown.
   *
   * Args:
   *   source: Linked URL-list source.
   *   secret: The source's own reader secret, if any.
   *
   * Returns:
   *   Normalised documentation pages in locator order.
   */
  async listPages(source: DocSourceRecord, secret?: string): Promise<DocPage[]> {
    const urls = parseUrlLocator(source.locator);
    const { pages, unread } = splitPageReads(
      await this.fetchPages(source, urls, pageAccess(urls, secret)),
    );
    if (unread.length > 0) throw new Error(`${unread[0].ref}: ${unread[0].reason}`);
    return pages;
  }

  /**
   * Fetch and normalise a known-safe URL batch, one page at a time.
   *
   * Every listed address is its own page on its own host, so any failure to
   * read one (an HTTP error, a page over 2 MiB, a host that did not answer
   * after the backoff) is that page's, and the rest are still read (P5-11).
   *
   * Args:
   *   source: Linked URL-list source.
   *   urls: Validated HTTP(S) URLs.
   *   access: The secret's header and site, when the source has one.
   *
   * Returns:
   *   Each URL's page or unread record, in locator order.
   */
  private async fetchPages(
    source: DocSourceRecord,
    urls: URL[],
    access: PageAccess,
  ): Promise<Array<DocPage | UnreadPage>> {
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const reads: Array<DocPage | UnreadPage> = [];
    // Read through the global fetch at call time, one timeout per try.
    const read = fetchWithBackoff(
      (input: URL, init?: RequestInit): Promise<Response> => fetch(input, init),
      20_000,
      this.backoff,
    );
    for (const url of urls) {
      try {
        reads.push(await this.fetchPage(source, url, read, turndown, access));
      } catch (error) {
        reads.push({ ref: url.href, reason: unreadReason(error) });
      }
    }
    return reads;
  }

  /** Fetch and normalise one listed page. */
  private async fetchPage(
    source: DocSourceRecord,
    url: URL,
    read: (input: URL, init?: RequestInit) => Promise<Response>,
    turndown: TurndownService,
    access: PageAccess,
  ): Promise<DocPage> {
    const response = await fetchWithinSite(url, read, access);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (!response.ok || declaredLength > MAX_PAGE_BYTES) {
      // The refused answer is let go, so its connection is freed for the next page.
      await response.body?.cancel();
      throw new Error(
        response.ok
          ? `${url.href} exceeds 2 MiB.`
          : `${url.href} returned HTTP ${response.status}.`,
      );
    }
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_PAGE_BYTES) throw new Error(`${url.href} exceeds 2 MiB.`);
    const contentType = response.headers.get('content-type') || '';
    const isHtml = contentType.includes('html') || /<html[\s>]/i.test(body);
    const markdown = isHtml ? turndown.turndown(body) : body;
    const fallback = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
    return {
      sourceId: source._id,
      ref: url.href,
      title: isHtml ? htmlPageTitle(body, fallback) : markdownPageTitle(markdown, fallback),
      url: url.href,
      markdown,
      updatedAt: Date.now(),
    };
  }
}

/**
 * Fetch one page, carrying a reader secret only within its site.
 *
 * Without a secret the fetch follows redirects as any reader would. With
 * one, redirects are followed by hand and only within the secret's site, so
 * the header never reaches another host (E-74).
 *
 * @throws Error when a page read with a secret redirects to another site, or too often.
 */
async function fetchWithinSite(
  url: URL,
  read: (input: URL, init?: RequestInit) => Promise<Response>,
  access: PageAccess,
): Promise<Response> {
  const accept = 'text/markdown, text/html;q=0.9, text/plain;q=0.8';
  if (access.authorization === undefined) return await read(url, { headers: { Accept: accept } });
  let current = url;
  for (let hop = 0; hop <= MAX_SECRET_REDIRECTS; hop += 1) {
    const response = await read(current, {
      headers: { Accept: accept, Authorization: access.authorization },
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    await response.body?.cancel();
    const next = new URL(location, current);
    if (next.origin !== access.origin) {
      throw new Error(
        `${url.href} redirects to ${next.origin}; a page read with a secret is not followed off its site.`,
      );
    }
    current = next;
  }
  throw new Error(`${url.href} redirected more than ${MAX_SECRET_REDIRECTS} times.`);
}

import TurndownService from 'turndown';
import type { DocPage, DocPageBatch, DocSourceReader, DocSourceRecord } from '../types';
import { markdownPageTitle, offsetFromCursor } from './folder';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;

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
export class UrlsReader implements DocSourceReader {
  /**
   * Fetch a bounded range of listed pages.
   *
   * Args:
   *   source: Linked URL-list source.
   *   _secret: Unused because URL pages are publicly readable.
   *   cursor: Optional decimal URL offset.
   *   limit: Maximum pages to fetch.
   *
   * Returns:
   *   Bounded page batch and continuation cursor.
   */
  async listPageBatch(
    source: DocSourceRecord,
    _secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch> {
    void _secret;
    const urls = parseUrlLocator(source.locator);
    const offset = offsetFromCursor(cursor);
    const selected = urls.slice(offset, offset + limit);
    const pages = await this.fetchPages(source, selected);
    const nextOffset = offset + pages.length;
    return { pages, nextCursor: nextOffset < urls.length ? String(nextOffset) : undefined };
  }

  /**
   * Fetch each listed page and normalise HTML to Markdown.
   *
   * Args:
   *   source: Linked URL-list source.
   *   _secret: Unused because Phase 1 URL pages are publicly readable.
   *
   * Returns:
   *   Normalised documentation pages in locator order.
   */
  async listPages(source: DocSourceRecord, _secret?: string): Promise<DocPage[]> {
    void _secret;
    return await this.fetchPages(source, parseUrlLocator(source.locator));
  }

  /**
   * Fetch and normalise a known-safe URL batch.
   *
   * Args:
   *   source: Linked URL-list source.
   *   urls: Validated HTTP(S) URLs.
   *
   * Returns:
   *   Normalised pages in locator order.
   */
  private async fetchPages(source: DocSourceRecord, urls: URL[]): Promise<DocPage[]> {
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const pages: DocPage[] = [];
    for (const url of urls) {
      const response = await fetch(url, {
        headers: { Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`${url.href} returned HTTP ${response.status}.`);
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > MAX_PAGE_BYTES) throw new Error(`${url.href} exceeds 2 MiB.`);
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_PAGE_BYTES) throw new Error(`${url.href} exceeds 2 MiB.`);
      const contentType = response.headers.get('content-type') || '';
      const isHtml = contentType.includes('html') || /<html[\s>]/i.test(body);
      const markdown = isHtml ? turndown.turndown(body) : body;
      const fallback = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
      pages.push({
        sourceId: source._id,
        ref: url.href,
        title: isHtml ? htmlPageTitle(body, fallback) : markdownPageTitle(markdown, fallback),
        url: url.href,
        markdown,
        updatedAt: Date.now(),
      });
    }
    return pages;
  }
}

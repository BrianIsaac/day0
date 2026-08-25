import TurndownService from 'turndown';
import type { DocPage, DocSourceReader, DocSourceRecord } from '../types';
import { markdownPageTitle } from './folder';

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
    values = locator.split(/\r?\n/).map((value: string): string => value.trim()).filter(Boolean);
  }
  if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === 'string')) {
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
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const pages: DocPage[] = [];
    for (const url of parseUrlLocator(source.locator)) {
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
        title: isHtml
          ? htmlPageTitle(body, fallback)
          : markdownPageTitle(markdown, fallback),
        url: url.href,
        markdown,
        updatedAt: Date.now(),
      });
    }
    return pages;
  }
}

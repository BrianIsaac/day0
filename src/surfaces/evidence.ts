/**
 * Display rules for evidence quotes on the Surfaces cards.
 *
 * The stored evidence is never rewritten; a quote that is exactly one
 * `<page url="...">title</page>` index tag (the shape a Notion index page
 * lists its subpages in) is shown as the title linked to the page, and
 * every other quote is shown as it was stored.
 */

const PAGE_TAG = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?<page\s+url="([^"]+)"\s*>([^<]*)<\/page>\s*$/;

export interface PageLink {
  url: string;
  title: string;
}

/**
 * Read a page link out of a quote when the quote is nothing but an index tag.
 *
 * Args:
 *   quote: The evidence quote as stored.
 *
 * Returns:
 *   The page's http(s) URL and title, or undefined when the quote is prose.
 */
export function pageLinkFromQuote(quote: string | undefined): PageLink | undefined {
  if (!quote) return undefined;
  const match = PAGE_TAG.exec(quote);
  if (!match) return undefined;
  const [, url, rawTitle] = match;
  if (/[\u0000-\u001f\u007f]/.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    return undefined;
  }
  const title = rawTitle
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { url, title: title || url };
}

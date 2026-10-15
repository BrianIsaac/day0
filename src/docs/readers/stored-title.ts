/**
 * The title the sync stores a page under, as a reader that keeps a page by what was stored must
 * compare it (the reader contract by revision, wave 17), and whether a listed title is the one a
 * page was stored under (wave 18, 18-X).
 */
import type { StoredMark } from './batch';
import { markdownPageTitle } from './folder';
import { underTitle } from './html-markdown';

/**
 * The title the sync stores a page under, for a page its reader put under its source's title.
 *
 * The store names a page by the first level-one heading of its Markdown, and `underTitle` writes
 * the source's title there with its runs of white space closed up, so a title with two spaces in
 * it, or one that closes on a ` #`, is stored differently from how its listing gives it. A reader
 * that holds a listed title against the stored one compares this, where the listed title itself
 * would never equal it and the page would be read at every sync.
 *
 * A title holding a value the sync redacts is stored redacted, which no reader can foresee: such
 * a page is read at every sync, as every page was before the contract.
 *
 * @param title - The page's title as its source gives it.
 */
export function storedPageTitle(title: string): string {
  return markdownPageTitle(underTitle(title, ''), title);
}

/**
 * Whether a listed title is the one a page was stored under, for a reader that keeps the page
 * without reading its body.
 *
 * The listed title's keyed hash is compared first, where the sync holds the stored one: a title
 * holding a value the sync redacts is stored redacted, so only its hash says the listing still
 * gives it (17-X's F4 residual; `docPages.titleHash`). Where there is no stored hash, or it was
 * taken under another key, the title is compared as the store writes it (`storedPageTitle`), as
 * before. Two titles whose hashes match are one title as the store writes it, so no rename is
 * kept by its hash.
 *
 * @param mark - What the sync stored the page with.
 * @param title - The page's title as its listing gives it now.
 */
export function holdsListedTitle(mark: StoredMark, title: string): boolean {
  if (mark.titleHash !== undefined && mark.hashTitle?.(title) === mark.titleHash) return true;
  return mark.title === storedPageTitle(title);
}

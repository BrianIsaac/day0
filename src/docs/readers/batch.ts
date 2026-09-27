/**
 * What one documentation batch read yields, and the reader contract the sync reads it through.
 *
 * One page a reader cannot read fails that page, not the sync (P5-11): the
 * reader names it here and goes on, and the sync keeps the page's last
 * stored version and its credentials until a later sync reads it. A failure
 * that is not the page's own (the listing, the session, a transient that the
 * batch's retry is for) still fails the batch, which the next sync resumes.
 */

import { shortHash } from '../../lib/short-hash';
import { TransientProviderError, transportFailureKind } from '../../lib/transport-error';
import type { DocPage, DocPageBatch, DocSourceReader, DocSourceRecord } from '../types';

/** A listed page the reader could not read, and why, in words safe to store. */
export interface UnreadPage {
  readonly ref: string;
  readonly reason: string;
}

/** One bounded batch: the pages read, the listed pages that could not be, and the continuation. */
export interface ReadPageBatch extends DocPageBatch {
  readonly unread: readonly UnreadPage[];
}

/** A documentation reader whose batches name the pages they could not read. */
export interface DocumentationReader extends DocSourceReader {
  listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<ReadPageBatch>;
}

/**
 * Word a page's read failure for the sync, which redacts it and puts it on one line.
 *
 * @param error - What reading the page threw.
 * @returns The failure's message and, when it differs, its innermost cause's, as they were written.
 */
export function unreadReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let cause: unknown = error instanceof Error ? error.cause : undefined;
  for (
    let depth = 0;
    cause instanceof Error && cause.cause instanceof Error && depth < 5;
    depth += 1
  ) {
    cause = cause.cause;
  }
  const full =
    cause instanceof Error && cause.message && cause.message !== message
      ? `${message} (${cause.message})`
      : message;
  // Not cut here: the sync redacts the whole text, then the record bounds it.
  return full.trim() === '' ? 'the page could not be read' : full;
}

/**
 * Whether a failure belongs to the provider or the connection rather than to one page.
 *
 * A transient answer or a transport failure while reading one page of a
 * provider is the provider's, and the batch's own retry and the sync's
 * resume are for it; recording the page as unread would keep its old
 * version for a failure the next try clears.
 */
export function isProviderFailure(error: unknown): boolean {
  return error instanceof TransientProviderError || transportFailureKind(error) !== undefined;
}

/**
 * Read one page of a provider, recording a failure that is the page's own.
 *
 * @param ref - The page's reference.
 * @param read - Reads the page.
 * @returns The page, or the unread record for it.
 * @throws The failure when it is the provider's (`isProviderFailure`), for the batch to handle.
 */
export async function readProviderPage(
  ref: string,
  read: () => Promise<DocPage>,
): Promise<DocPage | UnreadPage> {
  try {
    return await read();
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    return { ref, reason: unreadReason(error) };
  }
}

/**
 * Split what a batch's page reads returned into the pages and the unread records.
 *
 * @param results - Each listed page's read, in listing order.
 */
export function splitPageReads(results: readonly (DocPage | UnreadPage)[]): {
  pages: DocPage[];
  unread: UnreadPage[];
} {
  const pages: DocPage[] = [];
  const unread: UnreadPage[] = [];
  for (const result of results) {
    if ('markdown' in result) pages.push(result);
    else unread.push(result);
  }
  return { pages, unread };
}

/**
 * A batch cursor taken from a listing that has changed since.
 *
 * An offset into a re-read listing (a folder, a git checkout, a server's
 * resources) points at another page once a page before it is added or
 * removed: read on, the generation would miss a live page and its final
 * batch would delete it and supersede its credentials. The sync reads the
 * source again from page one instead (adversarial pass on step 17).
 */
export class ListingChangedError extends Error {
  constructor() {
    super(
      'The documentation listing changed while this sync was reading it, so it reads the source again from the first page.',
    );
    this.name = 'ListingChangedError';
  }
}

/** The digest of a listing, in the order the reader reads it. */
function listingDigest(listing: readonly string[]): string {
  return shortHash(listing.join('\n'));
}

/**
 * The cursor that continues a listing at an offset, bound to that listing.
 *
 * @param offset - The index of the next page to read.
 * @param listing - Every page reference, in reading order.
 */
export function listingCursor(offset: number, listing: readonly string[]): string {
  return `${offset}@${listingDigest(listing)}`;
}

/**
 * The offset a listing cursor continues at, when the listing is still the one it was taken from.
 *
 * @param cursor - The cursor, or nothing for the first batch.
 * @param listing - Every page reference, as the reader lists them now.
 * @throws ListingChangedError when the listing differs from the cursor's, or the cursor is not
 *   one bound to a listing (an offset alone cannot be checked).
 */
export function offsetInListing(cursor: string | undefined, listing: readonly string[]): number {
  if (cursor === undefined) return 0;
  const match = /^(0|[1-9][0-9]*)@([0-9a-z]{7})$/.exec(cursor);
  if (!match || match[2] !== listingDigest(listing)) throw new ListingChangedError();
  return Number(match[1]);
}

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
import type { PageStatus } from '../authority';
import type { DocPage, DocPageBatch, DocSourceReader, DocSourceRecord } from '../types';

/**
 * Which of the two a listed page that was not read is (D-7): a read that `failed` (forbidden,
 * too large, gone), which keeps the page's last version and is tried again at the next sync; or
 * a page of a kind Day0 does `not-read` (a sheet, a slide deck, a PDF), which no sync will read.
 */
export type UnreadKind = 'failed' | 'not-read';

/** A listed page the reader could not read, and why, in words safe to store. */
export interface UnreadPage {
  readonly ref: string;
  readonly reason: string;
  /** Which it is; a reader names a kind it does not read, and every other unread page failed. */
  readonly kind?: UnreadKind;
}

/** What the sync holds of a stored page, for a reader to tell whether its listing changed it. */
export interface StoredMark {
  /** The revision it was stored with (`docPages.sourceRevision`). */
  readonly revision: string;
  /** Its stored title. */
  readonly title: string;
  /** Its stored address, where it has one. */
  readonly url?: string;
  /**
   * The keyed hash of the title its listing gave when it was stored (`docPages.titleHash`; wave
   * 18, 18-D), where the sync holds one and the deployment's key: a title holding a value the
   * redaction takes out is stored redacted, and only this says the listing still gives it.
   */
  readonly titleHash?: string;
  /**
   * The same keyed hash of a title as a listing gives it now (`pageTitleHash`), given with
   * `titleHash`: the sync's, holding the key and the owner the reader never reads.
   */
  readonly hashTitle?: (title: string) => string;
}

/**
 * The reader contract by revision (X-13; wave 16, 16-FD): for listed pages, what each was stored
 * with, by ref. A reader whose listing gives each page's revision asks it before it reads any
 * body, and keeps a page whose listing says the stored revision, title and address without
 * reading its body (`ReadPageBatch.kept`); a ref the sync does not answer (not stored, no
 * revision, or a page it would not keep as stored) is read as before.
 */
export type StoredRevisions = (refs: readonly string[]) => Promise<ReadonlyMap<string, StoredMark>>;

/**
 * What the sync stored the named pages with, for a reader that asks once a listing page.
 *
 * @param stored - The sync's contract; none for a read with nothing to keep by.
 * @param refs - The listed pages a reader could keep.
 * @returns The marks the sync answers; none where there is no contract or no page to ask of.
 */
export async function storedMarks(
  stored: StoredRevisions | undefined,
  refs: readonly string[],
): Promise<ReadonlyMap<string, StoredMark>> {
  return stored === undefined || refs.length === 0 ? new Map() : await stored(refs);
}

/** A listed page kept as stored by its revision, its body unread (X-13). */
export interface KeptPage {
  readonly ref: string;
  /** What the listing says of the page's status now; absent, it says nothing. */
  readonly nativeStatus?: PageStatus;
  /**
   * Whether the listing dates the page itself, so the `updatedAt` it was stored with at this
   * revision is its source's own edit time (`DocPage.datedBySource`); absent where the listing
   * cannot say. For the sync's one patch of a page stored before the field existed (wave 17, D-8).
   */
  readonly datedBySource?: boolean;
}

/**
 * A reader's access token and when it lapses, handed back beside its cursor so the next batch of
 * the same sync asks for none (X-1 (a); 17-X's F3: half an unchanged SharePoint or Drive read was
 * signing in again at every batch of twenty-five). The sync seals it into the run's stored cursor
 * with the deployment's credential key and drops it at the sync's end; a reader never puts it in
 * its cursor, a log line or an unread reason.
 */
export interface ReaderToken {
  readonly token: string;
  /** When the provider said it lapses, in epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * How long before its expiry a token is no longer used for a batch: a batch of twenty-five pages
 * may take a minute or two, and a token that lapsed inside it would fail it.
 */
export const READER_TOKEN_MARGIN_MS = 2 * 60 * 1000;

/**
 * Whether a token still serves a batch begun now: the sync hands none past this, and a reader
 * handed one past it asks for another.
 *
 * @param token - The token and its expiry.
 * @param now - The time the batch begins, in epoch milliseconds.
 */
export function readerTokenServes(token: ReaderToken, now: number): boolean {
  return token.expiresAt - READER_TOKEN_MARGIN_MS > now;
}

/** One bounded batch: the pages read, the listed pages that could not be, and the continuation. */
export interface ReadPageBatch extends DocPageBatch {
  readonly unread: readonly UnreadPage[];
  /**
   * The listed pages whose revision is the one they were stored with, kept as stored with no
   * body read (X-13). Bounded by the listing page, not by the batch's limit, which counts the
   * pages read and unread only.
   */
  readonly kept?: readonly KeptPage[];
  /**
   * Set when the source refused the walk of its archived or deleted pages (a 4xx on it): the
   * pages an earlier walk archived are not listed, and stand as stored rather than being pruned
   * as gone (W15-R30).
   */
  readonly archivedWalkRefused?: boolean;
  /**
   * The token this batch asked its provider for, for the next batch of the sync (X-1). None where
   * the batch used the token it was handed, which the sync keeps, or the reader signs in by no
   * token of its own.
   */
  readonly token?: ReaderToken;
}

/** A documentation reader whose batches name the pages they could not read. */
export interface DocumentationReader extends DocSourceReader {
  listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
    /** The sync's stored revisions, for a reader that keeps an unchanged page by its own (X-13). */
    stored?: StoredRevisions,
    /** The token an earlier batch of this sync handed back, to read with instead of a new one. */
    token?: ReaderToken,
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

/** A cursor `listingCursor` made: an offset bound to the digest of the listing it continues. */
const LISTING_CURSOR = /^(0|[1-9][0-9]*)@([0-9a-z]{7})$/;

/**
 * Whether a cursor is one `listingCursor` made, so a resume can check it
 * against the listing it continues; a provider's own cursor or a bare offset
 * cannot be checked.
 *
 * @param cursor - A run's cursor.
 */
export function isListingCursor(cursor: string): boolean {
  return LISTING_CURSOR.test(cursor);
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
  const match = LISTING_CURSOR.exec(cursor);
  if (!match || match[2] !== listingDigest(listing)) throw new ListingChangedError();
  return Number(match[1]);
}

/**
 * The sync's side of the reader contract by revision (`StoredRevisions`), as far as a reader sees
 * it: what each page was stored with, answered for the refs a listing names, and one whole read of
 * a source in the sync's own batches.
 *
 * The store here is a map a test holds between two reads. It takes what `docPages` takes of a
 * page the sync stores (its revision, its title, its address) and offers, as
 * `docPages.storedForRevision` does, only a page stored with a revision. The title is the one the
 * sync stores: the page's first level-one heading (`persistPage` in `convex/docSyncActions.ts`),
 * which is not always the title the reader read the page with.
 */
import {
  readerTokenServes,
  type DocumentationReader,
  type KeptPage,
  type ReaderToken,
  type StoredMark,
  type StoredRevisions,
  type UnreadPage,
} from '../../../src/docs/readers/batch';
import { markdownPageTitle } from '../../../src/docs/readers/folder';
import type { DocPage, DocSourceRecord } from '../../../src/docs/types';

/** The most pages the sync reads in one batch (`SYNC_BATCH_SIZE` in `convex/docSyncActions.ts`). */
export const SYNC_BATCH = 25;

/** What a source's pages were stored with, by ref. */
export type StoredMarks = Map<string, StoredMark>;

/** What one whole read of a source gave. */
export interface WholeRead {
  /** The pages whose bodies were read, in reading order. */
  readonly read: DocPage[];
  /** The pages kept as stored by their revision. */
  readonly kept: KeptPage[];
  readonly unread: UnreadPage[];
  readonly batches: number;
  /** The refs each call of the contract asked about, in order. */
  readonly asked: string[][];
  /** The tokens the batches handed back, in order (X-1). */
  readonly handedBack: ReaderToken[];
}

/** How a whole read runs: the batch's size and the clock the sync reads a token's expiry by. */
export interface WholeReadOptions {
  /** The batch's size; the sync's own by default. */
  readonly limit?: number;
  /** The sync's clock; the reader's own should be the same one. `Date.now` by default. */
  readonly now?: () => number;
}

/** The contract's answer from a store: the mark of each ref it holds. */
export function storedIn(marks: StoredMarks, asked: string[][] = []): StoredRevisions {
  return async (refs: readonly string[]): Promise<ReadonlyMap<string, StoredMark>> => {
    asked.push([...refs]);
    return new Map(
      refs.flatMap((ref): Array<[string, StoredMark]> => {
        const mark = marks.get(ref);
        return mark === undefined ? [] : [[ref, mark]];
      }),
    );
  };
}

/**
 * Read a source whole, a batch at a time, answering the contract from the store, storing each
 * page read and carrying the reader's token from batch to batch as the sync does (X-1: one handed
 * back replaces the one held, none handed back keeps it, and none is handed past its margin).
 *
 * @param marks - What earlier reads stored; each page this read reads is stored into it.
 * @param options - The batch's size and the sync's clock.
 */
export async function readWhole(
  reader: DocumentationReader,
  source: DocSourceRecord,
  secret: string,
  marks: StoredMarks,
  options: WholeReadOptions = {},
): Promise<WholeRead> {
  const limit = options.limit ?? SYNC_BATCH;
  const now = options.now ?? Date.now;
  const whole: WholeRead = {
    read: [],
    kept: [],
    unread: [],
    batches: 0,
    asked: [],
    handedBack: [],
  };
  let cursor: string | undefined;
  let token: ReaderToken | undefined;
  let batches = 0;
  do {
    const handed = token !== undefined && readerTokenServes(token, now()) ? token : undefined;
    const batch = await reader.listPageBatch(
      source,
      secret,
      cursor,
      limit,
      storedIn(marks, whole.asked),
      handed,
    );
    if (batch.token !== undefined) whole.handedBack.push(batch.token);
    token = batch.token ?? handed;
    if (batch.pages.length + batch.unread.length > limit) {
      throw new Error(`a batch read ${batch.pages.length + batch.unread.length} pages of ${limit}`);
    }
    for (const page of batch.pages) {
      // A page with no revision is stored without one, and is never offered to the contract.
      if (page.sourceRevision === undefined) marks.delete(page.ref);
      else {
        marks.set(page.ref, {
          revision: page.sourceRevision,
          title: markdownPageTitle(page.markdown, page.title),
          ...(page.url === undefined ? {} : { url: page.url }),
        });
      }
    }
    whole.read.push(...batch.pages);
    whole.kept.push(...(batch.kept ?? []));
    whole.unread.push(...batch.unread);
    cursor = batch.nextCursor;
    batches += 1;
  } while (cursor !== undefined);
  return { ...whole, batches };
}

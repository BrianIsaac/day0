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
import type {
  DocumentationReader,
  KeptPage,
  StoredMark,
  StoredRevisions,
  UnreadPage,
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
 * Read a source whole, a batch at a time, answering the contract from the store and storing each
 * page read as the sync does.
 *
 * @param marks - What earlier reads stored; each page this read reads is stored into it.
 * @param limit - The batch's size; the sync's own by default.
 */
export async function readWhole(
  reader: DocumentationReader,
  source: DocSourceRecord,
  secret: string,
  marks: StoredMarks,
  limit: number = SYNC_BATCH,
): Promise<WholeRead> {
  const whole: WholeRead = { read: [], kept: [], unread: [], batches: 0, asked: [] };
  let cursor: string | undefined;
  let batches = 0;
  do {
    const batch = await reader.listPageBatch(
      source,
      secret,
      cursor,
      limit,
      storedIn(marks, whole.asked),
    );
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

/**
 * When a documentation sync stops reading a listing that does not end (W15-R8).
 *
 * A reader asks its provider for a listing a part at a time and reads on while the provider says
 * more follows. A provider that answers a later part with an earlier one (a cursor that cycles, a
 * server that ignores the offset it is given, a total that overstates the listing) says so for
 * ever, and the sync would run at the provider's rate limit without finishing. No reader can see
 * that from one batch, so the sync's run counts what its listing has done and the driver stops
 * it here, for every reader alike.
 *
 * Two bounds. A listing that has named pages it had already named, at least
 * `RELISTED_PAGES_FLOOR` of them and at least as many as it named for the first time, is
 * repeating itself: a listing edited mid-walk names a few pages twice, never most of them. And
 * a listing that names nothing new (empty parts under a cursor that cycles) is stopped by the
 * count of parts alone, set well above what a real library asks for: a Drive tree is read a
 * folder a part, so its parts number its folders.
 */

/** The most parts of a listing one sync reads: 100,000 pages at 25 a part, or 4,000 folders. */
export const MAX_SYNC_BATCHES = 4_000;

/** How many already-named pages a listing may name again before the share of them is read. */
export const RELISTED_PAGES_FLOOR = 200;

/** What a run has counted of its listing so far; a count absent on an older run reads as none. */
export interface ListingProgress {
  /** The parts of the listing read. */
  readonly batches?: number;
  /** The page refs the parts named, a page named twice counted twice. */
  readonly pagesListed?: number;
  /** How many of those refs the listing had already named. */
  readonly relisted?: number;
}

/** What follows either reason: what is kept, what happens next, and who to tell. */
const AFTERWARDS =
  'This sync stopped, and the pages already stored stay. The next sync reads the source again ' +
  'from its first page; if it stops the same way, tell the Day0 maintainers which source it is.';

/**
 * Why a run must stop reading its listing, or undefined while it may read on.
 *
 * @param run - The run's counts before its next part is asked for.
 * @returns The reason as the source's card says it.
 */
export function listingOverrun(run: ListingProgress): string | undefined {
  const relisted = run.relisted ?? 0;
  if (relisted >= RELISTED_PAGES_FLOOR && relisted * 2 >= (run.pagesListed ?? 0)) {
    return (
      `The source's listing did not end: it named ${relisted.toLocaleString('en-GB')} pages this ` +
      'sync had already read, as a provider does when it answers a later part of a listing with ' +
      `an earlier one. ${AFTERWARDS}`
    );
  }
  if ((run.batches ?? 0) >= MAX_SYNC_BATCHES) {
    return (
      `The source's listing did not end within the ${MAX_SYNC_BATCHES.toLocaleString('en-GB')} ` +
      `parts Day0 reads of one listing in a sync, so this sync stopped, and the pages already ` +
      `stored stay. ${AFTERWARDS.slice(AFTERWARDS.indexOf('The next sync'))}`
    );
  }
  return undefined;
}

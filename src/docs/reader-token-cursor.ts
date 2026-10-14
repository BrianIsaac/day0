/*
 * A sync's stored cursor with the reader's token sealed into it (wave 18, 18-D; X-1 (a), the
 * stored half of 17-X's F3). A contract reader (SharePoint, Drive) asked its provider for a token
 * at every batch of twenty-five, half the requests of an unchanged library. The reader hands its
 * token and expiry back beside its cursor; the sync seals them with the deployment's credential
 * key (`docSyncActions`) and keeps them here, in the run's stored cursor and the next batch's
 * argument, so no schema line holds a token beside the run's other fields. Opened for the next
 * batch only; never logged, never in an event or the export; dropped at the sync's end, which
 * stores no token in a run's cursor (the finish's cursor holds none, and a run that ends short or
 * is overtaken keeps only the reader's place).
 *
 * Pure strings, no crypto: the page store reads the form to drop the token, and the sealing is
 * the action's. The form starts with the NUL Day0 reserves (a reader's cursor never does), so no
 * reader cursor reads as it, and the reader's own cursor follows the sealed part, after a second
 * NUL, as it was.
 */

/** What starts a stored cursor with a sealed token in it. */
export const READER_TOKEN_CURSOR = '\u0000token:';

/** A stored cursor taken apart: the reader's own cursor, and its sealed token, if one rides. */
export interface StoredCursorParts {
  readonly cursor: string | undefined;
  readonly sealed?: string;
}

/**
 * A reader's cursor with its sealed token beside it, as the run stores it.
 *
 * @param cursor - The reader's cursor, as it returned it.
 * @param sealed - The token as the sync sealed it: never holding a NUL.
 * @throws Error when the sealed form holds a NUL, which would make the form ambiguous.
 */
export function cursorWithToken(cursor: string, sealed: string): string {
  if (sealed.includes('\u0000')) throw new Error('A sealed reader token holds no NUL.');
  return `${READER_TOKEN_CURSOR}${sealed}\u0000${cursor}`;
}

/**
 * A stored cursor taken apart. A cursor with no token in it is the reader's own, unchanged.
 *
 * @param stored - The run's stored cursor, or a batch's argument.
 */
export function storedCursorParts(stored: string | undefined): StoredCursorParts {
  if (stored === undefined || !stored.startsWith(READER_TOKEN_CURSOR)) return { cursor: stored };
  const rest = stored.slice(READER_TOKEN_CURSOR.length);
  const end = rest.indexOf('\u0000');
  // A form cut short holds no place a reader gave: read from the start, as with none.
  if (end < 0) return { cursor: undefined };
  return { cursor: rest.slice(end + 1), sealed: rest.slice(0, end) };
}

/**
 * A stored cursor with its token dropped: the reader's place alone, for a run that ended.
 *
 * @param stored - The run's stored cursor.
 */
export function withoutReaderToken(stored: string | undefined): string | undefined {
  return storedCursorParts(stored).cursor;
}

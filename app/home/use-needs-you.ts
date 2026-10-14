'use client';

import { useMemo, useState } from 'react';
import { useQueries } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { inboxOfPages } from '@/metrics/needs-you-pages';
import type { NeedsYouInbox } from './types';

/** One page of the inbox as `work.needsYou` answers it. */
export type NeedsYouPage = FunctionReturnType<typeof api.work.needsYou>;

/** How many employees the home asks for a page: as many as one page of the inbox reads. */
const NEEDS_YOU_PAGE = 20;

/** Said when the backend answers a page's cursor again, which would read the same pages for ever. */
export const NEEDS_YOU_CURSOR_REPEATED = 'the inbox answered the same page twice';

/**
 * The cursors of the pages to read, from the pages read so far: each page that answered and is
 * not the last leads to the next, and the walk ends at the first page still on its way. A page
 * asked from a cursor that has since moved (an employee deployed since moves the rest along) leads
 * nowhere: it and the pages after it are read again from where the page before now ends.
 *
 * @param cursors - The cursors read now, the first null.
 * @param pages - Each one's answer: undefined while on its way, an `Error` when refused.
 * @returns The cursors to read, or an `Error` when a page answers a cursor the walk already read.
 */
export function needsYouCursors(
  cursors: ReadonlyArray<string | null>,
  pages: ReadonlyArray<NeedsYouPage | undefined | Error>,
): ReadonlyArray<string | null> | Error {
  const wanted: Array<string | null> = [null];
  for (const [index, page] of pages.entries()) {
    if (cursors[index] !== wanted[index]) break;
    if (page === undefined || page instanceof Error || page.isDone) break;
    if (wanted.includes(page.continueCursor)) return new Error(NEEDS_YOU_CURSOR_REPEATED);
    wanted.push(page.continueCursor);
  }
  return wanted;
}

/**
 * The needs-you inbox over every employee, read by pages of twenty to its end (wave 18, 18-F),
 * where it read the newest twenty. Each page is its own subscription through `useQueries`, so a
 * refused read comes back as a value: the inbox reads the most of any card on the page, and an
 * overrun of Convex's read limits must lose the inbox only, not the roster, the office, the month
 * and Reset with it.
 *
 * It answers nothing until every page is in: the newest twenty's entries would read as the whole
 * of what waits. Once it has answered, a read that starts again (a page's continuation moved)
 * keeps the inbox it had until the new one is whole, so the list never empties under the reader.
 *
 * @returns The whole inbox, undefined until the first whole read, or the `Error` a page was
 *   refused with.
 */
export function useNeedsYou(): NeedsYouInbox | undefined | Error {
  const [cursors, setCursors] = useState<ReadonlyArray<string | null>>([null]);
  const queries = useMemo(
    () =>
      Object.fromEntries(
        cursors.map((cursor, index) => [
          `page-${index}`,
          {
            query: api.work.needsYou,
            args: { paginationOpts: { numItems: NEEDS_YOU_PAGE, cursor } },
          },
        ]),
      ),
    [cursors],
  );
  const answered: Record<string, NeedsYouPage | undefined | Error> = useQueries(queries);
  const pages = cursors.map((_, index) => answered[`page-${index}`]);
  const next = needsYouCursors(cursors, pages);
  const refused = pages.find((page): page is Error => page instanceof Error);
  const failed = refused ?? (next instanceof Error ? next : undefined);
  const nextKey = next instanceof Error ? undefined : JSON.stringify(next);
  // The walk's next cursors, kept as state derived while rendering: each change asks one more page
  // or drops the ones a moved continuation made stale, and settles once they answer.
  if (nextKey !== undefined && nextKey !== JSON.stringify(cursors)) {
    setCursors(JSON.parse(nextKey) as Array<string | null>);
  }
  // Whole once every page has answered and the last says it is the last; keyed by what the pages
  // hold, so the inbox keeps its identity while they do.
  const last = pages.at(-1);
  const wholeKey =
    failed === undefined &&
    nextKey === JSON.stringify(cursors) &&
    pages.every((page) => page !== undefined) &&
    last !== undefined &&
    !(last instanceof Error) &&
    last.isDone
      ? JSON.stringify(pages)
      : undefined;
  const whole = useMemo(
    () =>
      wholeKey === undefined
        ? undefined
        : (inboxOfPages(JSON.parse(wholeKey) as NeedsYouPage[]) as NeedsYouInbox),
    [wholeKey],
  );
  // The last whole read, kept as state derived while rendering.
  const [kept, setKept] = useState<NeedsYouInbox | undefined>(undefined);
  if (whole !== undefined && kept !== whole) setKept(whole);
  return failed ?? whole ?? kept;
}

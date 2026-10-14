'use client';

import { useEffect, useState } from 'react';
import { usePaginatedQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { rosterClock } from '@/metrics/roster-clock';
import type { RosterRow } from './types';

/** How many employees the home asks for at a time: as many as one page of the roster reads. */
const ROSTER_PAGE = 20;

/**
 * The owner's whole roster, read by pages to its end (wave 17, 17-F; RM33 (a)), so the home
 * lists, counts and draws every employee an owner holds and not the twenty newest. Each page is
 * its own subscription, so a row still changes under the reader as its employee does.
 *
 * It answers nothing until every page is in: a part of the company would be counted as the
 * whole of it in the page's first line. Once it has answered, a read that starts again (the
 * quarter hour turning, which the roster's day follows: W16-R32) keeps the rows it had until the
 * new ones are whole, so the page never empties under the reader.
 *
 * @param now - The page's clock; at one that is no finite number nothing is asked.
 * @returns Every employee, newest first, or undefined until the first whole read.
 */
export function useRoster(now: number): readonly RosterRow[] | undefined {
  const at = rosterClock(now);
  // A clock that is no finite number asks nothing, and the last whole read stands (W17-R28).
  const { results, status, loadMore } = usePaginatedQuery(
    api.roster.page,
    at === undefined ? 'skip' : { at },
    { initialNumItems: ROSTER_PAGE },
  );
  // The last whole read, kept as state derived while rendering (the paginated read keeps its
  // list's identity until a row changes, so this settles in one more render).
  const [whole, setWhole] = useState<readonly RosterRow[] | undefined>(undefined);
  if (status === 'Exhausted' && whole !== results) setWhole(results);
  useEffect(() => {
    if (status === 'CanLoadMore') loadMore(ROSTER_PAGE);
  }, [status, loadMore]);
  return status === 'Exhausted' ? results : whole;
}

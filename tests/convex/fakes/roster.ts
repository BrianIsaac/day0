import type { TestConvex } from 'convex-test';
import { api } from '../../../convex/_generated/api';
import type { RosterRow } from '../../../convex/roster';
import type schema from '../../../convex/schema';

/*
 * The roster as the home reads it, every page to the end (`roster.page`), for the tests that read
 * an owner's rows. `agents.rosterForUser`, which answered the twenty newest in one read, is gone
 * since 0.22.0 (wave 18, F-1), and its tests read the page the home has read since wave 17.
 */

/** A caller of the harness: the harness itself, or the harness under an identity. */
export type RosterCaller = Pick<TestConvex<typeof schema>, 'query'>;

/**
 * Every row of the caller's roster, newest first, read page by page at the caller's clock.
 *
 * @param caller - The harness, under the identity whose roster is read.
 * @returns The rows of every page, in the order the pages answered them.
 */
export async function rosterRows(caller: RosterCaller): Promise<RosterRow[]> {
  const rows: RosterRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const read: { page: RosterRow[]; isDone: boolean; continueCursor: string } = await caller.query(
      api.roster.page,
      {
        paginationOpts: { numItems: 20, cursor },
        at: Date.now(),
      },
    );
    rows.push(...read.page);
    if (read.isDone) return rows;
    cursor = read.continueCursor;
  }
}

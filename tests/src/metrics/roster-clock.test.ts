import { describe, expect, it } from 'vitest';
import { rosterClock, ROSTER_CLOCK_STEP_MS } from '../../../src/metrics/roster-clock';

/*
 * The step itself (the quarter hour every zone's midnight falls on) is tested with the query that
 * reads at it, in `tests/convex/roster.test.ts`.
 */

describe('the clock the roster is asked at', (): void => {
  it('is never before the calendar’s first instant, so a machine whose clock reads earlier still gets a roster (the second pass, 17-F)', (): void => {
    // The backend refuses a negative instant ("not a time Day0 can place on the calendar"), which
    // the paginated read rethrows and the whole home would show as an error.
    expect(rosterClock(-1)).toBe(0);
    expect(rosterClock(Date.parse('1969-12-31T23:59:00Z'))).toBe(0);
    expect(rosterClock(0)).toBe(0);
    expect(rosterClock(ROSTER_CLOCK_STEP_MS + 1)).toBe(ROSTER_CLOCK_STEP_MS);
  });
});

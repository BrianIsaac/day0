/**
 * The viewer's clock as the roster is asked at it (wave 17, 17-F; W16-R32). The roster's day and
 * month are each employee's own, in its zone, and a cached query reads no clock that moves: the
 * page sends its own, rounded down to a step, so the roster is read again when the step turns and
 * not on every tick.
 */

/**
 * The step: a quarter hour, the finest one any zone's midnight falls on (every zone is a whole
 * number of quarter hours from UTC), so a day that turns in any employee's zone turns the step.
 */
export const ROSTER_CLOCK_STEP_MS = 15 * 60_000;

/**
 * The last step at or before a moment, never before the calendar's first instant: a machine whose
 * clock reads earlier than 1970 is asked for the roster at that instant, where the backend would
 * refuse the read and the home would show nothing. A clock that is no finite number (`NaN`,
 * either infinity) has no step and is refused here, before the call: the backend would refuse it
 * and the paginated read rethrow its refusal into the page (W17-R28).
 *
 * @param now - The viewer's clock.
 * @returns The step to ask at, or undefined for a clock that is no finite number.
 */
export function rosterClock(now: number): number | undefined {
  if (!Number.isFinite(now)) return undefined;
  return Math.max(0, Math.floor(now / ROSTER_CLOCK_STEP_MS) * ROSTER_CLOCK_STEP_MS);
}

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
 * The last step at or before a moment.
 *
 * @param now - The viewer's clock.
 */
export function rosterClock(now: number): number {
  return Math.floor(now / ROSTER_CLOCK_STEP_MS) * ROSTER_CLOCK_STEP_MS;
}

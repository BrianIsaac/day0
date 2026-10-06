/**
 * How the seeding of an approved charter stands, for the Work tab and the check that runs past
 * the platform's limit (wave 13, 12-J item 6): the attempts, their waits, and what the manager is
 * told when the queue is empty because the seeding did not finish.
 */

/** How many times the seeding of an approved charter is tried before it stops for the manager. */
export const CHARTER_SEEDING_ATTEMPTS = 3;

/** The wait before the next try, times the attempt that failed. */
export const CHARTER_SEEDING_RETRY_MS = 60_000;

/**
 * When an attempt is checked: past the ten minutes Convex gives an action, so an attempt still
 * unrecorded then was ended by the platform, whose kill runs no `catch` (option B).
 */
export const CHARTER_SEEDING_CHECK_MS = 11 * 60 * 1000;

/** The reason the check records for an attempt the platform ended. */
export const SEEDING_DID_NOT_FINISH = 'it ran past the 10 minutes it is given';

/** One event the standing is read from, newest first. */
export type SeedingEvent =
  | {
      readonly type: 'charter.seeding-failed';
      readonly charterId: string;
      readonly reason: string;
      readonly retrying: boolean;
    }
  | { readonly type: 'charter.seeding-requested'; readonly charterId: string }
  | { readonly type: 'charter.seeded'; readonly charterId: string }
  | { readonly type: 'work.charter-derived' };

/**
 * How the seeding of the approved charter stands: `finding` once the manager asked for it again
 * and nothing has answered yet, `retrying` while a failed attempt waits for the next, `stopped`
 * once the last attempt failed; absent when the seeding finished or never failed.
 */
export type SeedingStanding =
  | { readonly state: 'finding' }
  | { readonly state: 'retrying'; readonly reason: string }
  | { readonly state: 'stopped'; readonly reason: string };

/**
 * Read the standing from the employee's seeding events, newest first: the newest one about the
 * charter decides, and a seeding that finished after it (`work.charter-derived`) clears it.
 *
 * @param events - The seeding events, newest first.
 * @param charterId - The approved charter whose seeding is read.
 * @returns The standing, or undefined when nothing is wrong.
 */
export function seedingStanding(
  events: readonly SeedingEvent[],
  charterId: string,
): SeedingStanding | undefined {
  const newest = events.find(
    (event) => event.type === 'work.charter-derived' || event.charterId === charterId,
  );
  if (
    newest === undefined ||
    newest.type === 'work.charter-derived' ||
    newest.type === 'charter.seeded'
  ) {
    return undefined;
  }
  if (newest.type === 'charter.seeding-requested') return { state: 'finding' };
  return newest.retrying
    ? { state: 'retrying', reason: newest.reason }
    : { state: 'stopped', reason: newest.reason };
}

/** A model call's own label before its error ("agentJson(day0-work-generator): "). */
const CALL_LABEL = /^agentJson\([^)]*\):\s*/;

/** The model client's budget error ("the model call reached its 300000ms budget"). */
const BUDGET_SPENT = /the model call reached its (\d+)ms budget/;

/**
 * A seeding's recorded reason as the manager reads it (the bed): a model call that ran out of time
 * in minutes, and any other error without the call's own label.
 *
 * @param reason - The reason the failure recorded.
 */
function reasonWords(reason: string): string {
  const budget = BUDGET_SPENT.exec(reason);
  if (budget)
    return `the model did not answer within ${Math.round(Number(budget[1]) / 60_000)} minutes`;
  return reason.replace(CALL_LABEL, '');
}

/**
 * What the empty Work tab says of a seeding that did not finish (12-FX's "an empty queue with
 * nothing said").
 *
 * @param standing - The seeding's standing.
 * @param name - The employee's name.
 * @returns The line.
 */
export function seedingLine(standing: SeedingStanding, name: string): string {
  switch (standing.state) {
    case 'finding':
      return `Day0 is finding work for ${name} again. It appears here as it is found.`;
    case 'retrying':
      return `Finding work for ${name} did not finish: ${reasonWords(standing.reason)}. Day0 tries again shortly.`;
    case 'stopped':
      return `Day0 could not find work for ${name}: ${reasonWords(standing.reason)}.`;
    default: {
      const unknown: never = standing;
      throw new Error(`unhandled seeding standing ${String(unknown)}`);
    }
  }
}

/** The refusal of "Find work again" while a seeding is still being tried. */
export function stillFindingWork(name: string): string {
  return `Day0 is still finding work for ${name}.`;
}

/** The refusal of "Find work again" when no seeding failed: it finished, or it is under way. */
export function nothingToFindAgain(name: string): string {
  return `Finding work for ${name} did not fail: there is nothing to try again.`;
}

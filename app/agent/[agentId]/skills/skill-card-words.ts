import { MAX_AUTHORING_ATTEMPTS } from '@/work/skill-library';

/*
 * The Skills tab's words for the five controls (10-C; the prototype's `agent-skills.html`): how
 * often a skill was used, the attempt a failed draft is on, why a skill is due a re-check, a
 * revision written beside the running version, and what a retire or a withdrawal did.
 */

/**
 * How often a skill was used, as the registered row's meta line says it ("used 1 time").
 *
 * @param count - The execution claims that named the row (`useCount`).
 */
export function usedTimes(count: number | undefined): string {
  if (count === undefined || count <= 0) return 'not used yet';
  return `used ${count} ${count === 1 ? 'time' : 'times'}`;
}

/**
 * The attempt a failed draft is on ("Attempt 2 of 3"), or nothing for a row the count predates.
 * A row past the limit (written before Retry was withdrawn) is counted rather than capped.
 *
 * @param attempts - The authoring attempts the row counted (`authoringAttempts`).
 */
export function attemptLine(attempts: number | undefined): string | undefined {
  if (attempts === undefined || attempts < 1) return undefined;
  if (attempts > MAX_AUTHORING_ATTEMPTS) return `${attempts} attempts`;
  return `Attempt ${attempts} of ${MAX_AUTHORING_ATTEMPTS}`;
}

/** A reason as a sentence: capitalised, with one full stop. */
function sentence(reason: string): string {
  const trimmed = reason.trim().replace(/[.!?]+$/, '');
  return `${trimmed.charAt(0).toLocaleUpperCase('en-GB')}${trimmed.slice(1)}.`;
}

/**
 * Why a registered skill is due a re-check, and the prototype's rule that the employee keeps
 * running what was verified meanwhile.
 *
 * @param reason - The stamp's reason (`recheckReason`).
 * @param employee - The employee's name.
 */
export function recheckSentence(reason: string, employee: string): string {
  return `${sentence(reason)} ${employee} keeps running the verified version until it is re-checked.`;
}

/**
 * What a registered row says while its revision is written beside it.
 *
 * @param employee - The employee's name.
 */
export function revisionSentence(employee: string): string {
  return `A revision is being written. ${employee} keeps running this version until the new one registers.`;
}

/**
 * What an unregistered revision row says: what it replaces and that the old version runs on.
 *
 * @param employee - The employee's name.
 */
export function revisionRowSentence(employee: string): string {
  return `A revision of a registered skill. ${employee} keeps running the registered version until this one registers.`;
}

/**
 * Why a failed draft offers no Retry: its attempts are spent, so the manager's move is Give up.
 *
 * @param revision - Whether the row is a revision, whose Give up leaves the registered version
 *   running rather than cancelling work.
 */
export function attemptsSpentSentence(revision: boolean): string {
  const giveUp = revision
    ? 'Give up ends this revision; the registered version keeps running.'
    : 'Give up ends the skill and cancels the work waiting for it, with the reason.';
  return `All ${MAX_AUTHORING_ATTEMPTS} attempts failed, so Retry is withdrawn. ${giveUp}`;
}

/**
 * What the live region says once a Give up lands.
 *
 * @param skill - The skill's name.
 * @param cancelled - The waiting items it cancelled.
 */
export function givenUpOutcome(skill: string, cancelled: number): string {
  if (cancelled === 0) return `${skill} is given up.`;
  return `${skill} is given up; ${cancelled} waiting ${cancelled === 1 ? 'item is' : 'items are'} cancelled.`;
}

/**
 * What the live region says once a re-check is on its way.
 *
 * @param skill - The skill's name.
 */
export function recheckStartedOutcome(skill: string): string {
  return `${skill} is being re-checked in the sandbox; it keeps running meanwhile.`;
}

/**
 * What the live region says once a Retire lands.
 *
 * @param skill - The skill's name.
 * @param employee - The employee it was retired from.
 * @param returned - The approved items that went back to waiting for a skill.
 */
export function retireOutcome(skill: string, employee: string, returned: number): string {
  const retired = `${skill} is retired from ${employee}.`;
  if (returned === 0) return retired;
  return `${retired} ${returned} approved ${returned === 1 ? 'item waits' : 'items wait'} for a skill again.`;
}

/**
 * What the live region says once a withdrawal from every employee lands.
 *
 * @param skill - The skill's name.
 * @param holders - How many employees' copies it retired.
 */
export function withdrawOutcome(skill: string, holders: number): string {
  return `${skill} is withdrawn from ${holders} ${holders === 1 ? 'employee' : 'employees'}.`;
}

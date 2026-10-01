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
 */
export function recheckSentence(reason: string, employee: string): string {
  return `${sentence(reason)} ${employee} keeps running the verified version until it is re-checked.`;
}

/**
 * What a registered row says while its revision is written beside it.
 */
export function revisionSentence(employee: string): string {
  return `A revision is being written. ${employee} keeps running this version until the new one registers.`;
}

/**
 * What an unregistered revision row says: what it replaces and that the old version runs on.
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
  return `All ${MAX_AUTHORING_ATTEMPTS} attempts failed, so Retry is no longer offered. ${giveUp}`;
}

/**
 * What the live region says once a Give up lands.
 *
 * @param cancelled - The waiting items it cancelled.
 */
export function givenUpOutcome(skill: string, cancelled: number): string {
  if (cancelled === 0) return `${skill} is given up.`;
  return `${skill} is given up; ${cancelled} waiting ${cancelled === 1 ? 'item is' : 'items are'} cancelled.`;
}

/**
 * What the live region says once a revision is opened and its writing has begun (the wave 10
 * review, C-m2).
 *
 * @param skill - The skill's name.
 * @param employee - The employee who keeps running the current version.
 */
export function revisionStartedOutcome(skill: string, employee: string): string {
  return `A revision of ${skill} is being written. ${employee} keeps running this version until the new one registers.`;
}

/**
 * What the live region says once a re-check is on its way.
 */
export function recheckStartedOutcome(skill: string): string {
  return `A re-check of ${skill} was asked for. It keeps running unless the check fails.`;
}

/**
 * What the live region says once a Retire lands.
 *
 * @param employee - The employee it was retired from.
 * @param returned - The approved items that went back to waiting for a skill.
 */
export function retireOutcome(skill: string, employee: string, returned: number): string {
  const retired = `${skill} is retired from ${employee}.`;
  if (returned === 0) return retired;
  return `${retired} ${returned} approved ${returned === 1 ? 'item waits' : 'items wait'} for a skill again.`;
}

/** What a withdrawal from every employee did, as `skillControls.withdraw` answers. */
export interface WithdrawResult {
  /** How many employees' copies it retired. */
  readonly holders: number;
  /** The approved items that went back to waiting for a skill, theirs together. */
  readonly returnedItems: number;
  /** The runs of the version already under way that it stopped. */
  readonly stoppedRuns: number;
}

/**
 * What the live region says once a withdrawal from every employee lands.
 *
 * @param result - What the withdrawal did.
 */
export function withdrawOutcome(skill: string, result: WithdrawResult): string {
  const { holders, returnedItems, stoppedRuns } = result;
  const sentences = [
    `${skill} is withdrawn from ${holders} ${holders === 1 ? 'employee' : 'employees'}.`,
  ];
  if (returnedItems > 0) {
    sentences.push(
      `${returnedItems} approved ${returnedItems === 1 ? 'item waits' : 'items wait'} for a skill again.`,
    );
  }
  if (stoppedRuns > 0) {
    sentences.push(
      `${stoppedRuns} ${stoppedRuns === 1 ? 'run under way was' : 'runs under way were'} stopped.`,
    );
  }
  return sentences.join(' ');
}

/** Who a Retire or a Withdraw takes the skill from, as the dialog's sentence says it. */
export interface RetireDialogFacts {
  /** Withdraw for every employee, rather than Retire from one. */
  readonly every: boolean;
  /** The employee whose card the dialog was opened on. */
  readonly employee: string;
  /** Every employee who runs the version, that employee first. */
  readonly runners: readonly string[];
  /** Whether a revision of the row is being written, which the retire ends. */
  readonly revisionOpen: boolean;
  /** Whether the employee's autonomous actions are on, so a run's writes apply unasked. */
  readonly autonomous: boolean;
}

/**
 * The Retire dialog's sentence under its question: who stops running the skill and what becomes
 * of a run of it already under way (decision 3: a Withdraw stops it, a Retire lets it finish),
 * then of the approved work that would have used it.
 *
 * @param facts - The choice and the employees it reaches.
 */
export function retireDialogDescription(facts: RetireDialogFacts): string {
  const { every, employee, runners, revisionOpen, autonomous } = facts;
  const who = every
    ? `${namesInWords(runners)} stop running this skill now, and a run of it already under way is stopped.`
    : `${employee} stops running this skill now. A run of it already under way finishes, and ${
        autonomous
          ? 'with autonomous actions on its writes apply without waiting for you.'
          : 'its writes still wait for you.'
      }`;
  const work =
    'Approved work that would have used it goes back to waiting for a skill, and a new one is proposed for it.';
  return [who, work, ...(revisionOpen ? ['The revision being written for it ends too.'] : [])].join(
    ' ',
  );
}

/** How a list of names is joined, as a British sentence joins it. */
const NAME_LIST = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });

/**
 * The employees in a list as a sentence names them ("Mira, Tomas and Aiko").
 *
 * @param names - The employees' names, in the order said.
 */
export function namesInWords(names: readonly string[]): string {
  return NAME_LIST.format(names);
}

import type { Doc } from '../../convex/_generated/dataModel';
import { characterCount } from '../lib/visible-text';

/*
 * The per-employee pause (wave 12, 12-P; G1 / A15): the manager holds one employee. A paused
 * employee takes no intake and starts no step; every decision it already asked stays answerable,
 * and the step an approval queues waits for the resume. The fields are on the agent row
 * (`pausedAt`, `pausedBy`, `pauseReason`), orthogonal to its state: an absent `pausedAt` reads as
 * running.
 */

/** The most characters a pause's reason may carry: it is printed on the record and the card. */
export const PAUSE_REASON_MAX_CHARS = 280;

/** Why a pause was refused: its reason is past {@link PAUSE_REASON_MAX_CHARS}. */
export const PAUSE_REASON_TOO_LONG = `A reason for a pause can be at most ${PAUSE_REASON_MAX_CHARS} characters.`;

/**
 * The reason a pause stores: the manager's words trimmed, or none when they are blank.
 *
 * @param reason - What the manager typed, if anything.
 */
export function pauseReasonOf(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Whether a stored reason is within {@link PAUSE_REASON_MAX_CHARS}, counted as the reader sees it.
 *
 * @param reason - The trimmed reason ({@link pauseReasonOf}).
 */
export function isPauseReasonWithinBound(reason: string): boolean {
  return characterCount(reason) <= PAUSE_REASON_MAX_CHARS;
}

/**
 * Whether the employee is paused.
 *
 * @param agent - The agent row's pause stamp.
 */
export function isPaused(agent: Readonly<Pick<Doc<'agents'>, 'pausedAt'>>): boolean {
  return agent.pausedAt !== undefined;
}
/** Why a step did not start: the employee is paused (a claim's refusal, as a handover's is). */
export const EMPLOYEE_PAUSED_REASON = 'the employee is paused, so no new step starts';

/**
 * Why a step did not start while the deployment's scheduled work is paused (`DAY0_CRONS_PAUSED`).
 *
 * @param cronsReason - The reason the deployment's switch carries.
 */
export function cronsPausedStepReason(cronsReason: string): string {
  return `the deployment's scheduled work is paused (${cronsReason}), so no new step starts`;
}

/**
 * Why a step of this employee may not start now, or undefined when it may: the employee's own
 * pause first, then the deployment's. Both hold a step at its next gate and leave its row in the
 * state it was ready in, so the sweep, or the resume, queues it again.
 *
 * @param agent - The employee's pause stamp, or null when the row is gone (nothing to hold).
 * @param cronsReason - The deployment switch's reason (`cronsPauseReason`), undefined while it runs.
 */
export function stepHoldReason(
  agent: Readonly<Pick<Doc<'agents'>, 'pausedAt'>> | null,
  cronsReason: string | undefined,
): string | undefined {
  if (agent !== null && isPaused(agent)) return EMPLOYEE_PAUSED_REASON;
  if (cronsReason !== undefined) return cronsPausedStepReason(cronsReason);
  return undefined;
}

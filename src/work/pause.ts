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

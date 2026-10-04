/**
 * Whether the work was done, as the run says it (wave 12, 12-D; decision D-1 (b)).
 *
 * On 4 October the hosted demo closed two of three first ticket runs as done while their own
 * comments said the work could not be done. A detector of words (`./not-done.ts`) was the first
 * fix; the wave's review measured it misreading plain model English both ways (W12-R1). So the run
 * is asked for the fact: the executor's reply and the closing set's carry a required `workDone`
 * (`done`, `partial` or `not-done`) with one line of why, and the status the run sets is held to
 * that answer. A run that answers `partial` or `not-done` never lands a closing state; a run that
 * answers `done` is not sent back for its words alone.
 *
 * The lexical reading stays only as a tripwire: when a run answers `done`, closes the ticket and
 * its own words flatly say the work was not done, the set is sent back once with the sentence
 * named; a run that answers `done` again keeps its close, which then waits for the manager with
 * the sentence beside it. The tripwire never labels a card and never decides a status.
 *
 * Output recorded before v0.16.0 carries no `workDone` (a step in flight across the upgrade, a
 * recorded fixture, a frozen evaluation trace, a card recorded before the release). The rule: such
 * output is read exactly as the release before read it, by the plan-based rule and the lexical
 * reading, and nothing here decides for it.
 */

import { z } from 'zod';
import { isSurfaceTool, parseSurfaceAction, statusChangeTarget } from '../surfaces/policy';
import { isClosingState, notDoneStatements, runOwnWords } from './not-done';
import { type MockAction, WORK_DONE_ANSWERS, type WorkDoneAnswer } from './types';

/** The answer as the model returns it: one of the three, nothing else. */
export const workDoneSchema = z.enum(WORK_DONE_ANSWERS);

/** The one line of why as the model returns it: words, never only whitespace. */
export const workDoneWhySchema = z.string().trim().min(1);

/** A run's answer on its own work, with its one line of why. */
export interface WorkDoneFact {
  readonly workDone: WorkDoneAnswer;
  readonly workDoneWhy: string;
}

const storedFactSchema = z.object({ workDone: workDoneSchema, workDoneWhy: workDoneWhySchema });

/**
 * The run's answer on its own work, validated, from a model reply or a stored output.
 *
 * Both fields must be there and well formed; otherwise the output carries no fact and is read by
 * the rule for output recorded before the release (see the module docblock). The why is folded to
 * one line.
 *
 * @param output - A model reply, or an output as a row stores it.
 * @returns The fact, or undefined when the output carries none.
 */
export function workDoneFactOf(output: unknown): WorkDoneFact | undefined {
  const parsed = storedFactSchema.safeParse(output);
  if (!parsed.success) return undefined;
  return {
    workDone: parsed.data.workDone,
    workDoneWhy: parsed.data.workDoneWhy.replace(/\s+/g, ' '),
  };
}

/** One action that lands a closing state on a ticket, by its index in the set. */
export interface ClosingChange {
  readonly index: number;
  readonly state: string;
}

/**
 * The actions of a set that land a closing state: a mock ticket set to done, or a real issue moved
 * to a state that says the work is finished.
 *
 * @param actions - The set as the run wrote it.
 */
export function closingChanges(actions: readonly MockAction[]): ClosingChange[] {
  return actions.flatMap((action, index): ClosingChange[] => {
    const state =
      action.tool === 'ticket.update'
        ? action.args.status
        : isSurfaceTool(action.tool)
          ? closingTargetOf(action)
          : undefined;
    return state !== undefined && isClosingState(state) ? [{ index, state }] : [];
  });
}

function closingTargetOf(action: MockAction): string | undefined {
  const parsed = parseSurfaceAction(action);
  return parsed.ok ? statusChangeTarget(parsed.action) : undefined;
}

/**
 * The closing state a set lands although the run answers that the work was not all done.
 *
 * @param fact - The run's answer; undefined for output recorded before the release, for which
 *   this decides nothing.
 * @param actions - The set as the run wrote it.
 * @returns The first closing state such a set lands, or undefined when the status agrees.
 */
export function closingAgainstFact(
  fact: WorkDoneFact | undefined,
  actions: readonly MockAction[],
): string | undefined {
  if (fact === undefined || fact.workDone === 'done') return undefined;
  return closingChanges(actions)[0]?.state;
}

/** What the tripwire reads: the run's answer, its words and its set. */
export interface AnsweredRun {
  readonly workDone?: unknown;
  readonly workDoneWhy?: unknown;
  readonly draft?: unknown;
  readonly actions: readonly MockAction[];
}

/**
 * The tripwire: the clause in which a run's own words say the work was not done, when the run
 * answers `done` and its set closes the ticket. The lexical list is the one `notDoneStatements`
 * reads, unchanged.
 *
 * @param run - The run's answer, draft and set.
 * @returns The first such clause, or undefined when the tripwire does not trip.
 */
export function doneAgainstWords(run: AnsweredRun): string | undefined {
  if (workDoneFactOf(run)?.workDone !== 'done') return undefined;
  if (closingChanges(run.actions).length === 0) return undefined;
  return notDoneStatements(runOwnWords({ draft: run.draft, actions: run.actions }))[0];
}

/**
 * The repair turn's instruction when the tripwire trips: the sentence named, and the answer asked
 * for again from what the run did.
 *
 * @param clause - The clause the tripwire read.
 * @param state - The closing state the set lands.
 */
export function doneAgainstWordsIssue(clause: string, state: string): string {
  return `workDone is "done" and the set moves the ticket to ${state}, but your own words say "${clause}". Answer workDone again from what you did: "partial" or "not-done" if any of the work this item asks for was not done, and then leave the ticket open and say in the comment what is left; keep "done" only if every part of it was done`;
}

/** The audit record of a close the tripwire sent to the manager after the run answered done twice. */
export const CLOSE_HELD_AGAINST_WORDS = 'close held for the manager against the run’s own words';

/** Why the gate holds a close the tripwire sent to the manager, whatever the autonomy switch says. */
export const HELD_CLOSE_AGAINST_WORDS =
  'ticket close the run answered done while its own words say otherwise; held for the manager';

/**
 * The clause a stored output's tripwire recorded, validated.
 *
 * @param output - An output as a row stores it.
 */
export function closeAgainstWordsOf(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const clause = (output as { closeAgainstWords?: unknown }).closeAgainstWords;
  return typeof clause === 'string' && clause.trim() !== '' ? clause : undefined;
}

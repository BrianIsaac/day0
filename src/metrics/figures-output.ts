import { workDoneFactOf } from '../work/work-done';

/*
 * What one employee's figures read of a run's output (wave 18, 18-F; C1): the figures of an
 * employee whose records pass what one function may read are read by pages from an action, and
 * each page hands the action its rows with their outputs cut to the parts the figures read, so the
 * action never holds a run's notes or a long draft it does not count.
 */

/**
 * What `metrics:forAgent` refuses with when an employee's records pass what one read of them may
 * hold: the page then reads them by pages (`metrics:forAgentByPages`). A client compares the
 * refusal's data to this sentence.
 */
export const FIGURES_READ_BY_PAGES =
  'This employee’s records are more than one read of its figures holds, so they are read by pages.';

/** The parts of a phase's ledger the figures read: what was asked for and what landed. */
function ledgerOf(phase: unknown): Record<string, unknown> | undefined {
  if (typeof phase !== 'object' || phase === null) return undefined;
  const { actions, applied } = phase as Record<string, unknown>;
  return {
    ...(actions !== undefined ? { actions } : {}),
    ...(applied !== undefined ? { applied } : {}),
  };
}

/**
 * A run's output with only what an employee's figures read of it: both phases' actions and
 * ledgers, the reads a failed re-read attempted, the writes carried from earlier runs, the writes
 * withheld, and the run's answer on its own work with the ledger's reading of it; the draft only
 * where the output carries no answer, since an output recorded before the answer (v0.16.0) is read
 * as not done by its own words. Everything else (the notes, the questions, the trails, the
 * repairs) is left out: no figure reads it. Anything that is not an object is kept as it is.
 *
 * @param output - A finished run's output, as a work row or its `work.completed` event stores it.
 * @returns The output the figures read the same figures from.
 */
export function outputForFigures(output: unknown): unknown {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return output;
  const run = output as Record<string, unknown>;
  const kept: Record<string, unknown> = { ...ledgerOf(run) };
  const initial = ledgerOf(run.initial);
  if (initial !== undefined) kept.initial = initial;
  const failedReread = ledgerOf(run.failedReread);
  if (failedReread !== undefined) kept.failedReread = failedReread;
  for (const key of [
    'landedWrites',
    'withheldActions',
    'workDone',
    'workDoneWhy',
    'workDoneSaid',
  ]) {
    if (run[key] !== undefined) kept[key] = run[key];
  }
  if (workDoneFactOf(output) === undefined && run.draft !== undefined) kept.draft = run.draft;
  return kept;
}

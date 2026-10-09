import type { Doc } from './_generated/dataModel';
import { normaliseActionVerdict, type ActionVerdict } from '../src/surfaces/policy';
import type { AppliedAction } from '../src/surfaces/types';

/*
 * A run's ledger as a work item stores it (the wave 14 review's D-6, the standard's 9.2): the
 * verdicts read one per action and the actions and applied rows read off a run's output, moved out
 * of `convex/work.ts` unchanged. This module sits below `convex/work.ts`: `convex/work.ts` imports
 * it and it never imports `./work`, so the move closes no import cycle. It registers no function.
 */

/**
 * The persisted verdicts in the current shape, by action index.
 *
 * Args:
 *   verdicts: The verdicts persisted when the run was held.
 *
 * Returns:
 *   One verdict per index; an index without one reads as `held`.
 */
export function verdictList(
  verdicts: Doc<'workItems'>['actionVerdicts'] | undefined,
  count: number,
): ActionVerdict[] {
  return Array.from({ length: count }, (_, index) =>
    normaliseActionVerdict(verdicts?.[index] ?? {}),
  );
}

/** The indexes of a run's actions whose verdict has the given disposition, in order. */
export function indexesWith(
  verdicts: readonly ActionVerdict[],
  disposition: ActionVerdict['disposition'],
): number[] {
  return verdicts.flatMap((verdict, index) => (verdict.disposition === disposition ? [index] : []));
}

/**
 * The hold-time reasons of a run's refused rows, keyed by action index.
 *
 * Args:
 *   verdicts: The verdicts persisted when the run was held.
 *   count: How many actions the run holds.
 *
 * Returns:
 *   `[index, reason]` pairs for every refused row.
 */
export function refusedReasonEntries(
  verdicts: Doc<'workItems'>['actionVerdicts'] | undefined,
  count: number,
): Array<[number, string]> {
  return verdictList(verdicts, count).flatMap(
    (verdict, index): Array<[number, string]> =>
      verdict.disposition === 'refused' ? [[index, verdict.reason]] : [],
  );
}

/** A run's literal actions as its output holds them; none when the output has no list. */
export function actionsOf(output: unknown): unknown[] {
  return ((output ?? {}) as { actions?: unknown[] }).actions ?? [];
}

export function ledgerOf(output: unknown): Array<AppliedAction | undefined> {
  return ((output ?? {}) as { applied?: Array<AppliedAction | undefined> }).applied ?? [];
}

/**
 * A run that stops: it ends with nothing landed in the work environment and
 * nothing for the manager to decide. The item is failed, so Retry stands, but
 * the record says "stopped" with the reason, and no message is sent for it;
 * a stop is something to read on the card or in the digest, not a page.
 *
 * A run also stops when the only rows that did not land are ones Day0's own
 * gate refused before sending: nothing is unknown at the provider, the rest of
 * the run went ahead, and the reason says what was refused and what stands.
 * That stop may have landed work, so its landed note is still sent.
 */

import { isGateRefusal, isManagerDm, isSurfaceTool, parseSurfaceAction } from '../surfaces/policy';
import type { AppliedAction, SurfaceRecord } from '../surfaces/types';
import type { MockAction } from './types';
import {
  ledgerPhases,
  providerReconciliationEntries,
  type ReconciliationEntry,
} from './reconciliation';

export const STOPPED_PREFIX = 'stopped: ';

/** The ledger reason on a closing action the run never put to the manager. */
export const WITHHELD_ON_STOP =
  'withheld: the run stopped with nothing landed and nothing for the manager to decide';

/** How the reason of a run cut short by a gate refusal begins, after the stopped prefix. */
export const GATE_REFUSAL_STOP = "Day0's gate refused ";

/** A refused row as the manager reads it: the operation and its surface, never its payload. */
function refusedOperation(action: MockAction | undefined, row: Partial<AppliedAction>): string {
  const parsed = action ? parseSurfaceAction(action) : undefined;
  if (!parsed?.ok) return row.tool ?? 'an action';
  return parsed.action.kind === 'mcp.call'
    ? `${parsed.action.tool} on ${parsed.action.surface}`
    : `${parsed.action.method} ${parsed.action.path} on ${parsed.action.surface}`;
}

/**
 * The reason for a run whose only unlanded rows are ones the gate refused
 * before sending, worded for the manager who has to act on it.
 *
 * Only real surface verbs qualify, so a mock run reads exactly as it did. A
 * provider error or an unknown outcome beside the refusal leaves the run an
 * ordinary failure: something may have happened at the provider, and that is
 * not a stop.
 *
 * Args:
 *   actions: The run's actions, index-aligned with the ledger.
 *   applied: The ledger.
 *
 * Returns:
 *   The stopped reason, or undefined when the run did not end this way.
 */
export function gateRefusalStop(
  actions: readonly MockAction[],
  applied: readonly (Partial<AppliedAction> | undefined)[],
): string | undefined {
  const unlanded = applied.flatMap((row, index) =>
    row && row.ok !== true && row.held !== true ? [{ row, index }] : [],
  );
  if (unlanded.length === 0) return undefined;
  const everyRefused = unlanded.every(
    ({ row }) =>
      row.outcomeUnknown !== true && isSurfaceTool(row.tool ?? '') && isGateRefusal(row.reason),
  );
  if (!everyRefused) return undefined;
  const landed = applied.filter((row) => row?.ok === true && row.held !== true).length;
  const one = unlanded.length === 1;
  const refused = unlanded
    .map(({ row, index }) => `${refusedOperation(actions[index], row)} (${row.reason})`)
    .join('; ');
  const stands =
    landed === 0
      ? 'nothing else landed'
      : `the other ${landed} landed and ${landed === 1 ? 'stays as it is' : 'stay as they are'}`;
  return stoppedReason(
    `${GATE_REFUSAL_STOP}${unlanded.length} of ${applied.length} actions before sending ${one ? 'it' : 'them'}, ` +
      `so the steps that needed ${one ? 'it' : 'them'} were not done; ${stands}. Refused: ${refused}. ` +
      `Retry with a note that changes the step, or do it by hand`,
  );
}

/**
 * Whether a recorded reason is a stop at a gate refusal.
 *
 * Args:
 *   skipReason: The item's recorded reason.
 *
 * Returns:
 *   True for a reason `gateRefusalStop` wrote.
 */
export function isGateRefusalStop(skipReason: string | undefined): boolean {
  return isStopped(skipReason) && stopDetail(skipReason ?? '').startsWith(GATE_REFUSAL_STOP);
}

/**
 * The run's landed work: every landed or outcome-unknown write, except the
 * manager DM, which reports on work and is not work.
 *
 * Args:
 *   output: A run's persisted output, in either of its two shapes.
 *   surfaces: The agent's surfaces, to tell the manager DM from other writes.
 *
 * Returns:
 *   The reconciliation entries that count as work.
 */
export function landedWork(
  output: unknown,
  surfaces: readonly SurfaceRecord[],
): ReconciliationEntry[] {
  const phases = ledgerPhases(output);
  return providerReconciliationEntries(output).filter((entry): boolean => {
    const action = phases.find((phase) => phase.phase === entry.phase)?.actions[entry.actionIndex];
    if (!action) return true;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) return true;
    const surface = surfaces.find((row) => row.slug === parsed.action.surface);
    return !(surface && isManagerDm(parsed.action, surface));
  });
}

/**
 * The recorded reason for a run that stopped.
 *
 * Args:
 *   reason: Why the run could not go on.
 *
 * Returns:
 *   The reason under the stopped prefix, once.
 */
export function stoppedReason(reason: string): string {
  return reason.startsWith(STOPPED_PREFIX) ? reason : `${STOPPED_PREFIX}${reason}`;
}

/**
 * Whether a failed item's reason records a stop.
 *
 * Args:
 *   skipReason: The item's recorded reason.
 *
 * Returns:
 *   True when the run stopped rather than failed after landing work.
 */
export function isStopped(skipReason: string | undefined): boolean {
  return skipReason?.startsWith(STOPPED_PREFIX) === true;
}

/**
 * The stop reason as the manager reads it, without the prefix.
 *
 * Args:
 *   skipReason: The item's recorded reason.
 *
 * Returns:
 *   The reason text, or the input when it is not a stop.
 */
export function stopDetail(skipReason: string): string {
  return isStopped(skipReason) ? skipReason.slice(STOPPED_PREFIX.length) : skipReason;
}

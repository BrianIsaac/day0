/**
 * A run that stops: it ends with nothing landed in the work environment and
 * nothing for the manager to decide. The item is failed, so Retry stands, but
 * the record says "stopped" with the reason, and no message is sent for it;
 * a stop is something to read on the card or in the digest, not a page.
 */

import { isManagerDm, parseSurfaceAction } from '../surfaces/policy';
import type { SurfaceRecord } from '../surfaces/types';
import {
  ledgerPhases,
  providerReconciliationEntries,
  type ReconciliationEntry,
} from './reconciliation';

export const STOPPED_PREFIX = 'stopped: ';

/** The ledger reason on a closing action the run never put to the manager. */
export const WITHHELD_ON_STOP =
  'withheld: the run stopped with nothing landed and nothing for the manager to decide';

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

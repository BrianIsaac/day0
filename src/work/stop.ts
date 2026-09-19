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
 *
 * A READ the gate refused is not such a row: nothing was sent and nothing was
 * to change, so it is dropped with a ledger line and the run goes on without
 * it. A step that needed what it would have read says so in the closing
 * phase, and the promised-read gate still holds a plan to the reads it declared.
 */

import { actionIntent, isGateRefusal, isManagerDm, isSurfaceTool, parseSurfaceAction } from '../surfaces/policy';
import type { AppliedAction, SurfaceRecord } from '../surfaces/types';
import { summariseAction } from '../surfaces/summary';
import type { LandedNoteRow } from './manager-notes';
import type { MockAction, ReplyTarget } from './types';
import {
  ledgerPhases,
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  type ReconciliationEntry,
} from './reconciliation';

export const STOPPED_PREFIX = 'stopped: ';

/** The ledger reason on a closing action the run never put to the manager. */
export const WITHHELD_ON_STOP =
  'withheld: the run stopped with nothing landed and nothing for the manager to decide';

/** How the reason of a run cut short by a gate refusal begins, after the stopped prefix. */
export const GATE_REFUSAL_STOP = "Day0's gate refused ";

/** How the ledger line of a read the gate refused, and the run went on without, begins. */
export const DROPPED_READ_PREFIX =
  "dropped: Day0's gate refused this read before sending it, so nothing was read and the run went on without it: ";

/**
 * The gate's own reason on a dropped read's ledger line.
 *
 * Args:
 *   reason: The reason on a ledger row.
 *
 * Returns:
 *   The refusal the gate gave, or undefined when the row is not a dropped read.
 */
export function droppedReadRefusal(reason: string | undefined): string | undefined {
  if (reason?.startsWith(DROPPED_READ_PREFIX) !== true) return undefined;
  const refusal = reason.slice(DROPPED_READ_PREFIX.length);
  return isGateRefusal(refusal) ? refusal : undefined;
}

/**
 * The ledger with every read the gate refused marked dropped.
 *
 * Only a real surface verb the gate itself refused before sending, whose
 * action parses as a read, is dropped: a refused write still stops the run, a
 * provider's failure and an unknown outcome are untouched, and so is a mock
 * run. The row is kept, accounted for as a held row is (`ok`, `held`), with
 * the gate's reason after the prefix. When no other row of the ledger stands
 * nothing is dropped, because a run that did nothing at all still stops.
 *
 * Args:
 *   actions: The actions, index-aligned with the ledger.
 *   applied: The ledger as the apply left it.
 *
 * Returns:
 *   The ledger, with the refused reads marked; the same rows otherwise.
 */
export function withRefusedReadsDropped<Row extends Partial<AppliedAction>>(
  actions: readonly MockAction[],
  applied: readonly Row[],
): Row[] {
  const refusedRead = (row: Row, index: number): boolean => {
    if (row.ok === true || row.held === true || row.outcomeUnknown === true) return false;
    if (!isSurfaceTool(row.tool ?? '') || !isGateRefusal(row.reason)) return false;
    const action = actions[index];
    const parsed = action ? parseSurfaceAction(action) : undefined;
    return parsed?.ok === true && actionIntent(parsed.action) === 'read';
  };
  if (!applied.some((row, index) => row.ok === true && !refusedRead(row, index))) return [...applied];
  return applied.map((row, index) =>
    refusedRead(row, index)
      ? { ...row, ok: true, held: true, reason: `${DROPPED_READ_PREFIX}${row.reason}` }
      : row,
  );
}

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

/**
 * The run's landed rows as the completion note tells them: every landed or
 * outcome-unknown row in ledger order, reads included, each in a manager's
 * words. The manager DM is left out, as in `landedWork`: it reports on work
 * and is not work.
 *
 * Args:
 *   output: A run's persisted output, in either of its two shapes.
 *   surfaces: The agent's surfaces, for display names and the manager DM.
 *   replyTarget: The thread the work item answers, so a reply to it reads as one.
 *
 * Returns:
 *   One row per landed action, for `landedNoteText`.
 */
export function landedNoteRows(
  output: unknown,
  surfaces: readonly SurfaceRecord[],
  replyTarget?: ReplyTarget,
): LandedNoteRow[] {
  return ledgerPhases(output).flatMap(({ actions, applied }) =>
    applied.flatMap((entry, index): LandedNoteRow[] => {
      const outcomeUnknown = entry.outcomeUnknown === true || entry.reason === OUTCOME_UNKNOWN_REASON;
      if (!outcomeUnknown && (entry.ok !== true || entry.held === true)) return [];
      const action = actions[index];
      const parsed = action ? parseSurfaceAction(action) : undefined;
      const surface = parsed?.ok ? surfaces.find((row) => row.slug === parsed.action.surface) : undefined;
      if (parsed?.ok && surface && isManagerDm(parsed.action, surface)) return [];
      const read = !outcomeUnknown && parsed?.ok === true && actionIntent(parsed.action) !== 'write';
      const line = action
        ? summariseAction(action, surfaces, { replyTarget })
        : typeof entry.tool === 'string'
          ? entry.tool
          : 'unknown action';
      return [{ kind: read ? 'read' : 'write', line, ...(outcomeUnknown ? { outcomeUnknown: true } : {}) }];
    }),
  );
}

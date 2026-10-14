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

import {
  actionIntent,
  isGateRefusal,
  isManagerDm,
  isSurfaceTool,
  parseSurfaceAction,
  type ActionVerdict,
} from '../surfaces/policy';
import type { AppliedAction, SurfaceRecord } from '../surfaces/types';
import { redactTokenShapes } from '../surfaces/redact';
import { summariseAction } from '../surfaces/summary';
import type { LandedNoteRow } from './manager-notes';
import type { MockAction, ReplyTarget } from './types';
import {
  isOutcomeUnknownReason,
  ledgerPhases,
  providerReconciliationEntries,
  type ReconciliationEntry,
} from './reconciliation';

export const STOPPED_PREFIX = 'stopped: ';

/** How a stop the manager made begins, after the stopped prefix (wave 12, 12-W; wording draft). */
export const MANAGER_STOP = 'stopped by the manager';

/** Why a work item is `cancelled` after the manager turned its plan down, before any reason given. */
export const PLAN_CANCELLED_REASON = 'plan cancelled by the manager';

/** A Stop that stopped the run, or took back an approval whose writes had not started. */
export interface StopRunStopped {
  readonly ok: true;
}

/** A Stop that arrived after the item moved on: nothing was stopped and nothing changed. */
export interface StopRunMovedOn {
  readonly ok: false;
  readonly refused: 'moved-on';
}

/**
 * What `workRuns.stopRun` answers. A Stop that meets an item no longer under way is an expected
 * outcome of a manager deciding while the run moves (the v0.16.0 redeploy's finding 4), so it is
 * answered, never thrown: a thrown refusal reaches the browser's console as a server error.
 */
export type StopRunAnswer = StopRunStopped | StopRunMovedOn;

/** The states of a work item the manager can stop: the employee is working it and nothing waits on them. */
export const STOPPABLE_STATES = ['claimed', 'plan-approved', 'executing'] as const;

/** A state `STOPPABLE_STATES` holds. */
export type StoppableState = (typeof STOPPABLE_STATES)[number];

/**
 * Whether the manager can stop an item in this state.
 *
 * @param state - The item's state.
 */
export function isStoppable(state: string): state is StoppableState {
  return (STOPPABLE_STATES as readonly string[]).includes(state);
}

/** What a work item carries that says whether the manager can stop it. */
export interface StopCandidate {
  readonly state: string;
  readonly approvedIndexes?: readonly number[];
  readonly applyAttemptId?: unknown;
}

/**
 * Whether the manager approved a held set whose apply has not claimed it yet: the writes wait, for
 * a moment or for as long as a pause holds them, and none of them has been sent.
 *
 * @param item - The work item.
 */
export function approvedNotStarted(item: StopCandidate): boolean {
  return (
    item.state === 'actions-pending' &&
    item.approvedIndexes !== undefined &&
    item.applyAttemptId === undefined
  );
}

/**
 * Whether the manager can stop a work item as it stands: the employee is working it
 * ({@link isStoppable}), or it holds an approval whose apply has not started
 * ({@link approvedNotStarted}). Stopping that takes the approval back; nothing of it was sent, so
 * no reconciliation is owed (the wave 12 review's W12-R14, decision D-7 (b), a product call).
 *
 * @param item - The work item.
 */
export function isStoppableItem(item: StopCandidate): boolean {
  return isStoppable(item.state) || approvedNotStarted(item);
}

/**
 * The manager's own words on a stop they made: their reason, the empty string when they gave
 * none, or undefined when the stop was not theirs.
 *
 * @param skipReason - The item's recorded reason.
 */
export function managerStopNote(skipReason: string | undefined): string | undefined {
  if (!isStopped(skipReason)) return undefined;
  const detail = stopDetail(skipReason ?? '');
  if (detail === MANAGER_STOP) return '';
  return detail.startsWith(`${MANAGER_STOP}: `) ? detail.slice(MANAGER_STOP.length + 2) : undefined;
}

/**
 * The recorded reason of a stop the manager made, with their words when they gave any.
 *
 * @param note - The manager's reason, already trimmed and capped; empty when they gave none.
 */
export function managerStopReason(note: string): string {
  return stoppedReason(note === '' ? MANAGER_STOP : `${MANAGER_STOP}: ${note}`);
}

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
  if (!applied.some((row, index) => row.ok === true && !refusedRead(row, index)))
    return [...applied];
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
  // The operation is the model's path as authored, and the reason is stored
  // on the card: both pass the structural floor every failure path does.
  const refused = unlanded
    .map(({ row, index }) =>
      redactTokenShapes(`${refusedOperation(actions[index], row)} (${row.reason})`),
    )
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
 * How a model call's failure names itself: the function and the agent's internal name, and for a
 * structured call sometimes its mode after them ("agentJson(day0-skill-x-initial): prompt: ").
 */
const MODEL_CALL = String.raw`\bagent(?:Json|Text)\([^)]*\):\s*(?:(?:native|prompt):\s*)?`;

/**
 * Each way a model call ends without a reply Day0 can use, as its error words it
 * (`src/lib/mastra.ts`), beside the manager's words for it. Read in order; the last takes any
 * other failure of a call, whose own words follow the call's name and are kept.
 */
const MODEL_CALL_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    new RegExp(`${MODEL_CALL}\\w+ reply did not satisfy the schema`, 'g'),
    'the model’s reply was not in the form Day0 reads',
  ],
  [
    new RegExp(`${MODEL_CALL}model returned no structured object in \\w+ mode`, 'g'),
    'the model gave no reply Day0 could read',
  ],
  [new RegExp(`${MODEL_CALL}\\w+ generation failed:\\s*`, 'g'), 'the model call failed: '],
  [
    new RegExp(`${MODEL_CALL}\\w+ generation finished with an error`, 'g'),
    'the model call ended in an error',
  ],
  [
    new RegExp(`${MODEL_CALL}\\w+ generation was stopped by a tripwire`, 'g'),
    'the model call was stopped',
  ],
  // A call that spent its budget says so in words already (`budgetSpent`): the name alone goes.
  [new RegExp(`${MODEL_CALL}(?=the model call\\b)`, 'g'), ''],
  [new RegExp(MODEL_CALL, 'g'), 'the model call failed: '],
];

/**
 * A reason with every model call's failure in the manager's words (finding 1 of the v0.20.0
 * hosted walk: six of fifteen runs stopped with "agentJson(day0-skill-kanban-comment-and-close-
 * ticket-...-initial): prompt reply did not satisfy the schema" printed on the card). The recorded
 * reason keeps the call and the agent's name, for the record's reader and the export.
 */
function modelCallsInWords(reason: string): string {
  return MODEL_CALL_WORDS.reduce((text, [said, words]) => text.replace(said, words), reason);
}

/**
 * The manager's words for a run that stopped because its reply still broke the executor's
 * contract after the one repair (RM39 (b), 14 October 2026; section 7's draft).
 */
export const CONTRACT_REFUSAL_WORDS =
  'the model’s reply did not follow Day0’s rules for this skill after one repair. Retry runs it again.';

/**
 * A reason recorded for a reply the executor's contract refused after its repair, in either phase
 * and either mode (`ActionContractRefusal`'s message), and the form a real-mode row recorded
 * before v0.22.0, when the refusal went through the resume ladder first ("the execution failed 4
 * times on the model (executor procedure contract ...); Retry runs it again").
 */
const CONTRACT_REFUSAL =
  /^(?:the execution failed \d+ times on the model \()?(?:dependent )?executor (?:action|procedure) contract remained invalid after one repair\b/;

/**
 * A failed item's reason as the manager reads it: without the stopped prefix when it is a stop,
 * with a model call's failure in words, never by the call's internal name
 * ({@link modelCallsInWords}), and a contract refusal in the manager's words, never by the
 * contract's issues, which the kept reply carries ({@link CONTRACT_REFUSAL_WORDS}).
 *
 * Args:
 *   skipReason: The item's recorded reason.
 *
 * Returns:
 *   The reason text.
 */
export function stopDetail(skipReason: string): string {
  const detail = isStopped(skipReason) ? skipReason.slice(STOPPED_PREFIX.length) : skipReason;
  return CONTRACT_REFUSAL.test(detail) ? CONTRACT_REFUSAL_WORDS : modelCallsInWords(detail);
}

/**
 * A recorded event's reason as the Record tab and the feed say it ({@link stopDetail}): a model
 * call's failure in words, as the Work card says it (W17-R22: a failed run's line printed
 * "agentJson(day0-skill-...): ..."). Anything that is not text is given back as it is.
 *
 * @param reason - The event's stored reason.
 */
export function reasonInWords(reason: unknown): unknown {
  return typeof reason === 'string' ? stopDetail(reason) : reason;
}

/**
 * The run's landed rows as the completion note tells them: every landed or
 * outcome-unknown row in ledger order, reads included, each in a manager's
 * words. The manager DM is left out, as in `landedWork`: it reports on work
 * and is not work. A DM the set held for the manager (one that reports a held
 * write of its set waits with it) is counted in: the manager approved it as one
 * of the set's writes, and the card counts it (W13V-6).
 *
 * Args:
 *   output: A run's persisted output, in either of its two shapes.
 *   surfaces: The agent's surfaces, for display names and the manager DM.
 *   replyTarget: The thread the work item answers, so a reply to it reads as one.
 *   verdicts: The gate's verdicts as the row stores them, on the set the manager
 *     decided (the output's own actions, never a prerequisite phase's); only a DM
 *     whose stored verdict says held counts, never one with no verdict.
 *
 * Returns:
 *   One row per landed action, for `landedNoteText`.
 */
export function landedNoteRows(
  output: unknown,
  surfaces: readonly SurfaceRecord[],
  replyTarget?: ReplyTarget,
  verdicts: ReadonlyArray<{ readonly disposition?: ActionVerdict['disposition'] }> = [],
): LandedNoteRow[] {
  return ledgerPhases(output).flatMap(({ phase, actions, applied }) =>
    applied.flatMap((entry, index): LandedNoteRow[] => {
      const outcomeUnknown = entry.outcomeUnknown === true || isOutcomeUnknownReason(entry.reason);
      if (!outcomeUnknown && (entry.ok !== true || entry.held === true)) return [];
      const action = actions[index];
      const parsed = action ? parseSurfaceAction(action) : undefined;
      const surface = parsed?.ok
        ? surfaces.find((row) => row.slug === parsed.action.surface)
        : undefined;
      const heldForTheManager = phase !== 'prerequisite' && verdicts[index]?.disposition === 'held';
      if (parsed?.ok && surface && isManagerDm(parsed.action, surface) && !heldForTheManager) {
        return [];
      }
      const read =
        !outcomeUnknown && parsed?.ok === true && actionIntent(parsed.action) !== 'write';
      const line = action
        ? summariseAction(action, surfaces, { replyTarget })
        : typeof entry.tool === 'string'
          ? entry.tool
          : 'unknown action';
      // The line is built from the action as authored, so it passes the same structural floor the ledger's effect does.
      return [
        {
          kind: read ? 'read' : 'write',
          line: redactTokenShapes(line),
          ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
        },
      ];
    }),
  );
}

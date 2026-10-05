import { actionIntent, parseSurfaceAction } from '../surfaces/policy';
import type { MockAction } from './types';

/** The skip reason a run carries when its apply was interrupted after the claim. */
export const INTERRUPTED_APPLY_REASON =
  'apply was interrupted after its claim; provider outcomes are unknown and must be reconciled before retry';
/**
 * The ledger reason for an action whose provider outcome the interrupted apply never learnt, in
 * the manager's words, since the card shows it (the wave 12 review's W12-R9; wording draft).
 */
export const OUTCOME_UNKNOWN_REASON =
  'outcome unknown: Day0 was interrupted while sending this write; check whether it arrived before you retry';
/**
 * The ledger reason for an action whose provider outcome is unknown because its apply was stopped
 * while it was sending (the manager's Stop, or a skill withdrawn under a run; wave 12, 12-W): the
 * same check owed, without saying an interruption ended it. Wording draft.
 */
export const OUTCOME_UNKNOWN_AFTER_STOP_REASON =
  'outcome unknown: the run was stopped while this write was being sent; check whether it arrived before you retry';

/**
 * The two reasons as rows recorded before v0.16.0 carry them, each with the words it reads in now
 * (W12-R9): a stored row keeps its reason, and every reader still takes it as unknown.
 */
const EARLIER_OUTCOME_UNKNOWN_REASONS: ReadonlyMap<string, string> = new Map([
  [
    'outcome unknown after interrupted apply - verify provider before retry',
    OUTCOME_UNKNOWN_REASON,
  ],
  [
    'outcome unknown after the apply was stopped - verify provider before retry',
    OUTCOME_UNKNOWN_AFTER_STOP_REASON,
  ],
]);

/**
 * A ledger reason in the words the card shows: a reason an earlier release recorded for an
 * unknown outcome reads as the current one; any other is returned as it is.
 *
 * @param reason - A ledger row's reason.
 */
export function outcomeReasonWords(reason: string): string {
  return EARLIER_OUTCOME_UNKNOWN_REASONS.get(reason) ?? reason;
}

/**
 * The ledger reason on an approved row a stopped apply never sent (the wave 12 review's W12-R11):
 * the apply reads its claim before each send and stops at the first it no longer holds, so every
 * row from there on is accounted for as not sent, held, never as one to check on the provider.
 * Wording draft.
 */
export const NOT_SENT_AFTER_STOP_REASON =
  'not sent: the run was stopped before this write went out';

/**
 * What happened to a write whose outcome is unknown, as a card says it under the words "Outcome
 * unknown" (the second pass on W12-R9): the cause alone, since the status and the check are said
 * beside it. Undefined for any other reason.
 *
 * @param reason - A ledger row's reason, of any release's words.
 */
export function outcomeUnknownDetail(reason: unknown): string | undefined {
  const words = typeof reason === 'string' ? outcomeReasonWords(reason) : undefined;
  if (words === OUTCOME_UNKNOWN_REASON) return 'Day0 was interrupted while sending this write.';
  if (words === OUTCOME_UNKNOWN_AFTER_STOP_REASON) {
    return 'The run was stopped while this write was being sent.';
  }
  return undefined;
}

/** Why an apply's unreported rows are recorded as of unknown outcome: it was interrupted, or stopped. */
export type ApplyEnd = 'interrupted' | 'stopped';

/**
 * The ledger reason for an approved row an ended apply never reported.
 *
 * @param end - What ended the apply.
 */
export function outcomeUnknownReasonFor(end: ApplyEnd): string {
  switch (end) {
    case 'stopped':
      return OUTCOME_UNKNOWN_AFTER_STOP_REASON;
    case 'interrupted':
      return OUTCOME_UNKNOWN_REASON;
  }
}

/**
 * Whether a ledger reason says the row's provider outcome is unknown, whichever ended its apply.
 * A row an adapter marked itself carries `outcomeUnknown` instead; the readers check both.
 *
 * @param reason - The ledger row's reason, of any shape.
 */
export function isOutcomeUnknownReason(reason: unknown): boolean {
  return (
    reason === OUTCOME_UNKNOWN_REASON ||
    reason === OUTCOME_UNKNOWN_AFTER_STOP_REASON ||
    (typeof reason === 'string' && EARLIER_OUTCOME_UNKNOWN_REASONS.has(reason))
  );
}

/**
 * Who recorded a reconciliation, as the card names them: the manager reading it, or a manager the
 * employee had before a handover. Only the employee's manager may reconcile (`assertOwnsWorkItem`),
 * so the record's actor (an owner key) is one or the other.
 */
export type Reconciler = 'you' | 'previous-manager';

/**
 * Who recorded a reconciliation, from the owner key it keeps and the employee's manager's now.
 *
 * @param actor - The owner key the reconciliation was recorded under.
 * @param managerKey - The employee's manager's owner key (`agents.userId`), when the page has it.
 * @returns The reconciler, or undefined when the manager's key is not known.
 */
export function reconcilerOf(
  actor: string,
  managerKey: string | undefined,
): Reconciler | undefined {
  if (managerKey === undefined) return undefined;
  return actor === managerKey ? 'you' : 'previous-manager';
}

/** Which phase of a run a ledger entry belongs to. */
export type ReconciliationPhase = 'single' | 'prerequisite' | 'closing';
/** What the manager must confirm about an entry: it landed, or its outcome is unknown. */
export type ReconciliationOutcome = 'landed' | 'outcome-unknown';

/**
 * What the manager found on the provider for one entry (wave 5 U17 D1, built in wave 12): the
 * write is there, or it was not sent. A retry counts a write answered `landed` as landed and never
 * sends it again, and sends one answered `not-sent` afresh.
 */
export type ReconciliationAnswer = 'landed' | 'not-sent';

/** One ledger entry the manager confirms before a retry, by phase and index. */
export interface ReconciliationEntry {
  phase: ReconciliationPhase;
  actionIndex: number;
  tool: string;
  outcome: ReconciliationOutcome;
  effect?: string;
  reason?: string;
  providerId?: string;
  idempotencyKey?: string;
  /** The manager's answer; absent on entries confirmed as a whole, before the per-entry answer. */
  answer?: ReconciliationAnswer;
}

/** The manager's answer for one entry, by its place in the run. */
export interface EntryAnswer {
  readonly phase: ReconciliationPhase;
  readonly actionIndex: number;
  readonly answer?: ReconciliationAnswer;
}

/** An answer the manager gave for one entry on the card, which always carries the answer. */
export interface GivenAnswer extends EntryAnswer {
  readonly answer: ReconciliationAnswer;
}

/** The ledger reason on a write the manager confirmed landed after its outcome was unknown. */
export const CONFIRMED_LANDED_REASON =
  'confirmed landed by the manager after its outcome was unknown';

/**
 * The entries as the manager answered them: an entry whose outcome is unknown takes the answer
 * given for it and is refused without one; a landed entry is owed no answer and carries one only
 * where one was given, so a write Day0 recorded as landed is never stored as the manager's word
 * (W12X-3). A retry reads it as landed all the same (`retryAnswersOf`).
 *
 * @param entries - The entries the run's ledger names.
 * @param answers - The manager's answers, by phase and index.
 * @returns The answered entries, or the entries still owed an answer.
 */
export function answeredEntries(
  entries: readonly ReconciliationEntry[],
  answers: readonly EntryAnswer[],
): { ok: true; entries: ReconciliationEntry[] } | { ok: false; unanswered: ReconciliationEntry[] } {
  const answerOf = (entry: ReconciliationEntry): ReconciliationAnswer | undefined =>
    answers.find(
      (answer) => answer.phase === entry.phase && answer.actionIndex === entry.actionIndex,
    )?.answer;
  const unanswered = entries.filter(
    (entry) => entry.outcome === 'outcome-unknown' && answerOf(entry) === undefined,
  );
  if (unanswered.length > 0) return { ok: false, unanswered };
  return {
    ok: true,
    entries: entries.map((entry): ReconciliationEntry => {
      const answer = answerOf(entry);
      return answer === undefined ? { ...entry } : { ...entry, answer };
    }),
  };
}

/**
 * The answers a retry reads from a stored reconciliation: each answer the manager gave, and
 * `landed` for a write Day0 recorded as landed that nobody was asked about, so the retry never
 * sends that write again (W12X-3; the rule `answeredEntries` kept before it stopped storing the
 * answer). An entry of unknown outcome with no answer gives none. A reconciliation stored at
 * v0.15.0 or before, which named only landed writes, now carries them as landed too; the same
 * writes its ledger names.
 *
 * @param entries - The stored reconciliation's entries.
 */
export function retryAnswersOf(entries: readonly ReconciliationEntry[]): GivenAnswer[] {
  return entries.flatMap((entry): GivenAnswer[] => {
    const answer = entry.answer ?? (entry.outcome === 'landed' ? 'landed' : undefined);
    return answer === undefined
      ? []
      : [{ phase: entry.phase, actionIndex: entry.actionIndex, answer }];
  });
}

interface LedgerEntry {
  tool?: unknown;
  ok?: boolean;
  held?: boolean;
  outcomeUnknown?: boolean;
  effect?: unknown;
  reason?: unknown;
  providerId?: unknown;
  idempotencyKey?: unknown;
}

/** One phase's actions beside their ledger. */
export interface LedgerPhase {
  phase: ReconciliationPhase;
  actions: MockAction[];
  applied: LedgerEntry[];
}

/** A run's ledger by phase: one for a single-phase run, two once it has a closing phase. */
export function ledgerPhases(output: unknown): LedgerPhase[] {
  const top = (output ?? {}) as {
    actions?: MockAction[];
    applied?: LedgerEntry[];
    initial?: { actions?: MockAction[]; applied?: LedgerEntry[] };
  };
  if (!top.initial) {
    return [{ phase: 'single', actions: top.actions ?? [], applied: top.applied ?? [] }];
  }
  return [
    {
      phase: 'prerequisite',
      actions: top.initial.actions ?? [],
      applied: top.initial.applied ?? [],
    },
    { phase: 'closing', actions: top.actions ?? [], applied: top.applied ?? [] },
  ];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function entryDetails(entry: LedgerEntry): Partial<ReconciliationEntry> {
  const effect = optionalString(entry.effect);
  const recorded = optionalString(entry.reason);
  const reason = recorded === undefined ? undefined : outcomeReasonWords(recorded);
  const providerId = optionalString(entry.providerId);
  const idempotencyKey = optionalString(entry.idempotencyKey);
  return {
    ...(effect ? { effect } : {}),
    ...(reason ? { reason } : {}),
    ...(providerId ? { providerId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function landedWrite(action: MockAction | undefined, entry: LedgerEntry): boolean {
  if (entry.ok !== true || entry.held === true) return false;
  if (!action) return true;
  const parsed = parseSurfaceAction(action);
  return !parsed.ok || actionIntent(parsed.action) === 'write';
}

/** The entries of a run's ledger the manager must confirm on the provider before a retry. */
export function providerReconciliationEntries(output: unknown): ReconciliationEntry[] {
  return ledgerPhases(output).flatMap(({ phase, actions, applied }) =>
    applied.flatMap((entry, actionIndex): ReconciliationEntry[] => {
      const tool = optionalString(entry.tool) ?? actions[actionIndex]?.tool ?? 'unknown';
      const outcomeUnknown = entry.outcomeUnknown === true || isOutcomeUnknownReason(entry.reason);
      if (outcomeUnknown) {
        return [
          {
            phase,
            actionIndex,
            tool,
            outcome: 'outcome-unknown',
            ...entryDetails(entry),
          },
        ];
      }
      if (!landedWrite(actions[actionIndex], entry)) return [];
      return [
        {
          phase,
          actionIndex,
          tool,
          outcome: 'landed',
          ...entryDetails(entry),
        },
      ];
    }),
  );
}

/**
 * How many rows of a run's ledger reached the work environment, reads and writes alike, across
 * both phases: what the card's landed list counts.
 */
export function landedRowCount(output: unknown): number {
  return ledgerPhases(output)
    .flatMap(({ applied }) => applied)
    .filter((entry) => entry.ok === true && entry.held !== true).length;
}

/** Whether a retry must wait for the provider reconciliation checklist. */
export function retryRequiresProviderReconciliation(output: unknown, skipReason?: string): boolean {
  return (
    skipReason === INTERRUPTED_APPLY_REASON || providerReconciliationEntries(output).length > 0
  );
}

/**
 * Whether a stored reconciliation answers every write whose outcome was unknown. One recorded
 * before the per-entry answers (v0.15.0 and earlier) answers none: it confirmed the ledger as a
 * whole, so a retry could not tell a write that landed from one that was not sent, and it is asked
 * again (wave 12 review W12-R3, decision D-9 (a)). A landed entry needs no answer of its own.
 *
 * @param reconciliation - The row's stored reconciliation, if any.
 */
export function reconciliationAnswered(
  reconciliation: { readonly entries: readonly ReconciliationEntry[] } | undefined,
): boolean {
  return (
    reconciliation !== undefined &&
    reconciliation.entries.every(
      (entry) => entry.outcome !== 'outcome-unknown' || entry.answer !== undefined,
    )
  );
}

/**
 * Whether a run still owes the manager's check of the provider before a Retry or a dismissal: its
 * ledger names a write to confirm, or its apply was interrupted, and no reconciliation answers
 * every write of unknown outcome.
 *
 * @param row - The work item's output, skip reason and stored reconciliation.
 */
export function reconciliationOwed(row: {
  readonly output?: unknown;
  readonly skipReason?: string;
  readonly providerReconciliation?: { readonly entries: readonly ReconciliationEntry[] };
}): boolean {
  return (
    retryRequiresProviderReconciliation(row.output, row.skipReason) &&
    !reconciliationAnswered(row.providerReconciliation)
  );
}

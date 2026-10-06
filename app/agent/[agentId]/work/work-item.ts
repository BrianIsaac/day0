'use client';

import type { ActionAuthority } from '@/surfaces/types';
import {
  type MockAction,
  type CharterClauseRef,
  type ArgumentRepairAttempt,
  CLAIMED_BY_COLLEAGUE_SKIP_PREFIX,
  type WorkDoneAnswer,
} from '@/work/types';
import type { Doc } from '@convex/_generated/dataModel';
import {
  isStopped,
  stopDetail,
  isGateRefusalStop,
  GATE_REFUSAL_STOP,
  managerStopNote,
} from '@/work/stop';
import { isOpenQuestionStop } from '@/work/obligations';
import {
  INTERRUPTED_APPLY_REASON,
  landedRowCount,
  providerReconciliationEntries,
  reconciliationAnswered,
  retryRequiresProviderReconciliation,
  type ReconciliationEntry,
} from '@/work/reconciliation';
import { type ActionVerdict, normaliseActionVerdict } from '@/surfaces/policy';
import { clockTime } from '../../../components/time';
import { EVALUATION_ATTEMPTS_SPENT, MAX_EVALUATION_ATTEMPTS } from '@/work/queue-order';
import { notDoneStatements, runOwnWords } from '@/work/not-done';
import { landedClosings, workDoneFactOf, type LandedClosing } from '@/work/work-done';

/** One row of the applied ledger as the card reads it. */
interface LedgerRow {
  tool: string;
  ok: boolean;
  held?: boolean;
  awaitingApproval?: boolean;
  /** What authorised the row: the manager's approval, the toggle, or a standing grant. */
  authority?: ActionAuthority;
  effect?: string;
  reason?: string;
  providerId?: string;
  outcomeUnknown?: boolean;
  idempotencyKey?: string;
  redaction?: 'structural-only';
  /** The first attempt at this row's arguments, when one bounded repair re-authored them. */
  repair?: { reason: string; toolArgsJson: string };
  /** The run's sign-in, replayed in this invocation's new browser before the row was sent. */
  sessionRestore?: SessionRestoreRow;
  /** The landed row this one reuses instead of sending again, and the number of the run that sent it. */
  reusedFrom?: string;
  reusedFromRun?: number;
}

/** A re-established browser session as the card reads it: one row per replayed call. */
export interface SessionRestoreRow {
  steps: Array<{
    ok: boolean;
    reason?: string;
    replayOf?: string;
    action?: MockAction;
  }>;
}

/** What the closing phase decided about one plan step, and on what evidence. */
export interface PlanStepOutcomeRow {
  step: number;
  status: 'satisfied' | 'blocked' | 'not-verifiable';
  evidence: string;
  basis?: 'manager-feedback';
  /** The charter clause the closing phase decided this step under. */
  charterClause?: CharterClauseRef;
}

/** A run's persisted output as the card reads it, in either of its two phases. */
export interface RunOutput {
  draft: string;
  notes: string;
  actions?: MockAction[];
  applied?: LedgerRow[];
  initial?: {
    actions?: MockAction[];
    applied?: LedgerRow[];
    withheldActions?: WithheldActionRow[];
  };
  planStepOutcomes?: PlanStepOutcomeRow[];
  /** The one repair each held write earned before the hold, by action index. */
  argumentRepairs?: ArgumentRepairAttempt[];
  /** The closing set a gate refused before anything in it reached a surface, with the reason. */
  refusedClosing?: RefusedClosingRow;
  /** Actions an audit withheld after its one repair, never sent, with the reason. */
  withheldActions?: WithheldActionRow[];
  /** A first phase whose approval starts the closing phase. */
  needsDependentPhase?: boolean;
  /** The run's answer on whether the work was done; absent on a row recorded before v0.16.0. */
  workDone?: WorkDoneAnswer;
  /** The run's one line of why it answered so. */
  workDoneWhy?: string;
  /** The clause the tripwire read when the run answered done twice over it; its close waits for the manager. */
  closeAgainstWords?: string;
}

/** An action withheld from a run and never sent, with the reason. */
export interface WithheldActionRow {
  action: MockAction;
  reason: string;
}

/** The closing set a gate refused before any of it reached a surface. */
export interface RefusedClosingRow {
  actions: MockAction[];
  planStepOutcomes: PlanStepOutcomeRow[];
  draft: string;
  notes: string;
  reason: string;
  at: number;
  /** Actions the evidence check withheld from the set before the gate refused it. */
  withheldActions?: WithheldActionRow[];
}

/** A ledger row labelled with the phase that applied it, when the run had two. */
export type PhasedLedgerRow = LedgerRow & {
  phase?: 'prerequisite' | 'closing';
  /** What the row's action does, in a manager's words, where the card has named it. */
  summary?: string;
};

/**
 * Every applied row of a run, prerequisite phase first, each labelled with the
 * phase that applied it when the run had two. A single-phase run carries no
 * label, so the ordinary card is unchanged.
 */
export function phasedLedger(output: RunOutput | undefined): PhasedLedgerRow[] {
  const initial = output?.initial?.applied;
  const closing = output?.applied ?? [];
  if (!initial) return closing.map((row): PhasedLedgerRow => ({ ...row }));
  return [
    ...initial.map((row): PhasedLedgerRow => ({ ...row, phase: 'prerequisite' })),
    ...closing.map((row): PhasedLedgerRow => ({ ...row, phase: 'closing' })),
  ];
}

/** The plan's declared obligations as the card reads them; see `PlanObligations` in `src/work/types.ts`. */
export interface PlanObligationsRow {
  steps: Array<{ kind: string; reads: string[]; writes: string[]; reason?: string }>;
  transition: string;
  transitionStep: number | null;
  basis: 'judgement' | 'planner';
  failedOpen?: string;
  reason?: string;
  plannerTransition?: string;
}

/**
 * The headline of the landed-changes list, naming how many applied under the toggle.
 *
 * Args:
 *   landed: The ledger rows that reached the work environment.
 *
 * Returns:
 *   `3 actions reached the work environment · 3 applied autonomously`, or without the tail.
 *   Reads and writes alike, so a read is never called a change (the re-walk, row 8).
 */
export function landedHeadline(
  landed: ReadonlyArray<{
    authority?: ActionAuthority;
    idempotencyKey?: string;
    reusedFrom?: string;
  }>,
): string {
  // A row the closing set reused from its own run is a message that reached once (W12V-13).
  const reached = landed.filter((row) => !reusedInThisRun(row));
  const autonomous = reached.filter((row) => row.authority === 'autonomous').length;
  const head = `${reached.length} ${reached.length === 1 ? 'action' : 'actions'} reached the work environment`;
  return autonomous > 0 ? `${head} · ${autonomous} applied autonomously` : head;
}

/**
 * Whether a reused row reuses a write of its own run (W12V-13): keys are
 * `workItemId:runId:actionIndex`, and neither id holds a colon.
 *
 * @param row - A ledger row.
 */
export function reusedInThisRun(row: { idempotencyKey?: string; reusedFrom?: string }): boolean {
  const runOf = (key: string | undefined): string | undefined => key?.split(':')[1];
  return (
    row.reusedFrom !== undefined &&
    runOf(row.reusedFrom) !== undefined &&
    runOf(row.reusedFrom) === runOf(row.idempotencyKey)
  );
}

/**
 * Why a cancelled work item stopped, for the card.
 *
 * Rows cancelled since the reason was recorded carry it in `skipReason`; an
 * older row is read from what it was doing when it was cancelled.
 *
 * Args:
 *   item: The cancelled work item's reason, verdict and plan.
 *
 * Returns:
 *   One sentence in place of the pre-cancel verdict.
 */
export function cancelledReason(item: {
  skipReason?: string;
  verdict?: { decision?: string; suggestedSkillName?: string };
  plan?: unknown;
}): string {
  if (item.skipReason) return item.skipReason;
  if (item.verdict?.decision === 'needs-skill') {
    const name = item.verdict.suggestedSkillName;
    return name
      ? `skill proposal "${name}" rejected by the manager`
      : 'skill proposal rejected by the manager';
  }
  if (item.plan) return 'plan cancelled by the manager';
  return 'cancelled by the manager';
}

/**
 * The colleague a claim-refused skip names, for the card's link to them.
 *
 * Args:
 *   item: The work item's state and verdict.
 *
 * Returns:
 *   The holding employee, or undefined for any other row.
 */
export function colleagueHolding(
  item: Pick<Doc<'workItems'>, 'state' | 'verdict'>,
): { agentId: string; name: string } | undefined {
  if (item.state !== 'skipped') return undefined;
  const verdict = item.verdict as
    | { reason?: unknown; claimedBy?: { agentId?: unknown; name?: unknown } }
    | undefined;
  const holder = verdict?.claimedBy;
  if (
    typeof verdict?.reason !== 'string' ||
    !verdict.reason.startsWith(CLAIMED_BY_COLLEAGUE_SKIP_PREFIX)
  ) {
    return undefined;
  }
  if (typeof holder?.agentId !== 'string' || typeof holder.name !== 'string') return undefined;
  return { agentId: holder.agentId, name: holder.name };
}

/**
 * Where each landed row sits in the run's ledger (`phasedLedger`): the landing moment's key. A
 * run's ledger only grows, prerequisite rows first, so a row keeps its place once it has landed
 * and the rows new since the page last looked are the ones at places it did not hold (M7).
 *
 * @param ledger - The run's rows, as `phasedLedger` gives them.
 * @returns The places of the rows that reached the work environment, in ledger order.
 */
export function landedPlaces(ledger: ReadonlyArray<Pick<LedgerRow, 'ok' | 'held'>>): number[] {
  return ledger.flatMap((row, place) => (row.ok && !row.held ? [place] : []));
}

/**
 * The landed rows the manager has not seen land: those at places the landed set did not hold a
 * moment ago. Nothing is new on a card's first render, where no earlier set is known.
 *
 * @param before - The landed places as the page last showed them (`landedPlaces` joined by
 *   commas), or undefined when no landing is playing.
 * @param now - The landed places now.
 * @returns The places that just landed.
 */
export function justLanded(before: string | undefined, now: readonly number[]): Set<number> {
  if (before === undefined) return new Set();
  const seen = new Set(before === '' ? [] : before.split(',').map(Number));
  return new Set(now.filter((place) => !seen.has(place)));
}

/** A documented API's answer as the HTTP adapter keeps it: the status, then the provider's own words. */
const PROVIDER_ANSWER = /^HTTP \d{3}\b/;

/** An MCP tool's answer as the MCP adapter keeps it: the tool, its surface, then the provider's words. */
const MCP_ANSWER = /^[\w.-]+ on [\w.-]+ · /;

/**
 * Whether a row's effect is a provider's raw answer, which the card names by what the action does
 * instead: a documented API's ("HTTP 200 · {...}", 12-J item 5c) or an MCP tool's ("save_comment on
 * linear · {...}"). The effect keeps the provider's words for the evidence check and the plan.
 *
 * @param effect - The row's effect as the ledger keeps it.
 */
export function isProviderAnswer(effect: string | undefined): boolean {
  return effect !== undefined && (PROVIDER_ANSWER.test(effect) || MCP_ANSWER.test(effect));
}

/** A ledger list row shows the short form of a long read result; the exact payload holds it whole. */
export function clipLedgerRow(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= LEDGER_ROW_LENGTH) return text;
  return `${text.slice(0, LEDGER_ROW_LENGTH - 1)}…`;
}

const LEDGER_ROW_LENGTH = 180;

/** The skipped row's control: the manager gives the agent an item it set aside. */
export const TAKE_IT_ANYWAY = 'Take it anyway';

/** The failed card's control when its run stopped on a question to the manager. */
export const ANSWER_AND_RETRY = 'Answer and retry';

/**
 * The question a failed run stopped on, when the stop is the question stop and
 * the question is still on the row; the card then asks for the answer.
 *
 * @param item - The work item row.
 * @returns The question's text, or undefined for any other state or stop.
 */
export function heldQuestionOf(
  item: Pick<Doc<'workItems'>, 'state' | 'skipReason' | 'output'>,
): string | undefined {
  if (item.state !== 'failed' || !item.skipReason || !isStopped(item.skipReason)) return undefined;
  if (!isOpenQuestionStop(stopDetail(item.skipReason))) return undefined;
  const output = item.output as
    | { openQuestion?: { question?: unknown }; initial?: { openQuestion?: { question?: unknown } } }
    | undefined;
  const question = output?.openQuestion?.question ?? output?.initial?.openQuestion?.question;
  return typeof question === 'string' && question.trim() !== '' ? question : undefined;
}

/** What Retry does on a skip no rule waives: the item is evaluated again from the start. */
export const SKIP_RETRY_NOTE =
  'Retry evaluates this item again from the start; the employee may set it aside again for the same reason.';

/** A retry note as typed, with the run it was typed for. */
export interface TypedRetryNote {
  text: string;
  token: string;
}

/**
 * What a typed retry note is tied to: the item's state and the manager's
 * last sent note. Sending a note moves both, so the box empties when the
 * Retry is taken rather than carrying the sent note onto the next card.
 *
 * Args:
 *   item: The work item row.
 *
 * Returns:
 *   A token that changes whenever a typed note stops being current.
 */
export function retryNoteToken(item: Pick<Doc<'workItems'>, 'state' | 'managerFeedback'>): string {
  return `${item.state}:${item.managerFeedback?.at ?? ''}`;
}

/**
 * The retry note that is still the manager's to send. A note left in the box
 * after its Retry made the finished card read as being sent back, which put
 * "Provider reconciliation required" under work that owed none (demo
 * rehearsal 2, Aiko's LOG-1).
 *
 * Args:
 *   typed: The note and the token it was typed under.
 *   token: The item's current token.
 *
 * Returns:
 *   The typed text while it is current, else the empty string.
 */
export function liveRetryNote(typed: TypedRetryNote, token: string): string {
  return typed.token === token ? typed.text : '';
}

/** How the reason of a run the re-read before its first write stopped begins (`withheldBeforeFirstWrite`). */
export const TICKET_REREAD_STOP = 'withheld before the first write: ';

/**
 * The row-level reason a failed item's card shows.
 *
 * A stop's own wording ("nothing landed") counts the run's writes the way the
 * stop decision does; the Retry gate counts every landed write, the manager's
 * DM included. Where the two disagree the card follows the gate, because the
 * gate is what the manager meets next.
 */
export function failedItemReason(item: {
  skipReason?: string;
  managerFeedback?: { reason: string };
  output?: {
    refusedClosing?: unknown;
    openQuestion?: unknown;
    actions?: unknown;
    applied?: unknown;
    initial?: { openQuestion?: unknown; actions?: unknown; applied?: unknown } | null;
  } | null;
  providerReconciliation?: { entries: readonly ReconciliationEntry[] };
}): string | undefined {
  // The engine's own reason for an interrupted apply, said to the manager plainly (W12-R9, bed).
  if (item.skipReason === INTERRUPTED_APPLY_REASON) {
    return providerReconciliationEntries(item.output).length > 0
      ? 'Day0 was interrupted while sending the writes you approved, so some may have landed: confirm each one below before Retry.'
      : 'Day0 was interrupted while sending the writes you approved and cannot say which went out: check them where they were going, then close this item.';
  }
  if (item.skipReason?.startsWith('rejected by the manager') && item.managerFeedback?.reason) {
    return `rejected by the manager: ${item.managerFeedback.reason}`;
  }
  if (item.skipReason && isGateRefusalStop(item.skipReason)) {
    // The gate refused a row before sending it and the rest of the run went
    // ahead, so work may have landed: the reason says what stands.
    return `stopped at a step Day0's gate refused: ${stopDetail(item.skipReason).slice(GATE_REFUSAL_STOP.length)}`;
  }
  if (item.skipReason && isStopped(item.skipReason)) {
    const landed = retryRequiresProviderReconciliation(item.output, item.skipReason);
    const unconfirmed = landed && !reconciliationAnswered(item.providerReconciliation);
    // The manager's own stop says so in their words, once, then what is left (wave 12).
    const note = managerStopNote(item.skipReason);
    if (note !== undefined) {
      // The quoted reason ends the sentence: a full stop after it unless it carries its own (W12-R9).
      const said =
        note === ''
          ? 'You stopped the run.'
          : `You stopped the run: “${note}”${/[.!?…]$/.test(note) ? '' : '.'}`;
      if (unconfirmed) {
        return `${said} A write landed or may have; confirm the provider below before Retry.`;
      }
      if (landed)
        return `${said} A write landed before it stopped; a retry does not send it again.`;
      return `${said} Nothing landed, so there is nothing to check.`;
    }
    // A stop at the closing gate keeps the landed prerequisites and the
    // refused set on the row; Retry resumes at the closing phase.
    if (item.output?.refusedClosing) {
      return unconfirmed
        ? `stopped at the closing gate; the prerequisites landed, so confirm them below and Retry resumes there: ${stopDetail(item.skipReason)}`
        : `stopped at the closing gate, the prerequisites landed and Retry resumes there: ${stopDetail(item.skipReason)}`;
    }
    const detail = stopDetail(item.skipReason);
    const questionOpen = Boolean(item.output?.openQuestion || item.output?.initial?.openQuestion);
    // The run asked its question and withheld the writes that wait on the answer.
    if (questionOpen && isOpenQuestionStop(detail)) {
      return unconfirmed
        ? `stopped with a question open for you, and the writes that wait on it were never sent; confirm what landed below, then answer it with Answer and retry: ${detail}`
        : `stopped with a question open for you, and the writes that wait on it were never sent; answer it below with Answer and retry: ${detail}`;
    }
    // Stopped for something else while a question is open: a note on this
    // Retry answers nothing (wave 1.5 review D2 (b)), and a stop at the
    // re-read before the first write is read as the re-read (m1, O1).
    if (questionOpen) {
      const retry = detail.startsWith(TICKET_REREAD_STOP)
        ? 'retry once the ticket is back, then answer the question when it is asked again'
        : 'retry, then answer the question when it is asked again';
      return unconfirmed
        ? `stopped before its question could be answered, and a note does not answer it on this stop; confirm what landed below, then ${retry}: ${detail}`
        : `stopped before its question could be answered, and a note does not answer it on this stop; ${retry}: ${detail}`;
    }
    if (unconfirmed) {
      return `stopped after a write landed or may have; confirm the provider below before Retry: ${stopDetail(item.skipReason)}`;
    }
    if (landed) {
      return `stopped, a write landed before it stopped and nothing is left to decide: ${stopDetail(item.skipReason)}`;
    }
    // No write landed, so every landed row is a read: the lead says so beside the landed list
    // (the real-Linear walk's M1-w: "nothing landed" above "Landed: get_issue").
    const reads = landedRowCount(item.output);
    if (reads > 0) {
      const counted = reads === 1 ? 'a read' : `${reads} reads`;
      return `stopped after ${counted} landed; nothing was written and nothing is left to decide: ${stopDetail(item.skipReason)}`;
    }
    return `stopped, nothing landed and nothing to decide: ${stopDetail(item.skipReason)}`;
  }
  return item.skipReason;
}

/** Name the winning control for a completed manager decision. */
export function decisionAttribution(
  decision:
    | {
        decidedAt?: number;
        outcome?: 'approved' | 'rejected';
        decidedVia?: 'dashboard' | 'channel';
        surfaceName: string;
      }
    | undefined,
): string | undefined {
  if (!decision?.decidedAt || !decision.outcome || !decision.decidedVia) return undefined;
  const source = decision.decidedVia === 'channel' ? decision.surfaceName : 'the day0 dashboard';
  return `${decision.outcome} from ${source}`;
}

/**
 * The verdict per action index, as the gate persisted it.
 *
 * A row held before verdicts existed has none; it reads as `held`, which is
 * what the manager's approval meant then, and the server's apply-time checks
 * still stand behind it.
 *
 * Args:
 *   verdicts: The verdicts persisted when the run was held.
 *   count: How many actions the run holds.
 *
 * Returns:
 *   A verdict per action index.
 */
export function pendingVerdicts(
  verdicts: Doc<'workItems'>['actionVerdicts'] | undefined,
  count: number,
): ActionVerdict[] {
  return Array.from(
    { length: count },
    (_, index): ActionVerdict => normaliseActionVerdict(verdicts?.[index] ?? {}),
  );
}

/**
 * The one-line headline of the gate box. With nothing applied on its own it says nothing reached
 * a surface, unless the run already landed a row the card lists above the box (a phase-one read):
 * then it says only that the held ones are not sent until the manager approves.
 *
 * @param verdicts - The run's verdicts.
 * @param landed - How many rows the run already landed.
 * @param decidedEarlier - How many held rows an earlier approval of this set decided (12-H): they
 *   no longer await the manager.
 * @returns `2 applied automatically · 1 awaiting your approval`, or a no-auto form.
 */
export function pendingHeadline(
  verdicts: readonly ActionVerdict[],
  landed = 0,
  decidedEarlier = 0,
): string {
  const auto = verdicts.filter((verdict) => verdict.disposition === 'auto').length;
  const held = verdicts.filter((verdict) => verdict.disposition === 'held').length - decidedEarlier;
  const refused = verdicts.filter((verdict) => verdict.disposition === 'refused').length;
  const awaiting = `${held} ${held === 1 ? 'action' : 'actions'} awaiting your approval`;
  const refusedNote = refused > 0 ? ` · ${refused} refused by the gate` : '';
  if (auto > 0) {
    return `${auto} applied automatically · ${awaiting}${refusedNote}`;
  }
  // Beside a landed row the held ones are said as unsent, before any refusal so the clause is
  // theirs alone.
  return landed > 0
    ? `${awaiting} · not sent until you approve${refusedNote}`
    : `${awaiting}${refusedNote} · nothing has reached a surface`;
}

/** What the waiting line reads of a row. */
type WaitingItem = Pick<
  Doc<'workItems'>,
  | 'state'
  | 'verdict'
  | 'evaluationClaimedAt'
  | 'evaluationAttempts'
  | 'evaluationUnavailableAt'
  | 'evaluationUnavailableCause'
>;

/**
 * Why a row that holds no slot is waiting, in the manager's words: for a
 * free slot, for the scope check to reach the model again (E-70 D3), or for
 * the manager's Retry after its evaluations kept dying (S D3).
 *
 * Args:
 *   item: The row, with the cause its last unreachable scope check gave.
 *   zone: The agent's zone, for the time.
 *
 * Returns:
 *   One sentence, or undefined for a row that is not waiting on the loop.
 */
export function waitingLine(item: WaitingItem, zone: string | undefined): string | undefined {
  const verdict = item.verdict as
    | { decision?: unknown; reason?: unknown; attempts?: unknown }
    | undefined;
  const attempts =
    typeof verdict?.attempts === 'number' ? verdict.attempts : (item.evaluationAttempts ?? 0);
  const cause = item.evaluationUnavailableCause;
  const because = cause ? ` (${cause})` : '';
  const unavailableAt =
    item.evaluationUnavailableAt !== undefined
      ? clockTime(item.evaluationUnavailableAt, zone)
      : undefined;
  if (item.state === 'deferred' && verdict?.reason === EVALUATION_ATTEMPTS_SPENT) {
    return `Parked: ${attempts} evaluations of this item stopped without a verdict, so it no longer takes a slot. Retry sends it back to be evaluated.`;
  }
  if (item.state === 'deferred' && verdict?.reason === 'scope-judgement-unavailable') {
    return `Waiting: the scope check could not reach the model${unavailableAt ? ` at ${unavailableAt}` : ''}${because}, ${attempts} times. Check for new work asks it again; nothing runs until it answers.`;
  }
  // A row back in `discovered` waits for a free slot whatever it was judged
  // before: Retry and a re-admission leave the old verdict on the row. Only a
  // verdict that queued it at the cap says something else, on its own line.
  if (item.state !== 'discovered' || verdict?.decision === 'queue') return undefined;
  if (
    item.evaluationUnavailableAt !== undefined &&
    item.evaluationUnavailableAt >= (item.evaluationClaimedAt ?? 0)
  ) {
    return `Waiting: the scope check could not reach the model at ${unavailableAt}${because}. Day0 tries again after ten minutes; nothing runs until it answers.`;
  }
  if (item.evaluationClaimedAt !== undefined) {
    const attempt = attempts > 1 ? `, attempt ${attempts} of ${MAX_EVALUATION_ATTEMPTS}` : '';
    return `Evaluation started ${clockTime(item.evaluationClaimedAt, zone)}${attempt}; if it does not answer, the item waits for the next free slot.`;
  }
  return 'Waiting for a free slot: Day0 evaluates the most urgent item first, then the oldest, as work finishes.';
}

/** The most clauses the card quotes of what a run says it did not do; the rest say the same. */
const UNFINISHED_SHOWN = 3;

/**
 * What a finished run's own words say it did not do (the 4 October live demo): the first clauses
 * of its draft and of every comment and message it wrote, in both phases, that say the work was
 * not done, at most {@link UNFINISHED_SHOWN}.
 *
 * @param output - The run's output.
 * @returns The clauses, in order; empty when the words say nothing of the kind.
 */
export function unfinishedInOwnWords(output: RunOutput | undefined): string[] {
  if (!output) return [];
  const initial = output.initial?.actions ?? [];
  return notDoneStatements(
    runOwnWords({ draft: output.draft, actions: [...initial, ...(output.actions ?? [])] }),
  ).slice(0, UNFINISHED_SHOWN);
}

/** What a finished run's card says was not done: the run's answer, and the words it says it in. */
export interface NotDoneOnCard {
  readonly answer: 'partial' | 'not-done';
  readonly statements: readonly string[];
  /**
   * The tickets the run closed all the same (a closing round's first set, 12-D's Minor 5), so a
   * closed ticket never stands under the answer unsaid.
   */
  readonly closed: readonly LandedClosing[];
}

/**
 * What a finished run's card says was not done (12-D, decision D-1 (b)). It follows the run's own
 * answer: `partial` or `not-done` with its one line of why, and nothing for a run that answered
 * `done`, whatever its words read as. A row recorded before v0.16.0 carries no answer and reads as
 * it did: the clauses its words say the work was not done in ({@link unfinishedInOwnWords}).
 *
 * @param output - The finished run's output.
 * @returns The answer and its words, or undefined for a run that reads as finished.
 */
export function notDoneOnCard(output: RunOutput | undefined): NotDoneOnCard | undefined {
  if (!output) return undefined;
  const fact = workDoneFactOf(output);
  const closed = landedClosings(output);
  if (fact !== undefined) {
    return fact.workDone === 'done'
      ? undefined
      : { answer: fact.workDone, statements: [fact.workDoneWhy], closed };
  }
  const statements = unfinishedInOwnWords(output);
  return statements.length > 0 ? { answer: 'not-done', statements, closed } : undefined;
}

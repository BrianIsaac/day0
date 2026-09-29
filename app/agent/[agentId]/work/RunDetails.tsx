'use client';

import { usePreviousValue } from '../previous-value';
import type { CharterClauseRef, PlanObligations, MockAction } from '@/work/types';
import {
  type SessionRestoreRow,
  type RunOutput,
  type RefusedClosingRow,
  type WithheldActionRow,
  type PlanObligationsRow,
  type PlanStepOutcomeRow,
  clipLedgerRow,
} from './work-item';
import { type ManagerFeedback, managerFeedbackLabel } from '@/work/manager-feedback';
import { useAgentZone, clockTimeWithSeconds, clockTime } from '../time';
import { SUMMARY } from '../../../components/Disclosure';
import { describeAction, reviewPayload } from '@/surfaces/policy';
import { isWithheldForAnswer, planObligations, transitionWithheld } from '@/work/obligations';
import type { ReconciliationEntry } from '@/work/reconciliation';
import { useState } from 'react';

/** How long a state chip's swap plays: the new chip's 100 ms offset and 220 ms fade. */
export const CHIP_SWAP_MS = 320;

/**
 * A work item's state chip. When the state changes on the page, the old chip fades out as the
 * new one fades in, in the same cell (v3 section 5.2); the first state is simply there, and
 * under reduced motion only the new one shows.
 */
export function StateChip({ state }: { state: string }) {
  const previous = usePreviousValue(state, CHIP_SWAP_MS);
  const chip = (shown: string, place?: 'from' | 'to') => (
    <span
      aria-hidden={place === 'from' ? true : undefined}
      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${stateColor(shown)}${place ? ` ${place}` : ''}`}
    >
      {shown}
    </span>
  );
  if (previous === undefined) return chip(state);
  return (
    <span key={state} className="chip-swap">
      {chip(previous, 'from')}
      {chip(state, 'to')}
    </span>
  );
}

function stateColor(state: string): string {
  if (state === 'completed') return 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]';
  if (state === 'stopped') return 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]';
  if (state === 'plan-pending' || state === 'needs-skill' || state === 'actions-pending') {
    return 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]';
  }
  if (state === 'failed' || state === 'cancelled')
    return 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]';
  if (state === 'skipped' || state === 'deferred')
    return 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]';
  return 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]';
}

/** How a clause list reads inside a sentence on the ledger. */
const CLAUSE_FIELD_PHRASE: Record<CharterClauseRef['field'], string> = {
  willDo: 'will do',
  willNotDo: 'will not do',
  escalationTriggers: 'escalation trigger',
};

/**
 * The note beside a held or applied row whose arguments were re-authored once:
 * why the first attempt was refused and what it was, so the manager judges the
 * payload in front of them knowing it is the second.
 */
export function RepairNote({
  repair,
}: {
  repair: { reason: string; toolArgsJson: string; repaired?: boolean } | undefined;
}) {
  if (!repair) return null;
  const stands = repair.repaired === false;
  return (
    <details className="mt-0.5">
      <summary className="min-h-11 py-3 text-[10px] text-[var(--color-warn)] cursor-pointer select-none">
        {stands
          ? 'argument names refused by the probed schema · the one repair produced nothing usable · first attempt stands'
          : 'arguments re-authored once before the hold · this payload is the second attempt'}
      </summary>
      <p className="text-[10px] text-[var(--color-muted)] break-words">{repair.reason}</p>
      <code className="block font-mono text-[10px] whitespace-pre-wrap break-words text-[var(--color-muted)]">
        first attempt: {repair.toolArgsJson}
      </code>
    </details>
  );
}

const REPLAYED_CALL_WORDS: Record<string, string> = {
  browser_navigate: 'navigate',
  browser_fill_form: 'fill',
  browser_click: 'click',
};

/** "row 3", "rows 0 to 2" or "rows 0, 2 and 5", from ledger keys ending in their index. */
function replayedRows(keys: readonly string[]): string | undefined {
  const indexes = keys
    .map((key: string): number => Number(key.split(':')[2]))
    .filter((index: number): boolean => Number.isInteger(index));
  if (indexes.length === 0) return undefined;
  if (indexes.length === 1) return `row ${indexes[0]}`;
  const contiguous = indexes.every(
    (index: number, position: number): boolean =>
      position === 0 || index === indexes[position - 1]! + 1,
  );
  if (contiguous) return `rows ${indexes[0]} to ${indexes.at(-1)}`;
  return `rows ${indexes.slice(0, -1).join(', ')} and ${indexes.at(-1)}`;
}

/**
 * The note beside a row whose invocation had to sign a new browser in again
 * before sending it: which of the run's own landed calls were replayed, and
 * where the replay stopped when it did. The replayed calls are transport
 * calls of their own, each with its key, so the manager can see them.
 */
export function SessionRestoreNote({ restore }: { restore: SessionRestoreRow | undefined }) {
  if (!restore || restore.steps.length === 0) return null;
  const verbs = restore.steps.map((step): string => {
    const tool = String(step.action?.args.tool ?? '');
    return REPLAYED_CALL_WORDS[tool] ?? (tool || 'call');
  });
  const replayOf = restore.steps.flatMap((step): string[] =>
    step.replayOf ? [step.replayOf] : [],
  );
  const rows = replayedRows(replayOf);
  const opened = restore.steps.some((step) => !step.replayOf);
  const source = rows
    ? opened
      ? ` (the surface's own page, then replays of ${rows})`
      : ` (replays of ${rows})`
    : " (the surface's own page)";
  const failed = restore.steps.find((step) => !step.ok);
  const signsIn = verbs.includes('fill');
  const replayed = signsIn ? 'navigate and sign-in' : 'navigate';
  const lead = failed
    ? signsIn
      ? 'could not sign in again first'
      : 'could not open the page again first'
    : signsIn
      ? 'signed in again first'
      : 'opened the page again first';
  return (
    <details className="mt-0.5">
      <summary
        className={`min-h-11 py-3 text-[10px] cursor-pointer select-none ${
          failed ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'
        }`}
      >
        {lead}: {verbs.join(', ')}
        {source}
      </summary>
      <p className="text-[10px] text-[var(--color-muted)] break-words">
        {failed
          ? `A new browser opens for every apply of a run, so Day0 tried the run's own landed ${replayed} again before this row and stopped: this row and the rest on the surface were not sent.`
          : `A new browser opens for every apply of a run. Day0 sent the page restoration calls shown above before this row; this row's action was not replayed.`}
      </p>
      {failed ? (
        <p className="text-[10px] text-[var(--color-warn)] break-words">
          stopped at {REPLAYED_CALL_WORDS[String(failed.action?.args.tool ?? '')] ?? 'a call'}:{' '}
          {failed.reason ?? 'the call did not land'}
        </p>
      ) : null}
    </details>
  );
}

/** Which phase of a run a ledger row landed in, beside the row; nothing for a one-phase run. */
export function PhaseLabel({ phase }: { phase?: 'prerequisite' | 'closing' }) {
  if (!phase) return null;
  return (
    <span className="ml-1 text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
      {phase}
    </span>
  );
}

/**
 * The draft, with an honest account of when it was written: before anything
 * was applied for a single-phase run, after the prerequisite ledger for a run
 * whose closing phase authored it from real results.
 */
export function DraftDetails({ output, title }: { output: RunOutput; title?: string }) {
  const closingPhase = output.initial !== undefined || output.planStepOutcomes !== undefined;
  return (
    <details className="mt-2 text-xs">
      <summary className="min-h-11 py-3 cursor-pointer text-[var(--color-accent)]">
        Draft the employee wrote ({output.draft.length} chars)
      </summary>
      {/* Bounded and wrapped like the other long texts on the card (P9-2), and
          reachable from the keyboard once it scrolls. */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={title ? `Draft the employee wrote: ${title}` : 'Draft the employee wrote'}
        className="mt-2 p-2 max-h-72 overflow-y-auto rounded bg-[var(--color-bg)] border border-[var(--color-border)] whitespace-pre-wrap break-words text-[var(--color-fg)]"
      >
        {output.draft}
      </pre>
      {output.notes ? (
        <p className="mt-1 text-[var(--color-muted)] italic">notes: {output.notes}</p>
      ) : null}
      <p className="mt-1 text-[10px] text-[var(--color-muted)]">
        {closingPhase
          ? 'The closing draft, written after the prerequisite actions were applied and from their ledger. Only the changes listed above reached the work environment.'
          : "The employee's own words, written before anything was applied. Only the changes listed above reached the work environment."}
      </p>
    </details>
  );
}

/**
 * The manager's written word on the item, in every state.
 *
 * A rejection reason or a retry note is the direction the next run reads,
 * and the record of why the item went the way it did; it is shown whether
 * the item is failed, running, held or finished, and says when a run
 * completed with it.
 */
export function ManagerFeedbackNote({ feedback }: { feedback: ManagerFeedback }) {
  const zone = useAgentZone();
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/30 text-xs">
      <p className="text-[var(--color-accent)] font-medium mb-0.5">
        {managerFeedbackLabel(feedback)}
        <span
          className="ml-1 font-normal text-[10px] text-[var(--color-muted)]"
          title={clockTimeWithSeconds(feedback.at, zone)}
        >
          {clockTimeWithSeconds(feedback.at, zone)}
        </span>
      </p>
      <p className="text-[var(--color-fg)] whitespace-pre-wrap break-words">{feedback.reason}</p>
      {feedback.addressedAt !== undefined ? (
        <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
          addressed by the run that completed {clockTimeWithSeconds(feedback.addressedAt, zone)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The steps a refused closing phase recorded as blocked or not verifiable,
 * in the open beside the gate's reason. The card's headline is the gate's
 * sentence; when the employee stopped for a reason of their own (no answer
 * from the manager yet, a prerequisite that did not land), that reason is
 * theirs to give and the manager's to read without opening the refused set.
 */
export function RefusedBlockedSteps({ refused }: { refused: RefusedClosingRow | undefined }) {
  const blocked = (refused?.planStepOutcomes ?? []).filter(
    (outcome) => outcome.status !== 'satisfied',
  );
  if (blocked.length === 0) return null;
  const unverified = blocked.some((outcome) => outcome.status === 'not-verifiable');
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
      <p className="font-medium text-[var(--color-fg)] mb-1">
        The employee recorded {blocked.length} {blocked.length === 1 ? 'step' : 'steps'} as blocked
        {unverified ? ' or not verifiable' : ''}
      </p>
      <ol className="space-y-0.5 text-[var(--color-muted)] break-words">
        {blocked.map((outcome) => (
          <li
            key={outcome.step}
          >{`Step ${outcome.step} · ${outcome.status} - ${outcome.evidence}`}</li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The closing set a gate refused, behind a disclosure under the failed run.
 * Read-only: nothing in it reached a surface, the row keeps it so the
 * manager can read what the agent wrote against the reason it was turned
 * away, and Retry hands it back to the closing phase to correct from the
 * same ledger.
 */
export function RefusedClosingDetails({ refused }: { refused: RefusedClosingRow | undefined }) {
  if (!refused || refused.actions.length === 0) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className={SUMMARY}>
        Refused closing set · {refused.actions.length}{' '}
        {refused.actions.length === 1 ? 'action' : 'actions'} · never sent
      </summary>
      <p className="mt-1 text-[10px] text-[var(--color-warn)] break-words">{refused.reason}</p>
      <ul className="mt-1 space-y-1">
        {refused.actions.map((action, index) => (
          <li key={index}>
            <span className="font-mono text-[10px] text-[var(--color-muted)]">
              {describeAction(action)}
            </span>
            <ActionPayload action={action} />
          </li>
        ))}
      </ul>
      {refused.planStepOutcomes.length > 0 ? (
        <ol className="mt-1 space-y-0.5 text-[10px] text-[var(--color-muted)]">
          {refused.planStepOutcomes.map((outcome) => (
            <li key={outcome.step}>
              {`Step ${outcome.step} · ${outcome.status} - ${outcome.evidence}`}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="mt-1 text-[10px] text-[var(--color-muted)]">
        As the closing phase accounted for the plan before the gate refused the set. Retry authors
        the closing set again from the same prerequisite ledger.
      </p>
    </details>
  );
}

/**
 * The actions an audit withheld after its one repair, behind a disclosure
 * under the run. Read-only: none of them reached a surface, the rest of the
 * response went on, and the row keeps each with the reason it was turned
 * away so the manager can read what the agent wrote against why.
 */
export function WithheldActionsDetails({
  withheld,
}: {
  withheld: WithheldActionRow[] | undefined;
}) {
  if (!withheld || withheld.length === 0) return null;
  const waiting = withheld.filter((row) => isWithheldForAnswer(row.reason));
  if (waiting.length > 0 && waiting.length < withheld.length) {
    return (
      <>
        <WithheldActionsDetails withheld={waiting} />
        <WithheldActionsDetails
          withheld={withheld.filter((row) => !isWithheldForAnswer(row.reason))}
        />
      </>
    );
  }
  const forAnswer = waiting.length > 0;
  return (
    <details className="mt-2 text-xs">
      <summary className={SUMMARY}>
        {forAnswer ? 'Waiting on your answer' : 'Withheld by the evidence check'} ·{' '}
        {withheld.length} {withheld.length === 1 ? 'action' : 'actions'} · never sent
      </summary>
      <ul className="mt-1 space-y-1">
        {withheld.map((row, index) => (
          <li key={index}>
            <span className="font-mono text-[10px] text-[var(--color-muted)]">
              {describeAction(row.action)}
            </span>
            <p className="text-[10px] text-[var(--color-warn)] break-words">{row.reason}</p>
            <ActionPayload action={row.action} />
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-[var(--color-muted)]">
        {forAnswer
          ? 'The approved plan left these to your answer, so the question went out without them; Retry with a note answers it and the next run authors them from it.'
          : 'The rest of the response went on without these; a retry authors them again from the ledger.'}
      </p>
    </details>
  );
}

const TRANSITION_LABELS: Record<string, string> = {
  promised: 'moved by the plan',
  'conditional-on-evidence': 'moved when what the run reads shows the condition holds',
  'conditional-on-manager': 'moved only on your approval, held for you',
  withheld: 'left where it is',
  none: 'not mentioned',
};

/**
 * What a planner and judgement disagreement on the ticket state means for
 * the state change, as the exact-action gate applies it.
 *
 * Args:
 *   steps: The plan's steps, which the declared rows must line up with.
 *   obligations: The declared obligations carrying both readings.
 *
 * Returns:
 *   One sentence: held for the manager, not held, or not read at all.
 */
function disagreementOutcome(steps: string[], obligations: PlanObligationsRow): string {
  const plan = { steps, obligations: obligations as unknown as PlanObligations };
  if (!planObligations(plan)) {
    return "These obligations no longer line up with the plan's steps, so the gates read neither and hold nothing on their account.";
  }
  return transitionWithheld(plan)
    ? 'One of the two readings leaves the state change to you, so a state change the run makes is held for your decision whatever the autonomy switch says; a retry note from you that names the state is that decision.'
    : "Neither reading leaves the state change to you, so it is not held on that account: the run follows the judgement's reading, and a state change it makes goes through the autonomy switch like any other write.";
}

/**
 * What the approved plan declares it owes, beside its steps: the reads the
 * closing gate will verify against the ledger and the plan's word on the
 * ticket state. Read-only, real mode only (a mock plan declares nothing).
 * When the judgement could not be reached the line says so, because the
 * gates then verify nothing about reads or the ticket state for this plan.
 * When the planner and the judgement disagreed on the ticket state, whether
 * the change is held is read from `transitionWithheld`, the gate's own test,
 * so the card never claims a hold the gate does not apply.
 */
export function PlanObligationsLine({
  steps,
  obligations,
  failedOpen,
}: {
  steps: string[];
  obligations: PlanObligationsRow | undefined;
  failedOpen: string | undefined;
}) {
  if (!obligations) {
    if (!failedOpen) return null;
    return (
      <p className="mt-2 text-[10px] text-[var(--color-warn)]">
        Obligations not settled: {failedOpen}. The closing gates verify no read or ticket state
        change for this plan; the closing phase still authors from the ledger.
      </p>
    );
  }
  const reads = obligations.steps.flatMap((step, index) =>
    step.reads.length > 0 ? [`step ${index + 1} reads ${step.reads.join(', ')}`] : [],
  );
  const transition = TRANSITION_LABELS[obligations.transition] ?? obligations.transition;
  const step = obligations.transitionStep !== null ? ` (step ${obligations.transitionStep})` : '';
  return (
    <div className="mt-2 text-[10px] text-[var(--color-muted)]">
      <p>
        <span className="uppercase tracking-wider">Declared obligations</span>
        {obligations.basis === 'judgement' ? ' · judged' : " · the planner's own, unchecked"}
        {' · '}
        ticket state {transition}
        {step}
        {reads.length > 0 ? ` · ${reads.join('; ')}` : ' · no reads declared'}
      </p>
      {obligations.plannerTransition ? (
        <p className="text-[var(--color-warn)]">
          The planner declared the ticket state{' '}
          {TRANSITION_LABELS[obligations.plannerTransition] ?? obligations.plannerTransition}; the
          judgement read it as {transition}. {disagreementOutcome(steps, obligations)}
        </p>
      ) : null}
      {obligations.failedOpen ? (
        <p className="text-[var(--color-warn)]">
          The obligations judgement could not be reached ({obligations.failedOpen}); the
          planner&apos;s declaration stands unchecked.
        </p>
      ) : null}
    </div>
  );
}

/** The plan's steps beside what the run recorded for each. */
export function PlanExecutionLedger({ outcomes }: { outcomes: PlanStepOutcomeRow[] }) {
  if (outcomes.length === 0) return null;
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
      <p className="font-medium text-[var(--color-fg)] mb-1">Plan execution ledger</p>
      <ol className="space-y-0.5 text-[var(--color-muted)]">
        {outcomes.map((outcome) => (
          <li key={outcome.step}>
            {`Step ${outcome.step} · ${outcome.status}${
              outcome.basis === 'manager-feedback' ? ' by manager feedback' : ''
            } - ${outcome.evidence}`}
            {outcome.charterClause ? (
              <span className="block pl-3">
                {'under the charter clause \u201c'}
                {outcome.charterClause.text}
                {`\u201d (${CLAUSE_FIELD_PHRASE[outcome.charterClause.field]}, charter v${outcome.charterClause.charterVersion})`}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The checklist a failed run shows before a retry: confirm what landed on the provider. */
export function ProviderReconciliationControl({
  entries,
  reconciliation,
  busy = false,
  onConfirm,
}: {
  entries: readonly ReconciliationEntry[];
  reconciliation?: { actor: string; confirmedAt: number };
  /** A decision on the card is in flight; the confirmation waits for it. */
  busy?: boolean;
  /** Record the manager's confirmation; the card says what it came to. */
  onConfirm: () => void;
}) {
  const zone = useAgentZone();
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="mb-2 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
      <p className="font-medium text-[var(--color-warn)]">
        {reconciliation ? 'Provider state reconciled' : 'Provider reconciliation required'}
      </p>
      {entries.length > 0 ? (
        <ul className="mt-1 space-y-1 text-[var(--color-fg)]">
          {entries.map((entry) => (
            <li key={`${entry.phase}:${entry.actionIndex}:${entry.idempotencyKey ?? ''}`}>
              <span className="font-mono text-[10px]">
                {entry.phase} action {entry.actionIndex} · {entry.tool} ·{' '}
                {entry.outcome === 'outcome-unknown' ? 'outcome unknown' : 'landed'}
              </span>
              {entry.effect ? <span className="block">{clipLedgerRow(entry.effect)}</span> : null}
              {entry.reason ? <span className="block">{entry.reason}</span> : null}
              {entry.providerId ? (
                <span className="block font-mono text-[10px] text-[var(--color-muted)]">
                  provider id {entry.providerId}
                </span>
              ) : null}
              {entry.idempotencyKey ? (
                <span className="block font-mono text-[10px] text-[var(--color-muted)]">
                  idempotency key {entry.idempotencyKey}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[var(--color-danger)]">
          The applied ledger does not identify the affected entries. Retry remains disabled.
        </p>
      )}
      {reconciliation ? (
        <p className="mt-1 text-[var(--color-muted)]">
          Verified by <span className="font-mono">{reconciliation.actor}</span> at{' '}
          <time
            dateTime={new Date(reconciliation.confirmedAt).toISOString()}
            title={clockTimeWithSeconds(reconciliation.confirmedAt, zone)}
          >
            {clockTime(reconciliation.confirmedAt, zone)}
          </time>
          . Retry is enabled.
        </p>
      ) : (
        <>
          <label className="mt-2 flex min-h-11 items-center gap-2 text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || entries.length === 0}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I verified these entries against the provider state.
          </label>
          <button
            type="button"
            disabled={!confirmed || busy || entries.length === 0}
            onClick={onConfirm}
            className="mt-2 min-h-11 px-3 rounded-md border border-[var(--color-warn)]/40 text-[var(--color-warn)] text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Confirm reconciliation
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The literal payload of one held action, readable.
 *
 * Args:
 *   props: The action as the skill emitted it.
 *
 * Returns:
 *   The verb and the arguments it reads, as JSON.
 */
export function ActionPayload({ action }: { action: MockAction }): React.ReactNode {
  return (
    <code className="block font-mono text-[10px] text-[var(--color-fg)] whitespace-pre-wrap break-words">
      {JSON.stringify(reviewPayload(action), null, 2)}
    </code>
  );
}

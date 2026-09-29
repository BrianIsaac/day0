'use client';

import { usePreviousValue } from '../../../components/previous-value';
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
import { Disclosure } from '../../../components/Disclosure';
import { describeAction, reviewPayload } from '@/surfaces/policy';
import { isWithheldForAnswer, planObligations, transitionWithheld } from '@/work/obligations';
import type { ReconciliationEntry } from '@/work/reconciliation';
import { type ReactNode, useState } from 'react';
import type { Doc } from '@convex/_generated/dataModel';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { type StateTone, workItemStateLabel } from '@/work/state-labels';

/** How long a state chip's swap plays: the new chip's 100 ms offset and 220 ms fade. */
export const CHIP_SWAP_MS = 320;

/**
 * A work item's state chip, in the manager's words (`workItemStateLabel`): "Plan to approve",
 * "Write held for you", "Rejected by you", never the enum. When the state changes on the page,
 * the old chip fades out as the new one fades in, in the same cell (v3 section 5.2); the first
 * state is simply there, and under reduced motion only the new one shows.
 *
 * @param item - The row's state, and the reason it stopped when it did.
 */
export function StateChip({ item }: { item: Pick<Doc<'workItems'>, 'state' | 'skipReason'> }) {
  const label = workItemStateLabel(item);
  const shown = `${label.tone}:${label.text}`;
  const previous = usePreviousValue(shown, CHIP_SWAP_MS);
  const chip = (said: string, place?: 'from' | 'to') => {
    const split = said.indexOf(':');
    const tone = said.slice(0, split) as StateTone;
    return (
      <span aria-hidden={place === 'from' ? true : undefined} className={place}>
        <Chip tone={tone}>{said.slice(split + 1)}</Chip>
      </span>
    );
  };
  if (previous === undefined) return chip(shown);
  return (
    <span key={shown} className="chip-swap">
      {chip(previous, 'from')}
      {chip(shown, 'to')}
    </span>
  );
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
      <summary className="min-h-11 py-3 text-[13px] text-[var(--color-warn)] cursor-pointer select-none">
        {stands
          ? 'argument names refused by the probed schema · the one repair produced nothing usable · first attempt stands'
          : 'arguments re-authored once before the hold · this payload is the second attempt'}
      </summary>
      <p className="text-[13px] text-[var(--color-muted)] break-words">{repair.reason}</p>
      <code className="block font-mono text-[13px] whitespace-pre-wrap break-words text-[var(--color-muted)]">
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
        className={`min-h-11 py-3 text-[13px] cursor-pointer select-none ${
          failed ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'
        }`}
      >
        {lead}: {verbs.join(', ')}
        {source}
      </summary>
      <p className="text-[13px] text-[var(--color-muted)] break-words">
        {failed
          ? `A new browser opens for every apply of a run, so Day0 tried the run's own landed ${replayed} again before this row and stopped: this row and the rest on the surface were not sent.`
          : `A new browser opens for every apply of a run. Day0 sent the page restoration calls shown above before this row; this row's action was not replayed.`}
      </p>
      {failed ? (
        <p className="text-[13px] text-[var(--color-warn)] break-words">
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
    <span className="ml-1.5 text-xs font-medium tracking-[0.04em] text-[var(--color-muted)] uppercase first:ml-0">
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
  const length = output.draft.length;
  return (
    <Disclosure
      summary={`Draft the employee wrote (${length} ${length === 1 ? 'character' : 'characters'})`}
    >
      {/* Bounded and wrapped like the other long texts on the card (P9-2), and
          reachable from the keyboard once it scrolls. A document, not a region:
          two items of one title would make two landmarks of one name. */}
      <pre
        tabIndex={0}
        role="document"
        aria-label={title ? `Draft the employee wrote: ${title}` : 'Draft the employee wrote'}
        className="max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 font-mono text-[13px] leading-normal whitespace-pre-wrap break-words text-[var(--color-fg-2)]"
      >
        {output.draft}
      </pre>
      {output.notes ? (
        <p className="mt-2 text-sm text-[var(--color-fg-2)] italic">Notes: {output.notes}</p>
      ) : null}
      <p className="mt-2 text-[13px] text-[var(--color-muted)]">
        {closingPhase
          ? 'The closing draft, written after the prerequisite actions were applied and from their ledger. Only the changes listed above reached the work environment.'
          : "The employee's own words, written before anything was applied. Only the changes listed above reached the work environment."}
      </p>
    </Disclosure>
  );
}

/** A piece of the manager's feedback as a sentence names it: "your retry note". */
function feedbackWords(feedback: Pick<ManagerFeedback, 'kind'>): string {
  if (feedback.kind === 'retry-note') return 'your retry note';
  if (feedback.kind === 'plan-rejection') return 'your reason for cancelling the plan';
  return 'your reason for rejecting the run';
}

/**
 * The manager's word an item is working from, said on the card (round two section 3.7's "plan
 * to approve, attempt two"): a plan redrafted after the manager cancelled one says it was
 * drafted from their reason or note, with the first plan behind a disclosure; a run going again
 * after a Retry or a rejection says it reads the note as direction. The card says what the
 * employee was given, never that the note was followed: the plan and the writes below are for
 * the manager to judge.
 *
 * @param kind - A redrafted plan, or a run going again.
 * @param feedback - The note or reason, with when it was given.
 * @param earlier - The plan a redraft replaced, drawn behind a disclosure.
 */
export function WorkingFromNote({
  kind,
  feedback,
  earlier,
}: {
  kind: 'redraft' | 'rerun';
  feedback?: ManagerFeedback;
  earlier?: ReactNode;
}) {
  const zone = useAgentZone();
  const given = feedback ? (
    <>
      {kind === 'rerun' ? ' with ' : ' from '}
      {feedbackWords(feedback)}, given at{' '}
      <time
        dateTime={new Date(feedback.at).toISOString()}
        title={clockTimeWithSeconds(feedback.at, zone)}
      >
        {clockTime(feedback.at, zone)}
      </time>
    </>
  ) : null;
  return (
    <div className="grid gap-2 border-t border-[var(--color-border)] px-4 py-3.5 sm:px-5">
      <p className="rounded-lg border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] px-3.5 py-3 text-[15px] break-words text-[var(--color-accent)]">
        <span className="font-medium text-[var(--color-fg)]">
          {kind === 'redraft'
            ? 'You cancelled an earlier plan, and this one was redrafted'
            : 'Running again'}
          {given}.
        </span>{' '}
        {feedback ? (
          <>
            <q className="italic">{feedback.reason}</q>{' '}
          </>
        ) : null}
        {kind === 'redraft'
          ? `${feedback ? 'It was drafted with that as your direction. ' : ''}It waits for your approval even while autonomous actions are on.`
          : 'The run reads it as your direction.'}
      </p>
      {kind === 'redraft' && earlier !== undefined ? (
        <Disclosure summary="The earlier plan">{earlier}</Disclosure>
      ) : null}
    </div>
  );
}

/**
 * The manager's written word on the item, when no other part of the card says it.
 *
 * A rejection reason or a retry note is the direction the next run reads,
 * and the record of why the item went the way it did; it is shown whether
 * the item is failed, running, held or finished, and says when a run
 * completed with it.
 */
export function ManagerFeedbackNote({ feedback }: { feedback: ManagerFeedback }) {
  const zone = useAgentZone();
  return (
    <div className="grid gap-1 rounded-lg border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] px-3.5 py-3">
      <p className="text-[13px] font-medium text-[var(--color-accent)]">
        {managerFeedbackLabel(feedback)}{' '}
        <time
          dateTime={new Date(feedback.at).toISOString()}
          className="font-normal text-[var(--color-muted)]"
        >
          {clockTimeWithSeconds(feedback.at, zone)}
        </time>
      </p>
      <p className="text-[15px] whitespace-pre-wrap break-words text-[var(--color-fg)]">
        {feedback.reason}
      </p>
      {feedback.addressedAt !== undefined ? (
        <p className="text-[13px] text-[var(--color-muted)]">
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
    <Disclosure
      summary={
        <>
          Refused closing set · {refused.actions.length}{' '}
          {refused.actions.length === 1 ? 'action' : 'actions'} · never sent
        </>
      }
    >
      <div className="grid gap-2 text-sm">
        <p className="mt-1 text-[13px] text-[var(--color-warn)] break-words">{refused.reason}</p>
        <ul className="mt-1 space-y-1">
          {refused.actions.map((action, index) => (
            <li key={index}>
              <span className="font-mono text-[13px] text-[var(--color-muted)]">
                {describeAction(action)}
              </span>
              <ActionPayload action={action} />
            </li>
          ))}
        </ul>
        {refused.planStepOutcomes.length > 0 ? (
          <ol className="mt-1 space-y-0.5 text-[13px] text-[var(--color-muted)]">
            {refused.planStepOutcomes.map((outcome) => (
              <li key={outcome.step}>
                {`Step ${outcome.step} · ${outcome.status} - ${outcome.evidence}`}
              </li>
            ))}
          </ol>
        ) : null}
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">
          As the closing phase accounted for the plan before the gate refused the set. Retry authors
          the closing set again from the same prerequisite ledger.
        </p>
      </div>
    </Disclosure>
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
    <Disclosure
      summary={
        <>
          {forAnswer ? 'Waiting on your answer' : 'Withheld by the evidence check'} ·{' '}
          {withheld.length} {withheld.length === 1 ? 'action' : 'actions'} · never sent
        </>
      }
    >
      <div className="grid gap-2 text-sm">
        <ul className="mt-1 space-y-1">
          {withheld.map((row, index) => (
            <li key={index}>
              <span className="font-mono text-[13px] text-[var(--color-muted)]">
                {describeAction(row.action)}
              </span>
              <p className="text-[13px] text-[var(--color-warn)] break-words">{row.reason}</p>
              <ActionPayload action={row.action} />
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">
          {forAnswer
            ? 'The approved plan left these to your answer, so the question went out without them; Answer and retry answers it and the next run authors them from it.'
            : 'The rest of the response went on without these; a retry authors them again from the ledger.'}
        </p>
      </div>
    </Disclosure>
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
      <p className="mt-2 text-[13px] text-[var(--color-warn)]">
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
    <div className="mt-2 text-[13px] text-[var(--color-muted)]">
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

/** An entry's place in the run, the checklist's key for it. */
function entryKey(entry: ReconciliationEntry): string {
  return `${entry.phase}:${entry.actionIndex}:${entry.idempotencyKey ?? ''}`;
}

/**
 * The checklist a run shows before a retry when a write landed or may have (U17 D1): each entry
 * the provider must be checked for, what the ledger recorded of it, and a tick per entry once the
 * manager has looked; the confirmation is recorded once, for all of them, and only then does
 * Retry open. A retry never sends a write the manager has not accounted for.
 *
 * @param entries - The entries to check, from the run's ledger.
 * @param reconciliation - Who confirmed the check and when, once they did.
 * @param busy - A decision on the card is in flight; the confirmation waits for it.
 * @param onConfirm - Record the manager's check; the card says what it came to.
 */
export function ProviderReconciliationControl({
  entries,
  reconciliation,
  busy = false,
  onConfirm,
}: {
  entries: readonly ReconciliationEntry[];
  reconciliation?: { actor: string; confirmedAt: number };
  busy?: boolean;
  onConfirm: () => void;
}) {
  const zone = useAgentZone();
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const all = entries.length > 0 && entries.every((entry) => checked.has(entryKey(entry)));
  const toggle = (key: string, on: boolean): void =>
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <div className="grid gap-2 rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-3.5 py-3">
      <p className="text-[15px] font-medium text-[var(--color-warn)]">
        {reconciliation ? 'Provider state reconciled' : 'Provider reconciliation required'}
      </p>
      {reconciliation ? null : (
        <p className="text-[13px] text-[var(--color-fg-2)]">
          Check each entry on the provider before a retry, so nothing that landed is sent twice.
          Tick each once you have looked; the check is recorded for all of them.
        </p>
      )}
      {entries.length > 0 ? (
        <ul className="grid gap-1.5 text-sm text-[var(--color-fg)]">
          {entries.map((entry) => {
            const key = entryKey(entry);
            const words = (
              <span className="grid min-w-0 gap-0.5 break-words">
                <span className="font-mono text-[13px]">
                  {entry.phase} action {entry.actionIndex} · {entry.tool} ·{' '}
                  {entry.outcome === 'outcome-unknown' ? 'outcome unknown' : 'landed'}
                </span>
                {entry.effect ? <span>{clipLedgerRow(entry.effect)}</span> : null}
                {entry.reason ? <span>{entry.reason}</span> : null}
                {entry.providerId ? (
                  <span className="font-mono text-[13px] text-[var(--color-muted)]">
                    provider id {entry.providerId}
                  </span>
                ) : null}
                {entry.idempotencyKey ? (
                  <span className="font-mono text-[13px] text-[var(--color-muted)]">
                    idempotency key {entry.idempotencyKey}
                  </span>
                ) : null}
              </span>
            );
            return (
              <li key={key}>
                {reconciliation ? (
                  words
                ) : (
                  <label className="grid min-h-11 cursor-pointer grid-cols-[44px_minmax(0,1fr)] items-start">
                    <span className="flex min-h-11 items-center justify-center">
                      <input
                        type="checkbox"
                        checked={checked.has(key)}
                        disabled={busy}
                        onChange={(event) => toggle(key, event.target.checked)}
                        className="size-[18px] accent-[var(--color-accent)]"
                      />
                    </span>
                    <span className="py-2.5">{words}</span>
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-[var(--color-danger)]">
          The applied ledger does not identify the affected entries. Retry remains disabled.
        </p>
      )}
      {reconciliation ? (
        <p className="text-[13px] text-[var(--color-muted)]">
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
        <div>
          <Button size="small" disabled={!all || busy || entries.length === 0} onClick={onConfirm}>
            Confirm reconciliation
          </Button>
        </div>
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
    <code className="block rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 font-mono text-[13px] leading-normal whitespace-pre-wrap break-words text-[var(--color-fg-2)]">
      {JSON.stringify(reviewPayload(action), null, 2)}
    </code>
  );
}

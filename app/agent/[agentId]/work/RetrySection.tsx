'use client';

import { useState, type ReactNode } from 'react';
import type { Doc } from '@convex/_generated/dataModel';
import { skipSentence, type WorkGate, writesWhenRunFinishes } from '@/work/item-display';
import type { GivenAnswer, ReconciliationEntry } from '@/work/reconciliation';
import { Button } from '../../../components/Button';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { clockTime, clockTimeWithSeconds, useAgentZone } from '../../../components/time';
import { Help, ItemFoot, ItemSection, Lead, Note, Quote } from './ItemParts';
import { NotSentLedger } from './LandedChanges';
import { ProviderReconciliationControl } from './RunDetails';
import {
  ANSWER_AND_RETRY,
  SKIP_RETRY_NOTE,
  TAKE_IT_ANYWAY,
  liveRetryNote,
  retryNoteToken,
  type PhasedLedgerRow,
  type TypedRetryNote,
} from './work-item';

/** What the settling controls of an item are for, read once from the row by the card. */
export type RetryMode =
  | { readonly kind: 'send-back' }
  | { readonly kind: 'answer'; readonly question: string }
  | { readonly kind: 'retry-failed'; readonly rejected: boolean }
  | { readonly kind: 'cancelled'; readonly hadPlan: boolean }
  | { readonly kind: 'take'; readonly waived: 'scope' | 'quality-fit' }
  | { readonly kind: 'skip-retry' }
  | { readonly kind: 'parked' };

/** A name that starts a sentence: the default "the employee" takes a capital there. */
function capitalised(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** The provider reconciliation a retry waits on, when a write landed or may have. */
export interface RetryReconciliation {
  readonly needed: boolean;
  readonly entries: readonly ReconciliationEntry[];
  readonly recorded?: { actor: string; confirmedAt: number };
}

/**
 * The sentence under the settling controls: what pressing them does, and what it cannot do.
 *
 * @param mode - What the controls are for.
 * @param employeeName - Who takes the item back.
 * @param autonomous - Whether autonomous actions are on.
 * @param gate - The deployment's gate.
 */
export function retryWhy(
  mode: RetryMode,
  employeeName: string,
  autonomous: boolean,
  gate: WorkGate = 'real',
): string {
  const heldAgain = `when it finishes, ${writesWhenRunFinishes(autonomous, gate)}`;
  switch (mode.kind) {
    case 'send-back':
      return `Sending it back with a note returns this finished work; the note reaches ${employeeName} as your direction, and ${heldAgain}.`;
    case 'answer':
      return `Your answer goes to ${employeeName} as the note on this retry; the writes that waited on it are authored from it, and ${heldAgain}.`;
    case 'retry-failed':
      return mode.rejected
        ? `${capitalised(employeeName)} runs the approved plan again, reading your note as direction when you write one and your reason when you do not. A note can change what is proposed; it cannot approve anything, and ${heldAgain}.`
        : `Retry runs the item again, with your note when you write one; ${heldAgain}.`;
    case 'cancelled':
      return mode.hadPlan
        ? autonomous
          ? 'Retry drafts a new plan from your note when you write one, and from your reason when you do not; the plan comes back to you before anything runs, even while autonomous actions are on.'
          : 'Retry drafts a new plan from your note when you write one, and from your reason when you do not; the plan comes back to you before anything runs.'
        : 'Retry evaluates this item again from the start; if it still needs a skill, a new proposal comes to you.';
    case 'take':
      return mode.waived === 'scope'
        ? `${TAKE_IT_ANYWAY} is your decision that this work is ${employeeName}'s to do: it is evaluated again as in scope, and its plan still waits for your approval.`
        : `${TAKE_IT_ANYWAY} is your decision that this work is worth doing: it is evaluated again without the quality-fit filter, and its plan still waits for your approval.`;
    case 'skip-retry':
      return SKIP_RETRY_NOTE;
    case 'parked':
      return 'It takes no slot and waits for this Retry and nothing else.';
  }
}

/** Whether a failed item's quiet control dismisses it (N7) or closes it without a retry (E-8). */
export type SetAside = 'dismiss' | 'close';

/**
 * What Dismiss, or Close without retry, does to a failed item, beside what Retry does (N7, E-8).
 *
 * @param mode - The failed item's controls: a rejection is already out of the inbox.
 * @param kind - Which of the two the card offers.
 * @param retryOpen - Whether Retry can be pressed here.
 */
export function dismissWhy(mode: RetryMode, kind: SetAside = 'dismiss', retryOpen = true): string {
  if (kind === 'close') {
    return retryOpen
      ? 'Close without retry takes it out of your inbox and keeps it in the record; Retry stays here.'
      : 'Close without retry takes it out of your inbox and keeps it in the record.';
  }
  return mode.kind === 'retry-failed' && mode.rejected
    ? 'It is already out of your inbox, as the decision was yours; Dismiss files it at the foot of the queue and keeps it in the record.'
    : 'Dismiss takes it out of your inbox and keeps it in the record; Retry stays here.';
}

/**
 * A skip, as round two section 3.7 draws it: the reason, citing the charter clause the scope
 * judgement read, and for an out-of-scope skip the sentence that scope and skill are judged
 * apart (R6), so a scope skip is never read as a missing skill.
 *
 * @param reason - The skip verdict's reason.
 * @param scope - Whether the skip is the scope judgement's.
 * @param employeeName - Whose charter the scope is.
 */
export function SkippedSection({
  reason,
  scope,
  employeeName,
}: {
  reason: string;
  scope: boolean;
  employeeName: string;
}) {
  return (
    <ItemSection>
      <Note>
        <Lead>Skipped.</Lead> {skipSentence(reason)}
      </Note>
      {scope ? (
        <Help>
          Whether this work is within {employeeName}&apos;s charter is judged separately from
          whether {employeeName} has a skill for it. If you give {employeeName} the work, it is
          planned, and a skill is proposed to you if one is needed.
        </Help>
      ) : null}
    </ItemSection>
  );
}

/**
 * A run the manager rejected, as round two section 3.7 draws it: when, and that nothing held
 * was sent (or what had already landed on its own before the rejection), the reason kept with
 * the item, and the writes that were held and never sent. Never in danger red: the decision was
 * the manager's (A D4 (b)).
 *
 * @param rejection - The reason and when it was given.
 * @param landed - How many rows had landed on their own before the rejection.
 * @param notSent - The rows the run held and never sent.
 * @param zone - The employee's zone.
 */
export function RejectedSection({
  rejection,
  landed,
  notSent,
  zone,
}: {
  rejection: { readonly reason: string; readonly at?: number };
  landed: number;
  notSent: readonly PhasedLedgerRow[];
  zone: string | undefined;
}) {
  return (
    <>
      <ItemSection>
        <Note>
          <Lead>
            You rejected the run
            {rejection.at !== undefined ? (
              <>
                {' at '}
                <time
                  dateTime={new Date(rejection.at).toISOString()}
                  title={clockTimeWithSeconds(rejection.at, zone)}
                >
                  {clockTime(rejection.at, zone)}
                </time>
              </>
            ) : null}
            .
          </Lead>{' '}
          {landed === 0
            ? 'Nothing was sent.'
            : `Nothing held was sent; ${landed} ${landed === 1 ? 'change' : 'changes'} had already landed on ${landed === 1 ? 'its' : 'their'} own, listed below.`}
        </Note>
        {rejection.reason.trim() !== '' ? (
          <p className="text-[15px] text-[var(--color-fg-2)]">
            <Quote>{rejection.reason}</Quote>{' '}
            <span className="text-[13px] text-[var(--color-muted)]">
              · your reason, kept with the item
            </span>
          </p>
        ) : (
          <Help>You gave no reason.</Help>
        )}
      </ItemSection>
      {notSent.length > 0 ? (
        <ItemSection title="What was held and not sent">
          <NotSentLedger rows={notSent} />
        </ItemSection>
      ) : null}
    </>
  );
}

/**
 * The controls that settle an item the loop has let go of: send finished work back with a
 * note, answer the question a run stopped on, retry a stopped or rejected run, draft a new plan
 * for a cancelled one, take a skipped item anyway, or send a parked one back to be evaluated.
 * A retry that must first know what landed on the provider waits for the reconciliation
 * checklist; the consequence of each control is said beneath it.
 *
 * @param item - The row.
 * @param mode - What the controls are for.
 * @param reason - The row-level reason a stopped run shows, when it earns its space.
 * @param reconciliation - What the provider must be checked for before a retry.
 * @param employeeName - Who takes the item back.
 * @param autonomous - Whether autonomous actions are on.
 * @param busy - A decision on the card is in flight.
 * @param onRetry - Retry with the note as typed.
 * @param onReconcile - Record the manager's answer for each entry the provider was checked for.
 * @param dismiss - Dismiss (N7) or Close without retry (E-8) for a failed item: which, the call,
 *   and when it was set aside if it was.
 */
export function RetrySection({
  item,
  mode,
  reason,
  reconciliation,
  employeeName,
  autonomous,
  gate = 'real',
  busy,
  onRetry,
  onReconcile,
  dismiss,
}: {
  item: Pick<Doc<'workItems'>, '_id' | 'state' | 'managerFeedback'>;
  mode: RetryMode;
  reason?: string;
  reconciliation: RetryReconciliation;
  employeeName: string;
  autonomous: boolean;
  gate?: WorkGate;
  busy: boolean;
  onRetry: (note: string) => void;
  onReconcile: (answers: readonly GivenAnswer[]) => void;
  dismiss?: { readonly kind: SetAside; readonly at?: number; readonly onDismiss: () => void };
}) {
  const zone = useAgentZone();
  const token = retryNoteToken(item);
  const [typed, setTyped] = useState<TypedRetryNote>({ text: '', token });
  const note = liveRetryNote(typed, token);
  const writing = note.trim() !== '';
  const takesNote =
    mode.kind === 'send-back' ||
    mode.kind === 'answer' ||
    mode.kind === 'retry-failed' ||
    (mode.kind === 'cancelled' && mode.hadPlan);
  const blocked = reconciliation.needed && !reconciliation.recorded;
  // A finished item is sent back only with a note, so its checklist waits
  // until the manager has started writing one.
  const showChecklist =
    (reconciliation.needed || reconciliation.recorded !== undefined) &&
    (mode.kind !== 'send-back' || writing);
  const noteLabel =
    mode.kind === 'answer'
      ? `Your answer to: “${mode.question}”`
      : mode.kind === 'send-back'
        ? `Note for the retry: say what to change or answer what ${employeeName} asked`
        : mode.kind === 'cancelled'
          ? 'Note for the new plan (optional)'
          : `Note for the retry (optional): answer what ${employeeName} asked, or say what to change`;
  const noteHelp =
    mode.kind === 'answer'
      ? `${capitalised(employeeName)} stopped on this question; the run goes on once you answer it.`
      : mode.kind === 'send-back'
        ? 'Needed: finished work goes back only with a direction.'
        : `${capitalised(employeeName)} reads it as your direction. It can change what is proposed; it cannot approve anything.`;
  const label =
    mode.kind === 'take'
      ? TAKE_IT_ANYWAY
      : mode.kind === 'answer'
        ? ANSWER_AND_RETRY
        : mode.kind === 'send-back'
          ? 'Send back with a note'
          : writing
            ? 'Retry with this note'
            : 'Retry';
  const disabled =
    busy || blocked || ((mode.kind === 'send-back' || mode.kind === 'answer') && !writing);
  const body: ReactNode[] = [];
  if (dismiss?.at !== undefined) {
    body.push(
      <Note key="dismissed">
        <Lead>
          {dismiss.kind === 'close'
            ? 'You closed this without a retry at'
            : 'You dismissed this at'}{' '}
          <time
            dateTime={new Date(dismiss.at).toISOString()}
            title={clockTimeWithSeconds(dismiss.at, zone)}
          >
            {clockTime(dismiss.at, zone)}
          </time>
          .
        </Lead>{' '}
        {blocked
          ? 'It is out of your inbox and stays in the record.'
          : 'It is out of your inbox and stays in the record; Retry still sends it back.'}
      </Note>,
    );
  }
  if (reason) {
    body.push(
      <Note key="reason" tone="warn">
        {reason}
      </Note>,
    );
  }
  if (showChecklist) {
    body.push(
      <ProviderReconciliationControl
        key="reconcile"
        entries={reconciliation.entries}
        reconciliation={reconciliation.recorded}
        busy={busy}
        onConfirm={onReconcile}
      />,
    );
  }
  if (takesNote) {
    body.push(
      <Field key="note" label={noteLabel} hint={noteHelp}>
        {(control) => (
          <input
            {...control}
            type="text"
            value={note}
            disabled={busy}
            onChange={(event) => setTyped({ text: event.target.value, token })}
            className={`${INPUT_CLASS} w-full`}
          />
        )}
      </Field>,
    );
  }
  return (
    <>
      {body.length > 0 ? <ItemSection>{body}</ItemSection> : null}
      <ItemFoot
        why={
          <>
            {retryWhy(mode, employeeName, autonomous, gate)}
            {blocked && (mode.kind !== 'send-back' || writing)
              ? ' Retry remains disabled until provider reconciliation is recorded.'
              : ''}
            {dismiss && dismiss.at === undefined
              ? ` ${dismissWhy(mode, dismiss.kind, !blocked)}`
              : ''}
          </>
        }
      >
        <Button
          variant={mode.kind === 'send-back' ? 'secondary' : 'retry'}
          size={mode.kind === 'send-back' ? 'medium' : 'large'}
          disabled={disabled}
          onClick={() => onRetry(note)}
        >
          {label}
        </Button>
        {dismiss && dismiss.at === undefined ? (
          <Button variant="quiet" disabled={busy} onClick={dismiss.onDismiss}>
            {dismiss.kind === 'close' ? 'Close without retry' : 'Dismiss'}
          </Button>
        ) : null}
      </ItemFoot>
    </>
  );
}

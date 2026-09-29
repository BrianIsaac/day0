'use client';

import type { MockAction, ArgumentRepairAttempt } from '@/work/types';
import { type ActionVerdict, HELD_WITHHELD_TRANSITION } from '@/surfaces/policy';
import type { SurfaceRecord } from '@/surfaces/types';
import { type ReplyTarget, summariseAction } from '@/surfaces/summary';
import { useId, useMemo, useState } from 'react';
import { pendingHeadline, type RunOutput, pendingVerdicts } from './work-item';
import {
  HELD_WITHHELD_TRANSITION_NOTE,
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WHILE_SUPERVISED_NOTE,
} from '@/work/autonomy';
import { ActionPayload, RepairNote } from './RunDetails';
import type { Id, Doc } from '@convex/_generated/dataModel';
import { useChange, LiveStatus } from '../live-status';

/**
 * The exact-action gate: every row the ladder did not apply on its own,
 * verbatim, with a checkbox each. Rows classified `auto` were applied before
 * the manager saw the card and are listed with the changes that reached the
 * work environment; nothing else reaches a surface until it is approved here.
 */
export function PendingActions({
  actions,
  verdicts,
  surfaces,
  replyTarget,
  autonomousActions = false,
  repairs,
  busy = false,
  onApprove,
  onReject,
}: {
  actions: MockAction[];
  verdicts: ActionVerdict[];
  surfaces: SurfaceRecord[];
  replyTarget?: ReplyTarget;
  /** Whether the agent's switch is on now; the card says why the rows are waiting either way. */
  autonomousActions?: boolean;
  /** The one repair each held write earned before the hold, by action index. */
  repairs?: ArgumentRepairAttempt[];
  /** A decision on this card is in flight; the controls wait for it. */
  busy?: boolean;
  /** Approve the rows; the card says what it came to in its live region. */
  onApprove: (approvedIndexes: number[]) => void;
  /** Reject the run with the manager's reason; said on the card too. */
  onReject: (reason: string) => void;
}) {
  const reasonId = useId();
  // The gate decided each row when it held the run: `auto` rows are already
  // applied and are not shown here; `refused` rows (a missing grant, an
  // unconnected surface, a forged trailer) cannot be ticked and the server
  // refuses them at approval; `held` rows are the manager's to approve. The
  // "Approve all" button is disabled while a refused row exists so it never
  // promises what the gate will not deliver.
  const refusedIndexes = useMemo(
    () =>
      new Set(
        verdicts.flatMap((verdict, index) => (verdict.disposition === 'refused' ? [index] : [])),
      ),
    [verdicts],
  );
  const heldIndexes = useMemo(
    () => verdicts.flatMap((verdict, index) => (verdict.disposition === 'held' ? [index] : [])),
    [verdicts],
  );
  const shown = useMemo(
    () =>
      actions
        .map((action, index) => ({ action, index }))
        .filter(({ index }) => verdicts[index]?.disposition !== 'auto'),
    [actions, verdicts],
  );
  const [selected, setSelected] = useState<Set<number>>(() => new Set(heldIndexes));
  const [reason, setReason] = useState('');

  function toggle(index: number, on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  const anyRefused = refusedIndexes.size > 0;
  return (
    <div className="mt-3 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
      <p className="text-[var(--color-warn)] font-medium mb-1">{pendingHeadline(verdicts)}</p>
      {heldIndexes.length > 0 ? (
        <p className="text-[var(--color-muted)] mb-1">
          {heldIndexes.every((index) => {
            const verdict = verdicts[index];
            return verdict?.disposition === 'held' && verdict.reason === HELD_WITHHELD_TRANSITION;
          })
            ? HELD_WITHHELD_TRANSITION_NOTE
            : autonomousActions
              ? HELD_BEFORE_AUTONOMY_NOTE
              : HELD_WHILE_SUPERVISED_NOTE}
        </p>
      ) : null}
      {actions.length === 0 ? (
        <p className="text-[var(--color-muted)]">
          The skill emitted no actions. Approving lands nothing; reject to send it back.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map(({ action, index }) => {
            const verdict = verdicts[index];
            const refused = verdict?.disposition === 'refused';
            const on = selected.has(index);
            const summary = summariseAction(action, surfaces, { replyTarget });
            return (
              <li key={index} className="flex items-start gap-2">
                <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy || refused}
                    onChange={(event) => toggle(index, event.target.checked)}
                    aria-label={`approve: ${summary}`}
                  />
                </label>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--color-fg)] break-words">
                    {summary}
                    {refused ? (
                      <span className="text-[var(--color-warn)]">
                        {' '}
                        · refused · {verdict.reason}
                      </span>
                    ) : verdict?.disposition === 'held' ? (
                      <span className="text-[var(--color-muted)]"> · {verdict.reason}</span>
                    ) : null}
                  </p>
                  <details className="mt-0.5">
                    <summary className="min-h-11 py-3 text-[10px] text-[var(--color-muted)] cursor-pointer select-none">
                      exact payload
                    </summary>
                    <ActionPayload action={action} />
                  </details>
                  <RepairNote repair={repairs?.find((attempt) => attempt.index === index)} />
                  <div className="flex items-center gap-2 mt-0.5">
                    {!refused && !on ? (
                      <span className="text-[10px] text-[var(--color-muted)]">
                        held · will not be sent
                      </span>
                    ) : null}
                    {refused ? null : on ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, false)}
                        aria-label={`reject this action: ${summary}`}
                        className="min-h-11 px-1 text-[10px] text-[var(--color-danger)] underline"
                      >
                        reject this action
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, true)}
                        aria-label={`include: ${summary}`}
                        className="min-h-11 px-1 text-[10px] text-[var(--color-accent)] underline"
                      >
                        include
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button
          type="button"
          disabled={busy || actions.length === 0}
          onClick={() => onApprove([...selected].sort((a, b) => a - b))}
          className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs font-medium disabled:opacity-50"
        >
          Approve selected ({selected.size})
        </button>
        <button
          type="button"
          disabled={busy || anyRefused || heldIndexes.length === 0}
          title={anyRefused ? APPROVE_ALL_REFUSED : undefined}
          aria-describedby={anyRefused ? `${reasonId}-all` : undefined}
          onClick={() => onApprove(heldIndexes)}
          className="min-h-11 px-3 rounded-md border border-[var(--color-ok)]/40 text-[var(--color-ok)] text-xs disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Approve all
        </button>
        {anyRefused ? (
          <p id={`${reasonId}-all`} className="basis-full text-[10px] text-[var(--color-muted)]">
            {APPROVE_ALL_REFUSED}
          </p>
        ) : null}
        <label htmlFor={reasonId} className="basis-full text-[10px] text-[var(--color-muted)]">
          Reason for rejecting the run
        </label>
        <input
          id={reasonId}
          type="text"
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          className="min-h-11 flex-1 min-w-[10rem] px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => onReject(reason)}
          className="min-h-11 px-3 rounded-md border border-[var(--color-border)] hover:border-[var(--color-danger)] text-xs"
        >
          Reject run
        </button>
      </div>
    </div>
  );
}

/** Why Approve all is disabled while the gate refuses a row, beside the button and for its hover. */
const APPROVE_ALL_REFUSED =
  'A row in this run is refused by the gate and cannot be approved; approve the rest by selection.';

/** What the manager decided with the plan: the answers given, and a note to the planner's own. */
export interface PlanApproval {
  answers: Array<{ questionId: Id<'managerQuestions'>; text: string }>;
  note?: string;
  /** N11: "this would have taken me about N minutes", when the manager gave it. */
  manualEstimateMinutes?: number;
}

/**
 * What the approval form sends: the item, the answers given, the note and the
 * manager's estimate.
 *
 * Args:
 *   workItemId: The plan-pending item.
 *   decision: The answers and note as the form collected them.
 *
 * Returns:
 *   The arguments for `work.approvePlan`; nothing optional is sent empty.
 */
export function planApprovalRequest(
  workItemId: Id<'workItems'>,
  decision: PlanApproval,
): {
  workItemId: Id<'workItems'>;
  answers?: PlanApproval['answers'];
  note?: string;
  manualEstimateMinutes?: number;
} {
  return {
    workItemId,
    ...(decision.answers.length > 0 ? { answers: decision.answers } : {}),
    ...(decision.note ? { note: decision.note } : {}),
    ...(decision.manualEstimateMinutes !== undefined
      ? { manualEstimateMinutes: decision.manualEstimateMinutes }
      : {}),
  };
}

/**
 * The minutes the manager typed into the plan card's estimate, read as the
 * server takes it: a whole number of minutes from 1, or nothing when the field
 * is empty.
 *
 * Args:
 *   typed: The field as typed.
 *
 * Returns:
 *   The minutes, undefined for an empty field, or null for text the server
 *   would refuse.
 */
export function typedEstimateMinutes(typed: string): number | undefined | null {
  const text = typed.trim();
  if (text === '') return undefined;
  if (!/^\d+$/.test(text)) return null;
  const minutes = Number(text);
  return minutes >= 1 ? minutes : null;
}

/**
 * The questions a pending plan raises and the manager's answers to them,
 * approved as one decision.
 *
 * The charter's open questions this plan touched come from their records;
 * the planner's own note (`riskNotes`) is shown and may be answered as free
 * text. Every answer reaches the run as approved evidence; a question left
 * blank is simply not answered and stays open.
 */
export function PlanApprovalForm({
  riskNotes,
  questions,
  onApprove,
  onCancel,
  busy = false,
}: {
  riskNotes: string;
  questions: Doc<'managerQuestions'>[];
  onApprove: (decision: PlanApproval) => void;
  /** Cancels the plan with the manager's reason, empty when none was written. */
  onCancel: (reason: string) => void;
  /** Whether a decision on this plan is in flight. */
  busy?: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [estimate, setEstimate] = useState('');
  const open = questions.filter((question) => !question.answer);
  const planNote = riskNotes.trim();
  const minutes = typedEstimateMinutes(estimate);
  const estimateId = useId();
  function decision(): PlanApproval {
    return {
      answers: open.flatMap((question) => {
        const text = (answers[question._id] ?? '').trim();
        return text ? [{ questionId: question._id, text }] : [];
      }),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(typeof minutes === 'number' ? { manualEstimateMinutes: minutes } : {}),
    };
  }
  return (
    <div className="mt-2 space-y-2">
      {open.length > 0 ? (
        <div className="p-2 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10">
          <p className="text-[var(--color-warn)] font-medium mb-1">
            {open.length === 1
              ? 'A question for you before this plan runs'
              : `${open.length} questions for you before this plan runs`}
          </p>
          <ul className="space-y-1.5">
            {open.map((question) => (
              <li key={question._id}>
                <label htmlFor={`${estimateId}-${question._id}`} className="text-[var(--color-fg)]">
                  {question.question}
                </label>
                <p className="text-[10px] text-[var(--color-muted)]">
                  from the charter · touched by the {question.context.touchedBy}
                  {question.context.words.length > 0
                    ? `: ${question.context.words.join(', ')}`
                    : ''}
                  {' · your answer is written into the charter with the approval (optional)'}
                </p>
                <input
                  id={`${estimateId}-${question._id}`}
                  type="text"
                  value={answers[question._id] ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [question._id]: event.target.value }))
                  }
                  aria-label={`answer: ${question.question}`}
                  className="mt-0.5 min-h-11 w-full px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {planNote ? (
        <div className="p-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-0.5">
            Planner&apos;s note
          </p>
          <p className="text-[var(--color-fg)]">{planNote}</p>
          <label
            htmlFor={`${estimateId}-note`}
            className="mt-1 block text-[10px] text-[var(--color-muted)]"
          >
            Your answer to the note, for this run (optional)
          </label>
          <input
            id={`${estimateId}-note`}
            type="text"
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            className="min-h-11 w-full px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
          />
        </div>
      ) : null}
      <div>
        <label
          htmlFor={`${estimateId}-cancel`}
          className="block text-[10px] text-[var(--color-muted)]"
        >
          Reason, if you cancel (optional)
        </label>
        <input
          id={`${estimateId}-cancel`}
          type="text"
          value={cancelReason}
          disabled={busy}
          onChange={(event) => setCancelReason(event.target.value)}
          className="min-h-11 w-full px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-fg)]">
        <label htmlFor={estimateId}>This would have taken me about</label>
        <input
          id={estimateId}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={estimate}
          disabled={busy}
          onChange={(event) => setEstimate(event.target.value)}
          aria-describedby={`${estimateId}-hint`}
          aria-invalid={minutes === null}
          className="min-h-11 w-20 px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
        />
        <span>minutes</span>
        <span
          id={`${estimateId}-hint`}
          className="basis-full text-[10px] text-[var(--color-muted)]"
        >
          {minutes === null
            ? 'A whole number of minutes, or leave it empty.'
            : 'Optional. Summed over finished work as hours saved, a gauge for you, never a headline.'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onApprove(decision())}
          disabled={busy || minutes === null}
          className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs disabled:opacity-50"
        >
          {open.length > 0 || planNote ? 'Approve plan with answers' : 'Approve plan'}
        </button>
        <button
          type="button"
          onClick={() => onCancel(cancelReason.trim())}
          disabled={busy}
          className="min-h-11 px-3 rounded-md border border-[var(--color-border)] text-xs disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One member of the cross-item approval: the held rows of a parked run. */
export interface PendingDecisionMember {
  workItemId: Id<'workItems'>;
  pendingRunId: Id<'events'>;
  title: string;
  actions: MockAction[];
  heldIndexes: number[];
  refused: number;
}

/**
 * The held action sets open across the queue, read from each parked item.
 *
 * Args:
 *   items: The work items.
 *
 * Returns:
 *   One member per item whose run is parked with rows awaiting the manager.
 */
export function pendingDecisionMembers(
  items: readonly Doc<'workItems'>[],
): PendingDecisionMember[] {
  return items.flatMap((item): PendingDecisionMember[] => {
    if (
      item.state !== 'actions-pending' ||
      !item.pendingRunId ||
      item.approvedIndexes !== undefined
    ) {
      return [];
    }
    const actions = ((item.output ?? {}) as RunOutput).actions ?? [];
    const verdicts = pendingVerdicts(item.actionVerdicts, actions.length);
    const heldIndexes = verdicts.flatMap((verdict, index) =>
      verdict.disposition === 'held' ? [index] : [],
    );
    if (heldIndexes.length === 0) return [];
    return [
      {
        workItemId: item._id,
        pendingRunId: item.pendingRunId,
        title: item.title,
        actions,
        heldIndexes,
        refused: verdicts.filter((verdict) => verdict.disposition === 'refused').length,
      },
    ];
  });
}

/**
 * Every held action set across the queue, approvable from one place.
 *
 * Each member is shown with the same literal payloads its own card shows,
 * and the one button sends the same exact approval per member that the
 * card's "Approve all" sends: the parked run and its held indexes. A member
 * with a refused row is listed but left to its card, as the card's own rule
 * is. Shown only when more than one item is waiting; one item is its card.
 */
export function PendingDecisionsPanel({
  members,
  surfaces,
  onApproveBatch,
  fallback,
}: {
  members: PendingDecisionMember[];
  surfaces: SurfaceRecord[];
  onApproveBatch: (
    members: Array<{
      workItemId: Id<'workItems'>;
      pendingRunId: Id<'events'>;
      approvedIndexes: number[];
    }>,
  ) => Promise<unknown>;
  /** Where focus goes when the approval empties the panel: the work queue. */
  fallback?: React.RefObject<HTMLElement | null>;
}) {
  const change = useChange(fallback);
  // The panel keeps its live region when an approval empties it, so what the
  // approval came to is still said.
  if (members.length < 2) return <LiveStatus outcome={change.outcome} />;
  const eligible = members.filter((member) => member.refused === 0);
  const heldCount = eligible.reduce((sum, member) => sum + member.heldIndexes.length, 0);
  return (
    <div className="mb-3 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
      <p className="text-[var(--color-warn)] font-medium mb-1">
        {members.length} items have actions awaiting your approval
      </p>
      <ul className="space-y-1.5">
        {members.map((member) => (
          <li key={member.workItemId}>
            <p className="text-[var(--color-fg)] font-medium">{member.title}</p>
            {member.refused > 0 ? (
              <p className="text-[10px] text-[var(--color-muted)]">
                {member.refused} {member.refused === 1 ? 'row is' : 'rows are'} refused by the gate;
                decide this one on its card.
              </p>
            ) : null}
            <ul className="ml-3 space-y-0.5">
              {member.heldIndexes.map((index) => (
                <li key={index} className="text-[var(--color-fg)] break-words">
                  {summariseAction(member.actions[index], surfaces)}
                  <details className="mt-0.5">
                    <summary className="min-h-11 py-3 text-[10px] text-[var(--color-muted)] cursor-pointer select-none">
                      exact payload
                    </summary>
                    <ActionPayload action={member.actions[index]} />
                  </details>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button
          type="button"
          disabled={change.busy || eligible.length === 0}
          onClick={() =>
            change.run(
              () =>
                onApproveBatch(
                  eligible.map((member) => ({
                    workItemId: member.workItemId,
                    pendingRunId: member.pendingRunId,
                    approvedIndexes: member.heldIndexes,
                  })),
                ),
              {
                done: `Approved ${heldCount} held ${heldCount === 1 ? 'action' : 'actions'} across ${eligible.length} ${eligible.length === 1 ? 'item' : 'items'}: they apply now.`,
                refused: 'Nothing was approved.',
              },
            )
          }
          className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs font-medium disabled:opacity-50"
        >
          Approve {heldCount} held {heldCount === 1 ? 'action' : 'actions'} across {eligible.length}{' '}
          {eligible.length === 1 ? 'item' : 'items'}
        </button>
        <span className="text-[10px] text-[var(--color-muted)]">
          Each item is approved exactly as shown; if one has moved on, nothing is approved and the
          list refreshes.
        </span>
      </div>
      <LiveStatus outcome={change.outcome} />
    </div>
  );
}

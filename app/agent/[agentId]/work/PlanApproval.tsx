'use client';

import { useId, useState } from 'react';
import type { Id, Doc } from '@convex/_generated/dataModel';

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

'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Id, Doc } from '@convex/_generated/dataModel';
import { type WorkGate, writesWhenRunFinishes } from '@/work/item-display';
import { Button } from '../../../components/Button';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { Help, ItemFoot, ItemSection } from './ItemParts';

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
 * The consequence line under a plan's Approve: what approving starts, and whether its writes
 * still wait for the manager. A plan redrafted after a cancel says on its own note that it waited
 * for the manager whatever the switch says.
 *
 * @param autonomous - Whether autonomous actions are on.
 * @param gate - The deployment's gate.
 */
export function planApprovalWhy(autonomous: boolean, gate: WorkGate = 'real'): string {
  return `Approving runs the plan. When it finishes, ${writesWhenRunFinishes(autonomous, gate)}.`;
}

/**
 * A pending plan's decision, as round two section 3.7 draws it: each charter question the plan
 * touched with its answer box, the planner's note with an answer for this run, the optional
 * minutes (N11), then Approve and Cancel with the consequence beneath them. Cancel opens a
 * reason, kept with the item and handed to the plan Retry drafts next.
 *
 * The charter's open questions come from their records; the planner's own note (`riskNotes`)
 * may be answered as free text. Every answer reaches the run as approved evidence; a question
 * left blank is simply not answered and stays open.
 */
export function PlanApprovalForm({
  riskNotes,
  questions,
  onApprove,
  onCancel,
  busy = false,
  employeeName = 'the employee',
  autonomousActions = false,
  gate = 'real',
}: {
  riskNotes: string;
  questions: Doc<'managerQuestions'>[];
  onApprove: (decision: PlanApproval) => void;
  /** Cancels the plan with the manager's reason, empty when none was written. */
  onCancel: (reason: string) => void;
  /** Whether a decision on this plan is in flight. */
  busy?: boolean;
  /** Who drafted the plan, as the help under a question names them. */
  employeeName?: string;
  /** Whether autonomous actions are on, for the consequence line. */
  autonomousActions?: boolean;
  /** The deployment's gate, for the consequence line. */
  gate?: WorkGate;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [estimate, setEstimate] = useState('');
  const open = questions.filter((question) => !question.answer);
  const planNote = riskNotes.trim();
  const minutes = typedEstimateMinutes(estimate);
  const id = useId();
  const reasonField = useRef<HTMLInputElement>(null);
  // The reason is the next thing the manager writes once Cancel opens it.
  useEffect(() => {
    if (cancelling) reasonField.current?.focus();
  }, [cancelling]);
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
    <>
      {open.map((question) => (
        <ItemSection key={question._id} title="A question from your charter">
          <label htmlFor={`${id}-${question._id}`} className="text-[15px] text-[var(--color-fg)]">
            {question.question}
          </label>
          <Help id={`${id}-${question._id}-why`}>
            Asked because the {question.context.touchedBy} touches it
            {question.context.words.length > 0 ? ` (${question.context.words.join(', ')})` : ''}.
            Your answer is written into the charter with the approval and {employeeName} does not
            ask again. Optional: a question left blank stays open.
          </Help>
          <input
            id={`${id}-${question._id}`}
            type="text"
            value={answers[question._id] ?? ''}
            disabled={busy}
            onChange={(event) =>
              setAnswers((current) => ({ ...current, [question._id]: event.target.value }))
            }
            aria-label={`answer: ${question.question}`}
            aria-describedby={`${id}-${question._id}-why`}
            className={`${INPUT_CLASS} w-full`}
          />
        </ItemSection>
      ))}
      {planNote ? (
        <ItemSection title="Planner's note">
          <p className="text-sm text-[var(--color-fg-2)]">{planNote}</p>
          <Field label="Your answer to the note, for this run (optional)">
            {(control) => (
              <input
                {...control}
                type="text"
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
                className={`${INPUT_CLASS} w-full`}
              />
            )}
          </Field>
        </ItemSection>
      ) : null}
      <ItemSection>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--color-fg)]">
          <label htmlFor={id}>This would have taken me about</label>
          <input
            id={id}
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={estimate}
            disabled={busy}
            onChange={(event) => setEstimate(event.target.value)}
            aria-describedby={`${id}-hint`}
            aria-invalid={minutes === null}
            className={`${INPUT_CLASS} w-24`}
          />
          <span>minutes</span>
          <span
            id={`${id}-hint`}
            className={`basis-full text-[13px] ${minutes === null ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'}`}
          >
            {minutes === null
              ? 'A whole number of minutes, or leave it empty.'
              : 'Optional. Summed over finished work as hours saved, a gauge for you, never a headline.'}
          </span>
        </div>
      </ItemSection>
      <ItemFoot why={planApprovalWhy(autonomousActions, gate)}>
        <Button
          variant="approve"
          size="large"
          onClick={() => onApprove(decision())}
          disabled={busy || minutes === null}
        >
          {open.length > 0 || planNote ? 'Approve plan with answers' : 'Approve plan'}
        </Button>
        <Button
          aria-expanded={cancelling}
          aria-controls={cancelling ? `${id}-cancel` : undefined}
          disabled={busy}
          onClick={() => setCancelling((shown) => !shown)}
        >
          Cancel this item
        </Button>
      </ItemFoot>
      {cancelling ? (
        <ItemSection>
          <div id={`${id}-cancel`} className="grid gap-3">
            <Field
              label="Reason for cancelling (optional)"
              hint="Kept with the item. Retry drafts a new plan from it, unless you give a note in its place."
            >
              {(control) => (
                <input
                  {...control}
                  ref={reasonField}
                  type="text"
                  value={cancelReason}
                  disabled={busy}
                  onChange={(event) => setCancelReason(event.target.value)}
                  className={`${INPUT_CLASS} w-full`}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="small"
                disabled={busy}
                onClick={() => onCancel(cancelReason.trim())}
              >
                {cancelReason.trim() ? 'Cancel with this reason' : 'Cancel without a reason'}
              </Button>
              <Button
                variant="quiet"
                size="small"
                disabled={busy}
                onClick={() => setCancelling(false)}
              >
                Keep the plan
              </Button>
            </div>
          </div>
        </ItemSection>
      ) : null}
    </>
  );
}

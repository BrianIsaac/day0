'use client';

import type { Doc } from '@convex/_generated/dataModel';
import type { SurfaceRecord } from '@/surfaces/types';
import { draftedWithoutLine } from '@/work/manager-channel';
import { AppliedCorrectionsLine, type KeptCorrection } from '../corrections-panel';
import { Help, ItemSection } from './ItemParts';
import { PlanObligationsLine } from './RunDetails';
import type { PlanObligationsRow } from './work-item';

/** A plan as the card reads it off the row. */
export interface ItemPlan {
  summary: string;
  steps: string[];
  riskNotes: string;
  reversibility: string;
  estimatedMinutes: number;
  expectedOutputType: string;
  obligations?: PlanObligationsRow;
  obligationsFailedOpen?: string;
  appliedCorrections?: string[];
  correctionsRedaction?: 'structural-only';
  appliedAgreements?: string[];
}

/** A working agreement as the plan card names it: its id and its words. */
export interface PlanAgreement {
  readonly _id: string;
  readonly statement: string;
}

/**
 * The item's plan: its estimate and reversibility, the summary, the numbered steps, and the
 * lines that qualify it (a kept correction it applied, what it declares it owes, a ticket it
 * was drafted without, the answers given with it).
 *
 * @param item - The row.
 * @param plan - The row's plan.
 * @param surfaces - The employee's surfaces, to name a system the plan was drafted without.
 * @param corrections - The employee's kept corrections, for the line saying the plan applied one.
 * @param agreements - The employee's working agreements, for the line saying the plan applied one
 *   (W13-R29).
 */
export function PlanSection({
  item,
  plan,
  surfaces,
  corrections,
  agreements = [],
}: {
  item: Doc<'workItems'>;
  plan: ItemPlan;
  surfaces: readonly SurfaceRecord[];
  corrections: readonly KeptCorrection[];
  agreements?: readonly PlanAgreement[];
}) {
  const applied = (plan.appliedAgreements ?? []).flatMap((id) =>
    agreements.filter((agreement) => agreement._id === id),
  );
  const minutes = plan.estimatedMinutes;
  const drafted = item.state === 'plan-pending' ? item.planDraftedWithout : undefined;
  return (
    <ItemSection
      title={`Plan · about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} · ${plan.reversibility}`}
    >
      <p className="text-sm text-[var(--color-fg-2)]">{plan.summary}</p>
      <ol className="grid list-decimal gap-1 pl-5 text-[15px] text-[var(--color-fg)]">
        {plan.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <AppliedCorrectionsLine
        ids={plan.appliedCorrections ?? []}
        corrections={corrections}
        workItemId={item._id}
        redaction={plan.correctionsRedaction}
      />
      {applied.length > 0 ? (
        // Drawn as the applied corrections are, beside them: what the plan carries, not a step.
        <ul className="mt-2 space-y-1 rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 p-2 text-[var(--color-fg)]">
          {applied.map((agreement) => (
            <li key={agreement._id}>Applies your working agreement: ‘{agreement.statement}’</li>
          ))}
        </ul>
      ) : null}
      <PlanObligationsLine
        steps={plan.steps}
        obligations={plan.obligations}
        failedOpen={plan.obligationsFailedOpen}
      />
      {drafted !== undefined ? (
        <p className="text-[13px] text-[var(--color-warn)]">
          {draftedWithoutLine({
            system:
              surfaces.find((surface) => surface.slug === drafted.surfaceSlug)?.displayName ??
              drafted.surfaceSlug,
            subject: drafted.subject,
            cause: drafted.cause,
          })}
        </p>
      ) : null}
      {item.state !== 'plan-pending' && item.managerAnswers && item.managerAnswers.length > 0 ? (
        <div className="grid gap-1">
          <h5 className="text-[13px] font-semibold text-[var(--color-muted)]">
            Answered at approval
          </h5>
          <ul className="grid gap-2 text-sm text-[var(--color-fg-2)]">
            {item.managerAnswers.map((entry) => (
              <li key={`${entry.question}:${entry.answeredAt}`} className="grid gap-0.5">
                <span>{entry.question}</span>
                <span>
                  <span className="text-[var(--color-muted)]">You: </span>
                  <span className="font-medium text-[var(--color-fg)]">{entry.answer}</span>
                </span>
              </li>
            ))}
          </ul>
          {item.managerAnswers.some((entry) => entry.questionId !== undefined) ? (
            <Help>Your answers to the charter&apos;s questions were written into it.</Help>
          ) : null}
        </div>
      ) : null}
    </ItemSection>
  );
}

'use client';

import type { ReactNode } from 'react';
import { ItemSection } from './ItemParts';
import {
  DraftDetails,
  PhaseLabel,
  PlanExecutionLedger,
  RefusedBlockedSteps,
  RefusedClosingDetails,
  RepairNote,
  SessionRestoreNote,
  WithheldActionsDetails,
} from './RunDetails';
import type { PhasedLedgerRow, RunOutput } from './work-item';

/** A box of ledger rows that did not land, in the tone of what happened to them. */
function UnlandedRows({
  tone,
  headline,
  rows,
  fallback,
  notes = true,
}: {
  tone: 'warn' | 'danger';
  headline: string;
  rows: readonly PhasedLedgerRow[];
  fallback: string;
  notes?: boolean;
}) {
  // Danger is drawn on an outline and in text, never on its own fill (A D4 (b)).
  const ground =
    tone === 'warn'
      ? 'border-[var(--color-warn-line)] bg-[var(--color-warn-soft)]'
      : 'border-[var(--color-danger-line)] bg-[var(--color-bg)]';
  const text = tone === 'warn' ? 'text-[var(--color-warn)]' : 'text-[var(--color-danger)]';
  return (
    <div className={`grid gap-1.5 rounded-lg border px-3.5 py-3 ${ground}`}>
      <p className={`text-[15px] font-medium ${text}`}>{headline}</p>
      <ul className="grid gap-1 text-sm text-[var(--color-fg-2)]">
        {rows.map((row, index) => (
          <li key={index} className="break-words">
            <span className="font-mono text-[13px]">{row.tool}</span> - {row.reason ?? fallback}
            <PhaseLabel phase={row.phase} />
            {notes ? (
              <>
                <RepairNote repair={row.repair} />
                <SessionRestoreNote restore={row.sessionRestore} />
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What a run left beyond what landed: a warning when provider evidence had only the structural
 * redaction, the rows Day0's gate refused, the rows that did not reach the work environment, the
 * rows whose outcome is unknown, the step ledger, the closing set a gate refused, the rows an
 * audit withheld, and the draft. The rows that never reached anything are the headline of the
 * card, never a footnote to the draft they came from.
 *
 * @param output - The run's persisted output.
 * @param rows - The run's ledger, as `phasedLedger` gives it.
 * @param title - The item's title, naming the draft's scroll region.
 */
export function RunRecord({
  output,
  rows,
  refused,
  failed,
  unknown,
  title,
}: {
  output: RunOutput | undefined;
  rows: readonly PhasedLedgerRow[];
  refused: readonly PhasedLedgerRow[];
  failed: readonly PhasedLedgerRow[];
  unknown: readonly PhasedLedgerRow[];
  title: string;
}) {
  const parts: ReactNode[] = [];
  if (rows.some((row) => row.redaction === 'structural-only')) {
    parts.push(
      <p
        key="redaction"
        className="rounded-lg border border-[var(--color-warn-line)] bg-[var(--color-warn-soft)] px-3.5 py-3 text-sm text-[var(--color-warn)]"
      >
        Limited redaction: some provider evidence was checked only against known credential values
        and credential formats. It may still contain secrets or personal data.
      </p>,
    );
  }
  if (refused.length > 0) {
    parts.push(
      <UnlandedRows
        key="refused"
        tone="warn"
        headline={`${refused.length} ${refused.length === 1 ? 'action' : 'actions'} refused by Day0's gate · never sent`}
        rows={refused}
        fallback="refused"
        notes={false}
      />,
    );
  }
  if (failed.length > 0) {
    parts.push(
      <UnlandedRows
        key="failed"
        tone="danger"
        headline={`${failed.length} ${failed.length === 1 ? 'action' : 'actions'} did not reach the work environment`}
        rows={failed}
        fallback="unknown reason"
      />,
    );
  }
  if (unknown.length > 0) {
    parts.push(
      <UnlandedRows
        key="unknown"
        tone="warn"
        headline={`${unknown.length} ${unknown.length === 1 ? 'action' : 'actions'} with an unknown outcome · may have landed`}
        rows={unknown}
        fallback="the response was lost"
        notes={false}
      />,
    );
  }
  const steps = output?.planStepOutcomes ?? [];
  const withheld = [
    ...(output?.initial?.withheldActions ?? []),
    ...(output?.withheldActions ?? []),
    ...(output?.refusedClosing?.withheldActions ?? []),
  ];
  const hasDetail =
    parts.length > 0 ||
    steps.length > 0 ||
    output?.refusedClosing !== undefined ||
    withheld.length > 0 ||
    output !== undefined;
  if (!hasDetail) return null;
  return (
    <ItemSection>
      {parts}
      <PlanExecutionLedger outcomes={steps} />
      <RefusedBlockedSteps refused={output?.refusedClosing} />
      <RefusedClosingDetails refused={output?.refusedClosing} />
      <WithheldActionsDetails withheld={withheld} />
      {output ? <DraftDetails output={output} title={title} /> : null}
    </ItemSection>
  );
}

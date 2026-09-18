'use client';

import type { Id } from '../../../convex/_generated/dataModel';
import { managerFeedbackLabel, type ManagerFeedbackKind } from '../../../src/work/manager-feedback';
import { clockTime, clockTimeWithSeconds } from './time';

/**
 * The manager's corrections on the employee's dashboard: what was kept, from
 * which item and when, the later items it was applied to, and the Retire
 * control; and on a plan card, the line that says the plan applies one.
 * Real mode only, as the corrections are.
 */

/** A kept correction as the dashboard reads it from `corrections.listForAgent`. */
export interface KeptCorrection {
  _id: Id<'corrections'>;
  workItemId: Id<'workItems'>;
  kind: ManagerFeedbackKind;
  text: string;
  itemTitle: string;
  createdAt: number;
  retiredAt?: number;
  appliedTo: Id<'workItems'>[];
}

/**
 * The panel's title, with how many corrections are still fed back.
 *
 * Args:
 *   corrections: The kept corrections, retired ones included.
 *
 * Returns:
 *   The card title.
 */
export function keptCorrectionsTitle(corrections: readonly KeptCorrection[]): string {
  const active = corrections.filter((correction) => correction.retiredAt === undefined).length;
  return corrections.length === 0 ? 'Kept corrections' : `Kept corrections · ${active} active`;
}

/** Where a correction was applied, by the titles of the items whose plans applied it. */
function appliedToText(
  appliedTo: readonly string[],
  titles: ReadonlyMap<string, string>,
  retired: boolean,
): string {
  if (appliedTo.length === 0) {
    return retired ? 'never applied' : 'not applied yet: it reaches the next plan for work of the same kind';
  }
  const named = appliedTo.map((id) => {
    const title = titles.get(id);
    return title ? `“${title}”` : 'an item no longer listed';
  });
  return `applied to ${named.join(', ')}`;
}

/**
 * The employee's kept corrections, newest first: each with its kind, the
 * item it came from and when, the later items whose plans applied it, and
 * Retire while it is still fed back.
 *
 * Args:
 *   props: The corrections, the item titles by id, and the retire call.
 *
 * Returns:
 *   The list, or what the panel will hold when nothing is kept yet.
 */
export function KeptCorrectionsPanel({
  corrections,
  titles,
  onRetire,
}: {
  corrections: readonly KeptCorrection[];
  /** The employee's work item titles by id, for where each correction came from and went. */
  titles: ReadonlyMap<string, string>;
  onRetire: (correctionId: Id<'corrections'>) => Promise<unknown>;
}) {
  if (corrections.length === 0) {
    return (
      <p className="text-xs text-[var(--color-muted)]">
        No corrections kept yet. A note given with Retry, a reason for rejecting actions and a
        reason for cancelling a plan are kept here and fed into this employee&apos;s later work of
        the same kind.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {corrections.map((correction) => {
        const retired = correction.retiredAt !== undefined;
        return (
          <li
            key={correction._id}
            className={`p-2 rounded-md border border-[var(--color-border)] text-xs ${retired ? 'opacity-60' : ''}`}
          >
            <p className="text-[10px] text-[var(--color-muted)] mb-0.5">
              <span className="uppercase tracking-wider">{managerFeedbackLabel(correction)}</span> · from “
              {correction.itemTitle}” ·{' '}
              <span title={clockTimeWithSeconds(correction.createdAt)}>{clockTime(correction.createdAt)}</span>
            </p>
            <p className="text-[var(--color-fg)] whitespace-pre-wrap break-words">{correction.text}</p>
            <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
              {appliedToText(correction.appliedTo, titles, retired)}
            </p>
            {correction.retiredAt !== undefined ? (
              <p className="mt-1 text-[10px] text-[var(--color-muted)]">
                retired {clockTime(correction.retiredAt)}: no later plan reads it
              </p>
            ) : (
              <button
                onClick={() => void onRetire(correction._id)}
                className="mt-1 px-2 py-0.5 rounded-md border border-[var(--color-border)] text-[10px] text-[var(--color-fg)]"
              >
                Retire
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The plan card's line for each correction the plan applied.
 *
 * Args:
 *   props: The plan's applied ids, the kept corrections, the card's own item
 *     and whether the planner saw them scrubbed without the span model.
 *
 * Returns:
 *   The lines, or nothing when the plan applied none the dashboard can show.
 */
export function AppliedCorrectionsLine({
  ids,
  corrections,
  workItemId,
  redaction,
}: {
  ids: readonly string[];
  corrections: readonly KeptCorrection[];
  workItemId: Id<'workItems'>;
  redaction?: 'structural-only';
}) {
  const applied = ids.flatMap((id) => corrections.filter((correction) => correction._id === id));
  if (applied.length === 0) return null;
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/30 space-y-1">
      {applied.map((correction) => {
        const source =
          correction.workItemId !== workItemId
            ? correction.itemTitle
            : correction.kind === 'plan-rejection'
              ? "this item's earlier plan"
              : 'this item';
        return (
          <p key={correction._id} className="text-[var(--color-fg)]">
            Applies the manager&apos;s correction from {source} (
            <span title={clockTimeWithSeconds(correction.createdAt)}>{clockTime(correction.createdAt)}</span>
            ): ‘{correction.text}’
          </p>
        );
      })}
      {redaction ? (
        <p className="text-[10px] text-[var(--color-warn)]">
          Limited redaction: the planner read these corrections checked only against known
          credential values and credential formats.
        </p>
      ) : null}
    </div>
  );
}

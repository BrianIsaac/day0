'use client';

import { useId, useRef } from 'react';
import type { Id } from '../../../convex/_generated/dataModel';
import { managerFeedbackLabel, type ManagerFeedbackKind } from '../../../src/work/manager-feedback';
import {
  awaitingCheck,
  awaitingManager,
  checkingLine,
  NOT_KEPT,
  PROPOSALS_DONE,
  PROPOSALS_TITLE,
  proposalQuestion,
  REFUSED_WITHOUT_REASON,
  WITHDRAWN,
  refusalOffersAmendment,
  refusalSentence,
  type AgreementView,
} from '../../../src/work/agreement-words';
import { Button, ButtonLink } from '../../components/Button';
import { Card } from '../../components/Card';
import { useChange } from '../../components/use-change';
import { StatusRegion } from '../../components/StatusRegion';
import { clockTime, clockTimeWithSeconds, useAgentZone } from '../../components/time';

/**
 * The manager's corrections on the employee's dashboard: what was kept, from
 * which item and when, the later items it was applied to, and the Retire
 * control; on a plan card, the line that says the plan applies one; and
 * above them the promotion card, the working agreements Day0 proposes from
 * them (13-W). Real mode only, as the corrections are.
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
    return retired
      ? 'never applied'
      : 'not applied yet: it reaches the next plan for work of the same kind';
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
  const zone = useAgentZone();
  const list = useRef<HTMLUListElement>(null);
  const change = useChange(list);
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
    <>
      <ul ref={list} tabIndex={-1} aria-label="Kept corrections" className="space-y-2">
        {corrections.map((correction) => {
          const retired = correction.retiredAt !== undefined;
          return (
            <li
              key={correction._id}
              className={`p-2 rounded-md border border-[var(--color-border)] text-xs ${retired ? 'border-dashed border-[var(--color-muted)]/40' : ''}`}
            >
              <p className="text-xs text-[var(--color-muted)] mb-0.5">
                <span className="uppercase tracking-wider">{managerFeedbackLabel(correction)}</span>{' '}
                · from “{correction.itemTitle}” ·{' '}
                <span title={clockTimeWithSeconds(correction.createdAt, zone)}>
                  {clockTime(correction.createdAt, zone)}
                </span>
              </p>
              <p
                className={`${retired ? 'text-[var(--color-fg-2)]' : 'text-[var(--color-fg)]'} whitespace-pre-wrap break-words`}
              >
                {correction.text}
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                {appliedToText(correction.appliedTo, titles, retired)}
              </p>
              {correction.retiredAt !== undefined ? (
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  retired {clockTime(correction.retiredAt, zone)}: no later plan reads it
                </p>
              ) : (
                <button
                  type="button"
                  disabled={change.busy}
                  aria-label={`Retire the correction from “${correction.itemTitle}”`}
                  onClick={() =>
                    change.run(() => onRetire(correction._id), {
                      done: `Retired the correction from “${correction.itemTitle}”: no later plan reads it.`,
                      refused: 'The correction was not retired.',
                    })
                  }
                  className="mt-1 min-h-11 px-3 rounded-md border border-[var(--color-border)] text-xs text-[var(--color-fg)] disabled:opacity-50"
                >
                  Retire
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <StatusRegion outcome={change.outcome} />
    </>
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
  const zone = useAgentZone();
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
            <span title={clockTimeWithSeconds(correction.createdAt, zone)}>
              {clockTime(correction.createdAt, zone)}
            </span>
            ): ‘{correction.text}’
          </p>
        );
      })}
      {redaction ? (
        <p className="text-xs text-[var(--color-warn)]">
          Limited redaction: the planner read these corrections checked only against known
          credential values and credential formats.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether the promotion card shows a working agreement: a proposal waiting on the manager, one
 * kept from this tab or a plan approval and waiting on its check, or one refused. What was kept,
 * edited or refused on the Charter tab's card stays there.
 */
function onPromotionCard(row: AgreementView): boolean {
  if (row.sourceType === 'manager-card') return false;
  return awaitingManager(row) || awaitingCheck(row) || row.status === 'refused';
}

/** The buttons of one row, stacked in the narrow aside so a long name or label never runs out. */
const ROW_ACTIONS = 'mt-2 grid gap-2';

/** A row button, full width and allowed to wrap. */
const ROW_BUTTON = 'w-full whitespace-normal';

/**
 * The promotion card (13-W; the wave file's section 7), its own card above the kept corrections:
 * each working agreement Day0 proposes from the manager's corrections with Keep for the employee,
 * Keep for every employee and Not now; each kept one waiting on its check against the charter; and
 * each refused one with why, the clause it contradicts quoted, Amend the charter where the charter
 * settles it, and Dismiss. It stays drawn while the outcome of its last decision is said.
 *
 * @param props - The employee's agreements, its name, the Charter tab, and the two calls.
 * @returns The card, or nothing when nothing waits and nothing is being said.
 */
export function AgreementProposals({
  agreements,
  employeeName,
  charterHref,
  onKeep,
  onDismiss,
}: {
  agreements: readonly AgreementView[];
  employeeName: string;
  /** The Charter tab's amend disclosure, where the charter is amended. */
  charterHref: string;
  onKeep: (agreementId: AgreementView['_id'], forEveryEmployee: boolean) => Promise<unknown>;
  onDismiss: (agreementId: AgreementView['_id']) => Promise<unknown>;
}) {
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const id = useId();
  const shown = agreements.filter(onPromotionCard);
  if (shown.length === 0 && change.outcome === null) return null;
  const keep = (row: AgreementView, forEveryEmployee: boolean): void =>
    change.run(() => onKeep(row._id, forEveryEmployee), {
      done: `Kept for ${forEveryEmployee ? 'every employee' : employeeName}. Day0 checks it against the charter before it takes effect.`,
      refused: 'The working agreement was not kept.',
    });
  const withdraw = (row: AgreementView): void =>
    change.run(() => onDismiss(row._id), {
      done: WITHDRAWN,
      refused: 'The working agreement was not withdrawn.',
    });
  const dismiss = (row: AgreementView, refused: boolean): void =>
    change.run(() => onDismiss(row._id), {
      done: refused ? 'Dismissed.' : 'Set aside: these corrections are not proposed again.',
      refused: refused ? 'The refusal was not dismissed.' : 'The proposal was not set aside.',
    });
  return (
    <Card title={PROPOSALS_TITLE} focusRef={card}>
      {shown.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">{PROPOSALS_DONE}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((row) => {
            const about = `${id}-${row._id}`;
            return (
              <li
                key={row._id}
                className={`p-3 rounded-md border text-sm ${
                  row.status === 'refused'
                    ? 'border-[var(--color-warn-line)]'
                    : 'border-[var(--color-accent-line)] bg-[var(--color-accent)]/5'
                }`}
              >
                {row.status === 'refused' ? (
                  <>
                    <p className="text-xs font-medium uppercase tracking-wider text-[var(--color-warn)]">
                      {NOT_KEPT}
                    </p>
                    <p
                      id={about}
                      className="mt-1 text-[var(--color-fg)] whitespace-pre-wrap break-words"
                    >
                      “{row.statement}”
                    </p>
                    <p className="mt-1 text-[var(--color-fg-2)]">
                      {row.refusal
                        ? refusalSentence(row.refusal, employeeName, 'work')
                        : REFUSED_WITHOUT_REASON}
                    </p>
                    <div className={ROW_ACTIONS}>
                      {row.refusal && refusalOffersAmendment(row.refusal) ? (
                        <ButtonLink
                          href={charterHref}
                          size="small"
                          aria-describedby={about}
                          className={ROW_BUTTON}
                        >
                          Amend the charter
                        </ButtonLink>
                      ) : null}
                      <Button
                        variant="quiet"
                        size="small"
                        disabled={change.busy}
                        aria-label={`Dismiss the refused agreement “${row.statement}”`}
                        className={ROW_BUTTON}
                        onClick={() => dismiss(row, true)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </>
                ) : awaitingCheck(row) ? (
                  <>
                    <p className="text-[var(--color-fg-2)]">
                      {checkingLine(row.statement, 'work')}
                    </p>
                    <div className={ROW_ACTIONS}>
                      <Button
                        variant="quiet"
                        size="small"
                        disabled={change.busy}
                        aria-label={`Withdraw “${row.statement}”`}
                        className={ROW_BUTTON}
                        onClick={() => withdraw(row)}
                      >
                        Withdraw
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p
                      id={about}
                      className="text-[var(--color-fg)] whitespace-pre-wrap break-words"
                    >
                      {proposalQuestion(row, employeeName)}
                    </p>
                    <div className={ROW_ACTIONS}>
                      <Button
                        variant="approve"
                        size="small"
                        disabled={change.busy}
                        aria-describedby={about}
                        className={ROW_BUTTON}
                        onClick={() => keep(row, false)}
                      >
                        Keep for {employeeName}
                      </Button>
                      <Button
                        size="small"
                        disabled={change.busy}
                        aria-describedby={about}
                        className={ROW_BUTTON}
                        onClick={() => keep(row, true)}
                      >
                        Keep for every employee
                      </Button>
                      <Button
                        variant="quiet"
                        size="small"
                        disabled={change.busy}
                        aria-describedby={about}
                        className={ROW_BUTTON}
                        onClick={() => dismiss(row, false)}
                      >
                        Not now
                      </Button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <StatusRegion outcome={change.outcome} />
    </Card>
  );
}

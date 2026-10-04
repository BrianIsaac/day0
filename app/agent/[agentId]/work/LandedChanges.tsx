'use client';

import type { CSSProperties, ReactNode } from 'react';
import { HELD_NOT_APPROVED } from '@/surfaces/policy';
import { MANAGER_REJECTION_PREFIX } from '@/work/needs-manager';
import { NOT_SENT_AFTER_STOP_REASON } from '@/work/reconciliation';
import { Lead, Note } from './ItemParts';
import { PhaseLabel, RepairNote, SessionRestoreNote } from './RunDetails';
import { clipLedgerRow, landedHeadline, type PhasedLedgerRow } from './work-item';

/** The ledger lines after the fourth rise with it, so a long ledger is not waited for. */
const LANDING_STAGGER_CAP = 3;

/** A landed row with its place in the run's ledger, the landing moment's key. */
export type LandedRow = PhasedLedgerRow & { readonly place: number };

/** What a ledger line says happened, drawn as its dot, as the record's lines are. */
type LineKind = 'landed' | 'withheld';

const DOT: Readonly<Record<LineKind, string>> = {
  landed: 'bg-[var(--color-ok)]',
  withheld: 'bg-[var(--color-muted)]',
};

const SAID: Readonly<Record<LineKind, string>> = {
  landed: 'Landed',
  withheld: 'Not sent',
};

/**
 * One line of a run's ledger, drawn as a record line is (`RecordLine`): a dot for what happened,
 * the change in words, and its tool and provider id beneath. It takes the landing's `--i`, which
 * `[data-land] li` reads, so it is the card's own.
 *
 * @param kind - What happened to the row.
 * @param rise - Its place in a landing that is playing, for the stagger; none at rest.
 */
function LedgerLine({
  kind,
  rise,
  children,
  meta,
}: {
  kind: LineKind;
  rise?: number;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <li
      style={
        rise !== undefined
          ? ({ '--i': Math.min(rise, LANDING_STAGGER_CAP) } as CSSProperties)
          : undefined
      }
      className="grid grid-cols-[16px_minmax(0,1fr)] items-baseline gap-x-2.5"
    >
      <span
        aria-hidden="true"
        className={`size-[9px] justify-self-center rounded-full ${DOT[kind]}`}
      />
      <div className="min-w-0 text-[15px] break-words text-[var(--color-fg-2)]">
        <span className="sr-only">{SAID[kind]}: </span>
        {children}
      </div>
      {meta !== undefined ? (
        <span className="col-start-2 text-[13px] break-words text-[var(--color-muted)]">
          {meta}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The small print of a row: the provider's id, the phase, the earlier run it reuses. The effect
 * above it already says what happened in words, so the transport's name is not repeated.
 *
 * @returns The line, or undefined when the row carries none of them.
 */
function rowMeta(row: PhasedLedgerRow): ReactNode {
  if (!row.providerId && !row.phase && !row.reusedFrom) return undefined;
  const parts: ReactNode[] = [];
  if (row.providerId)
    parts.push(
      <span key="id" className="font-mono">
        id {row.providerId}
      </span>,
    );
  if (row.phase) parts.push(<PhaseLabel key="phase" phase={row.phase} />);
  if (row.reusedFrom) {
    parts.push(
      <span key="reused">
        {row.reusedFromRun ? `reused from run ${row.reusedFromRun}` : 'reused from an earlier run'}
      </span>,
    );
  }
  // The parts are set apart, as every ledger line's small print is: never run together.
  return parts.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]));
}

/**
 * What reached the work environment: the green line and a ledger line per landed row, with who
 * decided it after it (round two section 3.7). Rows that just landed while the page was open
 * rise in, 70 ms apart (`[data-land]`, v3 section 5.2); rows that were already there stand
 * still, so the writes an Approve lands on a run whose reads or prerequisites landed first
 * still play (M7).
 *
 * @param rows - The landed rows in ledger order.
 * @param fresh - The places of the rows that just landed; empty when nothing is playing.
 * @param decided - Who decided the run and where, when the manager did.
 * @param withheld - How many rows the manager left out of the approval, said on the green line.
 * @param note - A line that explains the count, set under the headline: autonomous actions turned
 *   on after the plan was drafted, so its text predates the rows applied under the switch.
 */
export function LandedChanges({
  rows,
  fresh,
  decided,
  note,
  withheld = 0,
}: {
  rows: readonly LandedRow[];
  fresh: ReadonlySet<number>;
  decided?: ReactNode;
  note?: ReactNode;
  withheld?: number;
}) {
  const standing = rows.filter((row) => !fresh.has(row.place));
  const arriving = rows.filter((row) => fresh.has(row.place));
  const line = (row: LandedRow, rise?: number) => (
    <LedgerLine key={row.place} kind="landed" rise={rise} meta={rowMeta(row)}>
      {clipLedgerRow(row.effect) ?? `Applied ${row.tool}`}
      <RepairNote repair={row.repair} />
      <SessionRestoreNote restore={row.sessionRestore} />
    </LedgerLine>
  );
  const list = 'grid gap-2';
  const headline = (
    <>
      <Note tone="ok">
        <Lead>
          {landedHeadline(rows)}
          {withheld > 0 ? ` · ${withheld} withheld by you` : ''}
        </Lead>
        {decided ? <> · {decided}</> : null}
      </Note>
      {note}
    </>
  );
  // A first landing settles as a whole; a landing onto rows already there
  // raises only its own lines, beneath them.
  return standing.length === 0 && arriving.length > 0 ? (
    <div data-land="" className="grid gap-3">
      {headline}
      <ul className={list}>{arriving.map((row, rise) => line(row, rise))}</ul>
    </div>
  ) : (
    <div className="grid gap-3">
      {headline}
      <ul className={list}>{standing.map((row) => line(row))}</ul>
      {arriving.length > 0 ? (
        <ul data-land="" className={list}>
          {arriving.map((row, rise) => line(row, rise))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Why a held row was never sent, in the manager's words: left out of an approval, rejected
 * with the run, or held by the gate for the reason it gave.
 *
 * @param reason - The ledger row's reason.
 */
export function notSentWords(reason: string | undefined): string {
  if (reason === HELD_NOT_APPROVED) return 'withheld by you; never sent, kept in the record';
  if (reason?.startsWith(MANAGER_REJECTION_PREFIX)) return 'rejected with the run; never sent';
  // A row a stopped apply never reached (W12-R11): said once, plainly.
  if (reason === NOT_SENT_AFTER_STOP_REASON) return 'not sent: the run stopped before it went out';
  return `held${reason ? `: ${reason}` : ''}; never sent`;
}

/**
 * The run's rows that were held and never sent, each with why: the withheld action kept in the
 * record on a partial landing, the writes a rejected run held.
 *
 * @param rows - The held rows in ledger order.
 */
export function NotSentLedger({ rows }: { rows: readonly PhasedLedgerRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="grid gap-2">
      {rows.map((row, index) => (
        <LedgerLine key={index} kind="withheld" meta={rowMeta(row)}>
          {row.summary ?? clipLedgerRow(row.effect) ?? row.tool}
          <span className="text-[var(--color-muted)]">, {notSentWords(row.reason)}</span>
          <RepairNote repair={row.repair} />
          <SessionRestoreNote restore={row.sessionRestore} />
        </LedgerLine>
      ))}
    </ul>
  );
}

'use client';

import type { CSSProperties } from 'react';
import { clipLedgerRow, landedHeadline, type PhasedLedgerRow } from './work-item';
import { PhaseLabel, RepairNote, SessionRestoreNote } from './RunDetails';

/** The ledger lines after the fourth rise with it, so a long ledger is not waited for. */
const LANDING_STAGGER_CAP = 3;

/** A landed row with its place in the run's ledger, the landing moment's key. */
export type LandedRow = PhasedLedgerRow & { readonly place: number };

/**
 * What reached the work environment: the headline and a line per landed row. Rows that just
 * landed while the page was open rise in, 70 ms apart (`[data-land]`, v3 section 5.2); rows that
 * were already there stand still, so the writes an Approve lands on a run whose reads or
 * prerequisites landed first still play (M7).
 *
 * @param rows - The landed rows in ledger order.
 * @param fresh - The places of the rows that just landed; empty when nothing is playing.
 */
export function LandedChanges({
  rows,
  fresh,
}: {
  rows: readonly LandedRow[];
  fresh: ReadonlySet<number>;
}) {
  const standing = rows.filter((row) => !fresh.has(row.place));
  const arriving = rows.filter((row) => fresh.has(row.place));
  const line = (row: LandedRow, rise?: number) => (
    <li
      key={row.place}
      style={
        rise !== undefined
          ? ({ '--i': Math.min(rise, LANDING_STAGGER_CAP) } as CSSProperties)
          : undefined
      }
    >
      <span className="font-mono text-[10px] text-[var(--color-muted)]">{row.tool}</span>{' '}
      {clipLedgerRow(row.effect) ?? '(applied)'}
      {row.providerId ? (
        <span className="ml-1 font-mono text-[10px] text-[var(--color-muted)]">
          id {row.providerId}
        </span>
      ) : null}
      <PhaseLabel phase={row.phase} />
      {row.reusedFrom ? (
        <span className="ml-1 text-[10px] text-[var(--color-muted)]">
          {row.reusedFromRun
            ? `reused from run ${row.reusedFromRun}`
            : 'reused from an earlier run'}
        </span>
      ) : null}
      <RepairNote repair={row.repair} />
      <SessionRestoreNote restore={row.sessionRestore} />
    </li>
  );
  const list = 'space-y-0.5 text-[var(--color-fg)]';
  const headline = (
    <p className="text-[var(--color-ok)] font-medium mb-1">{landedHeadline(rows)}</p>
  );
  // A first landing settles as a whole; a landing onto rows already there
  // raises only its own lines, beneath them.
  return (
    <div className="mt-3 p-2 rounded-md bg-[var(--color-ok)]/10 border border-[var(--color-ok)]/30 text-xs">
      {standing.length === 0 && arriving.length > 0 ? (
        <div data-land="">
          {headline}
          <ul className={list}>{arriving.map((row, rise) => line(row, rise))}</ul>
        </div>
      ) : (
        <>
          {headline}
          <ul className={list}>{standing.map((row) => line(row))}</ul>
          {arriving.length > 0 ? (
            <ul data-land="" className={list}>
              {arriving.map((row, rise) => line(row, rise))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

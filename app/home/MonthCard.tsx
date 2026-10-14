import { dayKey, deploymentZone } from '@/lib/zone';
import type { OwnerMetrics } from '@/metrics/types';
import { coverageLine, type CompanyCoverage } from './company-coverage';
import { MonthGrid, monthName } from './MonthGrid';
import { SupervisionFigures } from './SupervisionFigures';
import type { RosterRow } from './types';

/**
 * Items landed per day this month across the employees, keyed `YYYY-MM-DD`, and those finished
 * partly done, named beside them (RM23 (a)). An employee whose own zone is already in another
 * month adds nothing.
 */
function finishedByDay(
  roster: readonly RosterRow[],
  month: string,
): { landed: Map<string, number>; partly: Map<string, number> } {
  const landedOn = new Map<string, number>();
  const partlyOn = new Map<string, number>();
  for (const employee of roster) {
    if (employee.landedThisMonth.month !== month) continue;
    for (const { day, landed, partly } of employee.landedThisMonth.days) {
      landedOn.set(day, (landedOn.get(day) ?? 0) + landed);
      if (partly !== undefined && partly > 0) partlyOn.set(day, (partlyOn.get(day) ?? 0) + partly);
    }
  }
  return { landed: landedOn, partly: partlyOn };
}

/**
 * The company's today: the day the employees are in, each in its own zone (N12, 16-F), where the
 * card once read the viewer's. Where their zones put them on different days, the day most of them
 * are in, and of two as common the later; with no employee's day to read (a backend from before
 * the field), the viewer's.
 *
 * @param roster - The owner's employees, each with its own today.
 * @param now - The page's clock.
 */
export function companyToday(roster: readonly RosterRow[], now: number): string {
  const counts = new Map<string, number>();
  for (const { today } of roster) {
    if (typeof today === 'string') counts.set(today, (counts.get(today) ?? 0) + 1);
  }
  const [first] = [...counts].sort(
    ([leftDay, left], [rightDay, right]) => right - left || rightDay.localeCompare(leftDay),
  );
  return first?.[0] ?? dayKey(now, deploymentZone());
}

/**
 * The month, supervised from here: the month grid of what landed and what
 * waits, beside the company's supervision figures. Counts from this
 * account's ledger, not rates.
 *
 * @param roster - The owner's employees, each with what it landed this month.
 * @param figures - The owner's figures, absent until the first employee has any.
 * @param coverage - Which employees the figures cover: past twenty, said over them (RM33 (a)).
 * @param waiting - What waits on the manager now, placed on today.
 * @param now - The page's clock; the month and today are the employees' ({@link companyToday}).
 */
export function MonthCard({
  roster,
  figures,
  coverage = { kind: 'all' },
  waiting,
  now,
}: {
  roster: readonly RosterRow[];
  figures: OwnerMetrics | null | undefined;
  coverage?: CompanyCoverage;
  waiting: number;
  now: number;
}) {
  const covered = coverageLine(coverage);
  const today = companyToday(roster, now);
  const month = today.slice(0, 7);
  const finished = finishedByDay(roster, month);
  const partial = roster.some(
    (employee) => employee.landedThisMonth.month === month && employee.landedThisMonth.atLeast,
  );
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">{monthName(month)}, supervised from here</h2>
        <span className="text-xs text-[var(--color-muted)]">counts from this account’s ledger</span>
      </div>
      <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-start">
        <MonthGrid
          month={month}
          today={today}
          landed={finished.landed}
          partly={finished.partly}
          waitingToday={waiting}
        />
        {figures && figures.employees.length > 0 ? (
          covered === undefined ? (
            <SupervisionFigures company={figures.company} />
          ) : (
            <div className="grid gap-2">
              <p className="text-xs tabular-nums text-[var(--color-muted)]">{covered}</p>
              <SupervisionFigures company={figures.company} />
            </div>
          )
        ) : null}
      </div>
      <p className="px-5 pb-4 text-xs text-[var(--color-muted)]">
        Recomputable from the export. Not rates.
        {partial ? ' A busy month counts only its latest landings per employee here.' : ''}
      </p>
    </section>
  );
}

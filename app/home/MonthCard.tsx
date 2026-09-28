import { dayKey, deploymentZone } from '@/lib/zone';
import type { OwnerMetrics } from '@/metrics/types';
import { MonthGrid, monthName } from './MonthGrid';
import { SupervisionFigures } from './SupervisionFigures';
import type { RosterRow } from './types';

/**
 * Items landed per day this month across the employees, keyed `YYYY-MM-DD`.
 * An employee whose own zone is already in another month adds nothing.
 */
function landedByDay(roster: readonly RosterRow[], month: string): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const employee of roster) {
    if (employee.landedThisMonth.month !== month) continue;
    for (const { day, landed } of employee.landedThisMonth.days) {
      byDay.set(day, (byDay.get(day) ?? 0) + landed);
    }
  }
  return byDay;
}

/**
 * The month, supervised from here: the month grid of what landed and what
 * waits, beside the company's supervision figures. Counts from this
 * account's ledger, not rates.
 *
 * @param roster - The owner's employees, each with what it landed this month.
 * @param figures - The owner's figures, absent until the first employee has any.
 * @param waiting - What waits on the manager now, placed on today.
 * @param now - The page's clock; the month and today are the manager's.
 */
export function MonthCard({
  roster,
  figures,
  waiting,
  now,
}: {
  roster: readonly RosterRow[];
  figures: OwnerMetrics | null | undefined;
  waiting: number;
  now: number;
}) {
  const today = dayKey(now, deploymentZone());
  const month = today.slice(0, 7);
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
          landed={landedByDay(roster, month)}
          waitingToday={waiting}
        />
        {figures && figures.employees.length > 0 ? (
          <SupervisionFigures company={figures.company} />
        ) : null}
      </div>
      <p className="px-5 pb-4 text-xs text-[var(--color-muted)]">
        Recomputable from the export. Not rates.
        {partial ? ' A busy month counts its first hundred landings per employee here.' : ''}
      </p>
    </section>
  );
}

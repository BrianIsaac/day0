/** A landed count at or above this tones the day as busy. */
const BUSY_DAY = 5;

/** The month's days as `YYYY-MM-DD` keys. */
function daysOf(month: string): string[] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

/**
 * A month's name in words, from its `YYYY-MM` key.
 *
 * @param month - The month, `YYYY-MM`.
 */
export function monthName(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(
    Date.UTC(year, monthNumber - 1, 1),
  );
}

/** The tone of one day: busy, light, today with something waiting, still to come, or quiet. */
function dayTone(landed: number, isToday: boolean, waiting: number, future: boolean): string {
  if (isToday && waiting > 0) return 'border-[var(--color-warn)]/60 bg-[var(--color-warn)]/10';
  if (landed >= BUSY_DAY) return 'border-[var(--color-ok)]/40 bg-[var(--color-ok)]/25';
  if (landed > 0) return 'border-[var(--color-ok)]/25 bg-[var(--color-ok)]/10';
  if (future) return 'border-[var(--color-border)]/50 text-[var(--color-muted)]';
  return 'border-[var(--color-border)] bg-[var(--color-bg)]';
}

/**
 * The month as the manager supervised it: each day with what landed on it,
 * today with what still waits, the days to come dimmed. Counts, not rates.
 *
 * @param month - The month, `YYYY-MM`.
 * @param today - Today, `YYYY-MM-DD`, in the manager's zone.
 * @param landed - Items landed per day, keyed `YYYY-MM-DD`.
 * @param waitingToday - What waits on the manager now, placed on today.
 */
export function MonthGrid({
  month,
  today,
  landed,
  waitingToday,
}: {
  month: string;
  today: string;
  landed: ReadonlyMap<string, number>;
  waitingToday: number;
}) {
  return (
    <ol aria-label={`Days of ${monthName(month)}`} className="grid grid-cols-7 gap-1.5">
      {daysOf(month).map((day) => {
        const count = landed.get(day) ?? 0;
        const isToday = day === today;
        const notes = [
          ...(count > 0 ? [`${count} landed`] : []),
          ...(isToday && waitingToday > 0 ? [`${waitingToday} waiting`] : []),
        ];
        return (
          <li
            key={day}
            aria-current={isToday ? 'date' : undefined}
            className={`min-h-12 rounded-md border p-1.5 text-xs leading-snug sm:min-h-16 ${dayTone(count, isToday, waitingToday, day > today)}`}
          >
            <span className="block font-semibold">{Number(day.slice(8))}</span>
            {notes.length > 0 ? (
              <span className="block text-[var(--color-fg)]/80 max-sm:sr-only">
                {notes.join(' · ')}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A landed count at or above this tones the day as busy. */
const BUSY_DAY = 5;

/** The weekdays' initials, Monday first as a British calendar sets them. */
const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

/** The month's days as `YYYY-MM-DD` keys. */
function daysOf(month: string): string[] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`);
}

/** The column, Monday being 0, that a month's first day falls in. */
function firstWeekday(month: string): number {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  return (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
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
 * today with what still waits, the days to come dimmed, under Monday-first
 * weekday initials. From `sm` up each day says it in words; on a phone the
 * cells hold the bare counts (the words stay for a screen reader) and a line
 * under the grid says what they are, so colour never carries the count alone.
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
  const offset = firstWeekday(month);
  return (
    <div>
      <div
        aria-hidden="true"
        className="mb-1.5 grid grid-cols-7 gap-1.5 text-center text-xs text-[var(--color-muted)]"
      >
        {WEEKDAY_INITIALS.map((initial, index) => (
          <span key={index}>{initial}</span>
        ))}
      </div>
      <ol aria-label={`Days of ${monthName(month)}`} className="grid grid-cols-7 gap-1.5">
        {daysOf(month).map((day, index) => {
          const count = landed.get(day) ?? 0;
          const isToday = day === today;
          const waiting = isToday ? waitingToday : 0;
          return (
            <li
              key={day}
              aria-current={isToday ? 'date' : undefined}
              style={index === 0 && offset > 0 ? { gridColumnStart: offset + 1 } : undefined}
              className={`min-h-12 rounded-md border p-1.5 text-xs leading-snug sm:min-h-16 ${dayTone(count, isToday, waiting, day > today)}`}
            >
              <span className="block font-semibold">{Number(day.slice(8))}</span>
              {count > 0 ? (
                <span className="block text-[var(--color-fg)]/80 max-sm:sr-only">
                  {count} landed
                </span>
              ) : null}
              {waiting > 0 ? (
                <span className="block text-[var(--color-fg)]/80 max-sm:sr-only">
                  {waiting} waiting
                </span>
              ) : null}
              {count > 0 ? (
                <span aria-hidden="true" className="block tabular-nums sm:hidden">
                  {count}
                </span>
              ) : null}
              {waiting > 0 ? (
                <span
                  aria-hidden="true"
                  className="block tabular-nums text-[var(--color-warn)] sm:hidden"
                >
                  {waiting}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-xs text-[var(--color-muted)] sm:hidden">
        Under each day, what landed; today’s amber number is what waits on you.
      </p>
    </div>
  );
}

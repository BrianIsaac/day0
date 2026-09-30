/** How the pages print a day, in British English: `12 September 2026`. */
const dayFormat = { day: 'numeric', month: 'long', year: 'numeric' } as const;

/**
 * The day an instant falls on in a named zone, as the pages print it.
 *
 * @param instant - Milliseconds since the epoch.
 * @param timeZone - An IANA zone name, such as `Asia/Singapore`.
 * @throws RangeError when `timeZone` is not a zone the runtime's Intl knows.
 */
export function dayLabelAt(instant: number, timeZone: string): string {
  return new Date(instant).toLocaleDateString('en-GB', { ...dayFormat, timeZone });
}

/** A `YYYY-MM-DD` day as the pages print it, in British English: `12 September 2026`. */
export function dayLabel(day: string): string {
  return dayLabelAt(Date.parse(`${day}T00:00:00Z`), 'UTC');
}

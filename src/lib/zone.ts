/**
 * The agent's day (decision N12): one zone per agent, stored on `agents`,
 * used server-side for every day boundary and by the dashboard for every
 * stamp.
 *
 * Everything here is calendar arithmetic in a named IANA zone, read through
 * `Intl`, so it gives the same answer on the backend, in the browser and in
 * a test whatever the host's own zone. The one read of the host's zone is
 * `deploymentZone`, the fallback for an agent deployed before it had one.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** How long after the top of its hour a zone's hour still counts as starting. */
const HOUR_START_WINDOW_MINUTES = 15;

/** The calendar and clock of one instant in one zone. */
export interface ZonedParts {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
  /** 0 to 23. */
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function partsFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
}

/**
 * Whether a value names a zone the runtime knows.
 *
 * @returns True for an IANA name such as `Asia/Singapore` or `UTC`.
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  try {
    partsFormatter(value);
    return true;
  } catch {
    // RangeError: not a zone this runtime's ICU data knows.
    return false;
  }
}

/**
 * The zone the process runs in: the deployment's own on the backend (UTC
 * unless `TZ` is set), the viewer's in the browser.
 */
export function deploymentZone(): string {
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimeZone(zone) ? zone : 'UTC';
}

/**
 * The zone an agent's day is measured in: its own when it names a valid one,
 * the deployment's otherwise.
 */
export function agentZone(agent: { readonly zone?: string }): string {
  return isTimeZone(agent.zone) ? agent.zone : deploymentZone();
}

/** The calendar and clock of an instant in a zone. */
export function zonedParts(ms: number, zone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of partsFormatter(zone).formatToParts(ms)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * The day an instant falls on in a zone, as `YYYY-MM-DD`: the day bucket
 * for a daily cap (A11), a per-day budget (N9) and the export's dates.
 */
export function dayKey(ms: number, zone: string): string {
  const { year, month, day } = zonedParts(ms, zone);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function parseDayKey(key: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`not a calendar date: ${key}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** A calendar date moved by whole days; days, not multiples of 24 hours. */
export function addDays(key: string, days: number): string {
  const { year, month, day } = parseDayKey(key);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** How far a zone's clock is ahead of UTC at an instant, in milliseconds. */
function offsetMs(ms: number, zone: string): number {
  const { year, month, day, hour, minute, second } = zonedParts(ms, zone);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - (ms - (((ms % 1_000) + 1_000) % 1_000));
}

/**
 * The instant a calendar day begins in a zone: its midnight, or on a day
 * whose midnight a clock change skipped, its first instant.
 */
export function dayStart(key: string, zone: string): number {
  const { year, month, day } = parseDayKey(key);
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  // Two passes settle the offset on either side of a change near midnight.
  let candidate = midnightAsUtc - offsetMs(midnightAsUtc, zone);
  candidate = midnightAsUtc - offsetMs(candidate, zone);
  if (dayKey(candidate, zone) < key) {
    // The midnight does not exist: the day starts when the clock jumps.
    while (dayKey(candidate, zone) < key) candidate += 15 * 60_000;
    while (dayKey(candidate - 60_000, zone) === key) candidate -= 60_000;
  }
  return candidate;
}

/** The instant the day holding `ms` began, in a zone. */
export function startOfDay(ms: number, zone: string): number {
  return dayStart(dayKey(ms, zone), zone);
}

/** The day a week before an access end date, in the agent's zone: Q5's notice day. */
export function expiryNoticeDay(expiresAt: number, zone: string): string {
  return addDays(dayKey(expiresAt, zone), -7);
}

/**
 * Whether the week's notice of an ending access is due: from the notice
 * day's start in the agent's zone until the access ends.
 */
export function expiryNoticeDue(now: number, expiresAt: number, zone: string): boolean {
  return now < expiresAt && dayKey(now, zone) >= expiryNoticeDay(expiresAt, zone);
}

/**
 * Whether an instant falls in the first quarter hour of the zone's own hour.
 * A job that runs every quarter hour then acts once per local hour, on the
 * hour, in a zone with a half or three-quarter hour offset too.
 */
export function isHourStart(ms: number, zone: string): boolean {
  return zonedParts(ms, zone).minute < HOUR_START_WINDOW_MINUTES;
}

/**
 * An instant as a person reads it, always with its date: `28 Sep 2026, 14:05`.
 *
 * Built from the parts rather than a locale's pattern, so the backend, the
 * browser and every ICU version print the same text.
 */
export function formatStamp(
  ms: number,
  zone: string,
  options: { readonly seconds?: boolean } = {},
): string {
  const { year, month, day, hour, minute, second } = zonedParts(ms, zone);
  const clock = `${pad(hour)}:${pad(minute)}${options.seconds ? `:${pad(second)}` : ''}`;
  return `${day} ${MONTHS[month - 1]} ${year}, ${clock}`;
}

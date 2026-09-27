import { describe, expect, it } from 'vitest';
import {
  addDays,
  agentZone,
  canonicalZone,
  dayKey,
  dayStart,
  deploymentZone,
  expiryNoticeDay,
  expiryNoticeDue,
  formatStamp,
  isHourStart,
  isTimeZone,
  startOfDay,
} from '../../../src/lib/zone';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('the zone an agent’s day is measured in', (): void => {
  it('accepts IANA names the runtime knows and refuses anything else', (): void => {
    expect(isTimeZone('Asia/Singapore')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(8)).toBe(false);
  });

  it('spells a zone as the runtime does, and names none for a stranger', (): void => {
    expect(canonicalZone('asia/singapore')).toBe('Asia/Singapore');
    expect(canonicalZone('UTC')).toBe('UTC');
    expect(canonicalZone('Mars/Olympus')).toBeUndefined();
  });

  it('is the agent’s own zone when it names a valid one, and the deployment’s otherwise', (): void => {
    expect(agentZone({ zone: 'Asia/Kolkata' })).toBe('Asia/Kolkata');
    expect(agentZone({})).toBe(deploymentZone());
    expect(agentZone({ zone: 'Nowhere/Else' })).toBe(deploymentZone());
  });

  it('reads the deployment’s zone from the process, which the test run pins to UTC', (): void => {
    expect(deploymentZone()).toBe('UTC');
  });
});

describe('the day bucket', (): void => {
  const lateEveningUtc = Date.UTC(2026, 8, 27, 16, 30);

  it('puts one instant on different days in different zones', (): void => {
    expect(dayKey(lateEveningUtc, 'UTC')).toBe('2026-09-27');
    expect(dayKey(lateEveningUtc, 'Asia/Singapore')).toBe('2026-09-28');
    expect(dayKey(lateEveningUtc, 'America/New_York')).toBe('2026-09-27');
  });

  it('turns over at the zone’s midnight, not at 08:00 in Singapore', (): void => {
    const singaporeMidnight = Date.UTC(2026, 8, 27, 16, 0);
    expect(startOfDay(lateEveningUtc, 'Asia/Singapore')).toBe(singaporeMidnight);
    expect(dayKey(singaporeMidnight - 1, 'Asia/Singapore')).toBe('2026-09-27');
    expect(dayKey(singaporeMidnight, 'Asia/Singapore')).toBe('2026-09-28');
  });

  it('keeps half-hour and three-quarter-hour offsets', (): void => {
    expect(startOfDay(lateEveningUtc, 'Asia/Kolkata')).toBe(Date.UTC(2026, 8, 26, 18, 30));
    expect(startOfDay(lateEveningUtc, 'Asia/Kathmandu')).toBe(Date.UTC(2026, 8, 26, 18, 15));
  });

  it('starts a day with no midnight at its first instant', (): void => {
    // Brazil moved its clocks forward at midnight on 4 November 2018.
    const start = dayStart('2018-11-04', 'America/Sao_Paulo');
    expect(start).toBe(Date.UTC(2018, 10, 4, 3, 0));
    expect(dayKey(start, 'America/Sao_Paulo')).toBe('2018-11-04');
    expect(dayKey(start - 1, 'America/Sao_Paulo')).toBe('2018-11-03');
  });

  it('measures a day across a daylight-saving change by the calendar, not by 24 hours', (): void => {
    const beforeChange = dayStart('2026-10-24', 'Europe/London');
    const afterChange = dayStart('2026-10-26', 'Europe/London');
    expect(afterChange - beforeChange).toBe(2 * DAY + HOUR);
  });

  it('shifts a calendar date by whole days across months and years', (): void => {
    expect(addDays('2026-10-03', -7)).toBe('2026-09-26');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('the expiry notice (Q5)', (): void => {
  const expiresAt = Date.UTC(2026, 9, 10, 2, 0);

  it('falls on the day a week before the end date in the agent’s zone', (): void => {
    expect(expiryNoticeDay(expiresAt, 'Asia/Singapore')).toBe('2026-10-03');
    expect(expiryNoticeDay(expiresAt, 'America/Los_Angeles')).toBe('2026-10-02');
  });

  it('is due from that day’s midnight in the zone until the access ends', (): void => {
    const noticeMidnight = Date.UTC(2026, 9, 2, 16, 0);
    expect(expiryNoticeDue(noticeMidnight - 1, expiresAt, 'Asia/Singapore')).toBe(false);
    expect(expiryNoticeDue(noticeMidnight, expiresAt, 'Asia/Singapore')).toBe(true);
    expect(expiryNoticeDue(expiresAt, expiresAt, 'Asia/Singapore')).toBe(false);
  });
});

describe('a stamp', (): void => {
  it('carries the date and the time in the zone it is read in', (): void => {
    const at = Date.UTC(2026, 8, 27, 16, 5, 9);
    expect(formatStamp(at, 'Asia/Singapore')).toBe('28 Sep 2026, 00:05');
    expect(formatStamp(at, 'UTC')).toBe('27 Sep 2026, 16:05');
    expect(formatStamp(at, 'UTC', { seconds: true })).toBe('27 Sep 2026, 16:05:09');
  });
});

describe('the top of an hour', (): void => {
  it('is the first quarter of the zone’s own hour, so a 45-minute offset gets its digest on its hour', (): void => {
    expect(isHourStart(Date.UTC(2026, 8, 27, 16, 0), 'Asia/Singapore')).toBe(true);
    expect(isHourStart(Date.UTC(2026, 8, 27, 16, 15), 'Asia/Singapore')).toBe(false);
    expect(isHourStart(Date.UTC(2026, 8, 27, 16, 15), 'Asia/Kathmandu')).toBe(true);
    expect(isHourStart(Date.UTC(2026, 8, 27, 16, 30), 'Asia/Kolkata')).toBe(true);
    expect(isHourStart(Date.UTC(2026, 8, 27, 16, 0), 'Asia/Kolkata')).toBe(false);
  });
});

describe('UTC without zone data', (): void => {
  it('computes UTC from the clock alone, so a runtime with no zone data still has a day', (): void => {
    expect(isTimeZone('UTC')).toBe(true);
    expect(dayKey(Date.UTC(2026, 11, 31, 23, 59), 'UTC')).toBe('2026-12-31');
    expect(formatStamp(Date.UTC(2026, 0, 2, 3, 4, 5), 'UTC', { seconds: true })).toBe(
      '2 Jan 2026, 03:04:05',
    );
  });
});

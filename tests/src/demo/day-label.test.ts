import { describe, expect, it } from 'vitest';
import { dayLabel, dayLabelAt } from '../../../src/demo/day-label';

describe('dayLabel', () => {
  it('prints a day in British English, whatever zone the machine is in', () => {
    expect(dayLabel('2026-09-03')).toBe('3 September 2026');
    expect(dayLabel('2026-12-31')).toBe('31 December 2026');
  });
});

describe('dayLabelAt', () => {
  /** 29 September 2026, 23:30 UTC: 30 September, 07:30, in Singapore. */
  const BEFORE_UTC_MIDNIGHT = Date.UTC(2026, 8, 29, 23, 30);
  /** 30 September 2026, 00:30 UTC: 30 September, 08:30, in Singapore. */
  const AFTER_UTC_MIDNIGHT = Date.UTC(2026, 8, 30, 0, 30);

  it('prints the day an instant falls on in the zone it is given, not the machine’s', () => {
    expect(dayLabelAt(BEFORE_UTC_MIDNIGHT, 'Asia/Singapore')).toBe('30 September 2026');
    expect(dayLabelAt(BEFORE_UTC_MIDNIGHT, 'UTC')).toBe('29 September 2026');
    expect(dayLabelAt(AFTER_UTC_MIDNIGHT, 'Asia/Singapore')).toBe('30 September 2026');
    expect(dayLabelAt(AFTER_UTC_MIDNIGHT, 'UTC')).toBe('30 September 2026');
  });
});

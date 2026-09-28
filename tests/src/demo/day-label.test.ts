import { describe, expect, it } from 'vitest';
import { dayLabel } from '../../../src/demo/day-label';

describe('dayLabel', () => {
  it('prints a day in British English, whatever zone the machine is in', () => {
    expect(dayLabel('2026-09-03')).toBe('3 September 2026');
    expect(dayLabel('2026-12-31')).toBe('31 December 2026');
  });
});

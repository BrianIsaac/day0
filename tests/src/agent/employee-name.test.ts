import { describe, expect, it } from 'vitest';
import {
  clippedEmployeeName,
  EMPLOYEE_NAME_MAX_CHARS,
  isEmployeeNameWithinBound,
  visibleEmployeeName,
} from '../../../src/agent/employee-name';

describe('employee-name', (): void => {
  it('reads a name as one trimmed line without hidden characters', (): void => {
    expect(visibleEmployeeName('  Ma​ya‮ \n\t Lim﻿ ')).toBe('Maya Lim');
  });

  it('bounds a name at 80 characters as a reader counts them', (): void => {
    expect(EMPLOYEE_NAME_MAX_CHARS).toBe(80);
    expect(isEmployeeNameWithinBound('M'.repeat(80))).toBe(true);
    expect(isEmployeeNameWithinBound('M'.repeat(81))).toBe(false);
    expect(isEmployeeNameWithinBound('\u{1F431}'.repeat(80))).toBe(true);
    expect(isEmployeeNameWithinBound(`${'M'.repeat(80)}​​  `)).toBe(true);
  });

  it('clips a name stored before the bound to 80 characters, trimmed', (): void => {
    expect(clippedEmployeeName('M'.repeat(100_000))).toBe('M'.repeat(80));
    expect(clippedEmployeeName(`${'M'.repeat(79)} tail`)).toBe('M'.repeat(79));
    expect(clippedEmployeeName('\u{1F431}'.repeat(90))).toBe('\u{1F431}'.repeat(80));
  });
});

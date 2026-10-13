import { describe, expect, it } from 'vitest';
import {
  NO_OVERLAP_REASON,
  NO_OVERLAP_REASON_BEFORE_0_20,
  skipClause,
} from '../../../src/work/skip-reasons';

describe('skipClause: a skip reason as a manager reads it (RM21 (c), W19-7)', (): void => {
  it('says the lexical rule in plain words, the v0.19.0 sentence included, with no label', (): void => {
    const words =
      'nothing in it is part of the role or its will-do clauses, and it names no system the role is connected to';
    expect(skipClause(NO_OVERLAP_REASON)).toBe(words);
    expect(skipClause(NO_OVERLAP_REASON_BEFORE_0_20)).toBe(words);
  });

  it('takes every machine label off, and says a quality-fit skip as such', (): void => {
    expect(skipClause('out-of-scope: forecasting work assigned to Aman')).toBe(
      'forecasting work assigned to Aman',
    );
    expect(skipClause('quality-fit-fail: busywork for the role')).toBe(
      'judged not worth doing as it stands: busywork for the role',
    );
    expect(skipClause('claimed-by-colleague: Nell holds it (Kofi locked out)')).toBe(
      'Nell holds it (Kofi locked out)',
    );
    expect(skipClause('the manager set it aside')).toBe('the manager set it aside');
  });
});

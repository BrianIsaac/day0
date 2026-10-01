import { describe, expect, it } from 'vitest';
import {
  WHOLE_HISTORY,
  isWholeHistory,
  isWithinTenure,
  openTenureOf,
  tenureWindowsOf,
  type AcceptedHandover,
} from '../../../src/metrics/tenure';

/** A handover of the one employee these cases follow. */
function handover(fromOwnerKey: string, toOwnerKey: string, acceptedAt: number): AcceptedHandover {
  return { agentId: 'maya', fromOwnerKey, toOwnerKey, acceptedAt };
}

describe('tenureWindowsOf', (): void => {
  it('gives the owner of an employee never handed over its whole history', (): void => {
    expect(tenureWindowsOf('ana', 'ana', [])).toEqual([WHOLE_HISTORY]);
    expect(isWholeHistory(tenureWindowsOf('ana', 'ana', []))).toBe(true);
  });

  it('gives nobody else any of it', (): void => {
    expect(tenureWindowsOf('ben', 'ana', [])).toEqual([]);
  });

  it('splits a handed-over employee at the acceptance: the old owner before, the new one from it', (): void => {
    const handovers = [handover('ana', 'ben', 500)];
    expect(tenureWindowsOf('ana', 'ben', handovers)).toEqual([{ from: null, until: 500 }]);
    expect(tenureWindowsOf('ben', 'ben', handovers)).toEqual([{ from: 500, until: null }]);
    expect(tenureWindowsOf('cat', 'ben', handovers)).toEqual([]);
  });

  it('gives an owner who took the employee back both of their spans and not the one between', (): void => {
    const handovers = [handover('ben', 'ana', 900), handover('ana', 'ben', 500)];
    expect(tenureWindowsOf('ana', 'ana', handovers)).toEqual([
      { from: null, until: 500 },
      { from: 900, until: null },
    ]);
    expect(tenureWindowsOf('ben', 'ana', handovers)).toEqual([{ from: 500, until: 900 }]);
  });

  it('follows the chain through three owners in acceptance order, however the rows are listed', (): void => {
    const handovers = [handover('ben', 'cat', 900), handover('ana', 'ben', 500)];
    expect(tenureWindowsOf('ana', 'cat', handovers)).toEqual([{ from: null, until: 500 }]);
    expect(tenureWindowsOf('ben', 'cat', handovers)).toEqual([{ from: 500, until: 900 }]);
    expect(tenureWindowsOf('cat', 'cat', handovers)).toEqual([{ from: 900, until: null }]);
  });

  it('reads only the handovers of the employee the first one names', (): void => {
    expect(() =>
      tenureWindowsOf('ana', 'ben', [
        handover('ana', 'ben', 500),
        { ...handover('ana', 'ben', 700), agentId: 'tomas' },
      ]),
    ).toThrow('one employee');
  });
});

describe('isWithinTenure', (): void => {
  it('counts the acceptance itself to the new owner, and nothing at or after it to the old', (): void => {
    const old = [{ from: null, until: 500 }];
    const current = [{ from: 500, until: null }];
    expect([499, 500].map((at) => isWithinTenure(at, old))).toEqual([true, false]);
    expect([499, 500].map((at) => isWithinTenure(at, current))).toEqual([false, true]);
  });

  it('counts nothing for an owner with no span', (): void => {
    expect(isWithinTenure(1, [])).toBe(false);
  });
});

describe('openTenureOf', (): void => {
  it('is the span that runs to now, held only by the current owner', (): void => {
    expect(openTenureOf([{ from: null, until: 500 }])).toBeUndefined();
    expect(
      openTenureOf([
        { from: null, until: 500 },
        { from: 900, until: null },
      ]),
    ).toEqual({ from: 900, until: null });
  });
});

import { describe, expect, it } from 'vitest';
import {
  APPLY_PROGRESS_KEY,
  applyProgressOf,
  reportedRow,
  reportedRows,
  withoutApplyProgress,
  withReportedOutcome,
} from '../../../src/work/apply-progress';
import type { AppliedAction } from '../../../src/surfaces/types';

const landed: AppliedAction = {
  tool: 'mcp.call',
  ok: true,
  effect: 'comment on REVOPS-1',
  providerId: 'comment-1',
  landedAt: 1_000,
  authority: 'manager',
  idempotencyKey: 'wi:run:0',
  elements: [{ ref: 'e1', name: 'Save', role: 'button' }],
  sessionRestore: { steps: [] },
};

describe('the apply persisted per action', (): void => {
  // Re-pinned in the second pass: the elements a browser action pressed and a repair are kept.
  it('keeps what the recovery needs of a row, the elements and a repair, and leaves out the session replay', (): void => {
    expect(reportedRow(landed)).toEqual({
      elements: [{ ref: 'e1', name: 'Save', role: 'button' }],
      tool: 'mcp.call',
      ok: true,
      effect: 'comment on REVOPS-1',
      providerId: 'comment-1',
      landedAt: 1_000,
      authority: 'manager',
      idempotencyKey: 'wi:run:0',
    });
  });

  it('replaces an earlier report of the same index and keeps the others', (): void => {
    const first = withReportedOutcome({ draft: 'd' }, 'attempt-1', {
      index: 0,
      ...reportedRow({ ...landed, ok: false, reason: 'refused' }),
    });
    const second = withReportedOutcome(first, 'attempt-1', { index: 1, ...reportedRow(landed) });
    const third = withReportedOutcome(second, 'attempt-1', { index: 0, ...reportedRow(landed) });
    expect(third.draft).toBe('d');
    expect([...reportedRows(third, 'attempt-1').entries()].map(([i, row]) => [i, row.ok])).toEqual([
      [1, true],
      [0, true],
    ]);
  });

  it('reads no row of another apply attempt, and starts afresh for a new one', (): void => {
    const kept = withReportedOutcome({}, 'attempt-1', { index: 0, ...reportedRow(landed) });
    expect(reportedRows(kept, 'attempt-2').size).toBe(0);
    expect(applyProgressOf(kept, 'attempt-2')).toBeUndefined();
    const next = withReportedOutcome(kept, 'attempt-2', { index: 1, ...reportedRow(landed) });
    expect([...reportedRows(next, 'attempt-2').keys()]).toEqual([1]);
  });

  it('reads nothing from an output without progress or with a malformed one', (): void => {
    expect(reportedRows(undefined, 'attempt-1').size).toBe(0);
    expect(reportedRows({ [APPLY_PROGRESS_KEY]: 'nonsense' }, 'attempt-1').size).toBe(0);
    expect(
      reportedRows({ [APPLY_PROGRESS_KEY]: { attemptId: 'attempt-1' } }, 'attempt-1').size,
    ).toBe(0);
  });

  it('drops the progress once the ledger is written in full', (): void => {
    const kept = withReportedOutcome({ draft: 'd' }, 'attempt-1', {
      index: 0,
      ...reportedRow(landed),
    });
    expect(withoutApplyProgress(kept)).toEqual({ draft: 'd' });
  });
});

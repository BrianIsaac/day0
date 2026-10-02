import { describe, expect, it } from 'vitest';
import { landedRowCount } from '../../../src/work/reconciliation';

describe('landedRowCount', (): void => {
  it('counts every row that reached the work environment, in both phases, reads and writes alike', (): void => {
    expect(
      landedRowCount({
        initial: {
          actions: [{ tool: 'linear.get_issue', args: {} }],
          applied: [{ tool: 'linear.get_issue', ok: true }],
        },
        actions: [
          { tool: 'linear.save_comment', args: {} },
          { tool: 'linear.save_issue', args: {} },
        ],
        applied: [
          { tool: 'linear.save_comment', ok: true },
          { tool: 'linear.save_issue', ok: false },
        ],
      }),
    ).toBe(2);
  });

  it('counts no held, refused or missing row', (): void => {
    expect(landedRowCount({ applied: [{ ok: true, held: true }, { ok: false }] })).toBe(0);
    expect(landedRowCount(undefined)).toBe(0);
    expect(landedRowCount({})).toBe(0);
  });
});

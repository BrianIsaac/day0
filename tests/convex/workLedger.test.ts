import { describe, expect, it } from 'vitest';
import {
  actionsOf,
  indexesWith,
  ledgerOf,
  refusedReasonEntries,
  verdictList,
} from '../../convex/workLedger';
import { HELD_WRITE } from '../../src/surfaces/policy';

/**
 * A run's ledger as a work item stores it (`convex/workLedger.ts`, moved out of `convex/work.ts`
 * by the wave 15 helpers split): the verdicts read one per action, whatever shape they were
 * persisted in, and the actions and applied rows read off a run's output.
 */

describe('verdictList', (): void => {
  it('reads one verdict per action, a missing one as held for the manager', (): void => {
    expect(verdictList([{ disposition: 'auto' }], 3)).toEqual([
      { disposition: 'auto' },
      { disposition: 'held', reason: HELD_WRITE },
      { disposition: 'held', reason: HELD_WRITE },
    ]);
  });

  it('reads a verdict persisted before dispositions by its held flag', (): void => {
    expect(verdictList([{ held: true }, { held: false }], 2)).toEqual([
      { disposition: 'refused', reason: 'refused' },
      { disposition: 'held', reason: HELD_WRITE },
    ]);
  });

  it('reads no verdicts as every action held', (): void => {
    expect(verdictList(undefined, 1)).toEqual([{ disposition: 'held', reason: HELD_WRITE }]);
  });
});

describe('indexesWith', (): void => {
  it('lists the indexes whose verdict has the disposition, in order', (): void => {
    const verdicts = verdictList(
      [{ disposition: 'auto' }, { disposition: 'held', reason: 'r' }, { disposition: 'auto' }],
      3,
    );

    expect(indexesWith(verdicts, 'auto')).toEqual([0, 2]);
    expect(indexesWith(verdicts, 'refused')).toEqual([]);
  });
});

describe('refusedReasonEntries', (): void => {
  it('pairs each refused row with its hold-time reason and skips the rest', (): void => {
    expect(
      refusedReasonEntries(
        [
          { disposition: 'auto' },
          { disposition: 'refused', reason: 'not on the charter' },
          { held: true },
        ],
        3,
      ),
    ).toEqual([
      [1, 'not on the charter'],
      [2, 'refused'],
    ]);
  });
});

describe('actionsOf', (): void => {
  it("reads the output's actions, and none from an output without a list", (): void => {
    expect(actionsOf({ actions: [{ tool: 'linear.comment' }] })).toEqual([
      { tool: 'linear.comment' },
    ]);
    expect(actionsOf({ summary: 'no actions' })).toEqual([]);
    expect(actionsOf(undefined)).toEqual([]);
  });
});

describe('ledgerOf', (): void => {
  it("reads the output's applied rows, keeping the gaps, and none without a ledger", (): void => {
    const applied = [{ tool: 'linear.comment', ok: true }, undefined];

    expect(ledgerOf({ applied })).toEqual(applied);
    expect(ledgerOf(null)).toEqual([]);
  });
});

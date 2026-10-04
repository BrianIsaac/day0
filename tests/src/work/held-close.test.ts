import { describe, expect, it } from 'vitest';
import {
  awaitingIndexes,
  isCloseHeldAgainstWords,
  leftForCardOf,
  wholeSetApproval,
  withoutLeftForCard,
} from '../../../src/work/held-close';
import {
  type ActionVerdict,
  AWAITING_APPROVAL,
  HELD_CLOSE_AGAINST_WORDS,
  HELD_MUTATION,
} from '../../../src/surfaces/policy';
import type { AppliedAction } from '../../../src/surfaces/types';

const comment: ActionVerdict = { disposition: 'held', reason: HELD_MUTATION };
const close: ActionVerdict = { disposition: 'held', reason: HELD_CLOSE_AGAINST_WORDS };
const auto: ActionVerdict = { disposition: 'auto' };
const refused: ActionVerdict = { disposition: 'refused', reason: 'no grant' };

const landed: AppliedAction = { tool: 'mcp.call', ok: true, idempotencyKey: 'k0' };
const parked: AppliedAction = {
  tool: 'mcp.call',
  ok: true,
  held: true,
  awaitingApproval: true,
  reason: AWAITING_APPROVAL,
  idempotencyKey: 'k1',
};

describe('held-close', (): void => {
  it('reads a close as held against the run’s words only by its own reason', (): void => {
    expect(isCloseHeldAgainstWords(close)).toBe(true);
    expect(isCloseHeldAgainstWords(comment)).toBe(false);
    expect(isCloseHeldAgainstWords(auto)).toBe(false);
    expect(isCloseHeldAgainstWords(undefined)).toBe(false);
  });

  it('counts a held row as waiting until an apply settles it, and a parked placeholder as waiting still', (): void => {
    const verdicts = [comment, close, auto, comment, refused];
    expect(awaitingIndexes(verdicts, [])).toEqual([0, 1, 3]);
    expect(awaitingIndexes(verdicts, [landed, parked, landed, parked])).toEqual([1, 3]);
  });

  it('approves every waiting write of a whole set but a tripped close, which is left for its card', (): void => {
    expect(wholeSetApproval([comment, close, auto, comment], [])).toEqual({
      approve: [0, 3],
      leftForCard: [1],
    });
    // Once the rest landed, a whole-set approval has only the close to leave.
    expect(
      wholeSetApproval([comment, close, auto, comment], [landed, parked, landed, landed]),
    ).toEqual({ approve: [], leftForCard: [1] });
    expect(wholeSetApproval([comment, comment], [])).toEqual({ approve: [0, 1], leftForCard: [] });
  });

  it('reads the closes left for their card off an output, and drops them once claimed', (): void => {
    expect(leftForCardOf({ actions: [], leftForCard: [1, 3] })).toEqual([1, 3]);
    expect(leftForCardOf({ leftForCard: [1, -1, 1.5, 'x'] })).toEqual([1]);
    expect(leftForCardOf({ leftForCard: 'all' })).toEqual([]);
    expect(leftForCardOf(undefined)).toEqual([]);
    expect(withoutLeftForCard({ draft: 'd', leftForCard: [1] })).toEqual({ draft: 'd' });
  });
});

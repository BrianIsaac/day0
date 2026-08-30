import { describe, expect, it } from 'vitest';
import { EVALUATION_TERMINAL_STATES, isTerminalWorkState } from '../../../src/evaluation/states';

describe('evaluation terminal states', (): void => {
  it('treats every settled outcome, and nothing in flight, as final', (): void => {
    for (const state of ['completed', 'cancelled', 'failed', 'skipped', 'deferred']) {
      expect(isTerminalWorkState(state)).toBe(true);
    }
    for (const state of ['discovered', 'claimed', 'plan-pending', 'executing', 'actions-pending']) {
      expect(isTerminalWorkState(state)).toBe(false);
    }
    expect(EVALUATION_TERMINAL_STATES.size).toBe(5);
  });
});

import { describe, expect, it } from 'vitest';
import {
  cronsPausedStepReason,
  EMPLOYEE_PAUSED_REASON,
  isPaused,
  isPauseReasonWithinBound,
  PAUSE_REASON_MAX_CHARS,
  pauseReasonOf,
  stepHoldReason,
} from '../../../src/work/pause';

describe('the pause’s reason', (): void => {
  it('stores the manager’s words trimmed, and nothing for blank ones', (): void => {
    expect(pauseReasonOf('  Quarter close.  ')).toBe('Quarter close.');
    expect(pauseReasonOf('   ')).toBeUndefined();
    expect(pauseReasonOf(undefined)).toBeUndefined();
  });

  it('counts the bound as the reader sees the characters', (): void => {
    expect(isPauseReasonWithinBound('x'.repeat(PAUSE_REASON_MAX_CHARS))).toBe(true);
    expect(isPauseReasonWithinBound('x'.repeat(PAUSE_REASON_MAX_CHARS + 1))).toBe(false);
    // A character outside the basic plane is two UTF-16 units and still one character.
    expect(isPauseReasonWithinBound(`${'x'.repeat(PAUSE_REASON_MAX_CHARS - 1)}\u{1D4CD}`)).toBe(
      true,
    );
  });
});

describe('isPaused', (): void => {
  it('reads an absent stamp as running', (): void => {
    expect(isPaused({})).toBe(false);
    expect(isPaused({ pausedAt: 5 })).toBe(true);
  });
});

describe('stepHoldReason', (): void => {
  it('holds a step of a paused employee, then of a paused deployment, and lets every other run', (): void => {
    expect(stepHoldReason({ pausedAt: 5 }, 'upgrade')).toBe(EMPLOYEE_PAUSED_REASON);
    expect(stepHoldReason({}, 'upgrade')).toBe(cronsPausedStepReason('upgrade'));
    expect(stepHoldReason(null, 'upgrade')).toBe(cronsPausedStepReason('upgrade'));
    expect(stepHoldReason({}, undefined)).toBeUndefined();
    expect(stepHoldReason(null, undefined)).toBeUndefined();
  });

  it("says the deployment's own reason", (): void => {
    expect(cronsPausedStepReason('upgrade to 0.16.0')).toBe(
      "the deployment's scheduled work is paused (upgrade to 0.16.0), so no new step starts",
    );
  });
});

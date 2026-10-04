import { describe, expect, it } from 'vitest';
import {
  isPaused,
  isPauseReasonWithinBound,
  PAUSE_REASON_MAX_CHARS,
  pauseReasonOf,
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

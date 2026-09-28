import { describe, expect, it } from 'vitest';
import {
  FINISHING_CURSOR,
  finishWalks,
  finishingCursor,
  finishingStep,
} from '../../../src/docs/finishing';

describe('the point a finishing sync has reached (adversarial pass, step 49)', (): void => {
  it('reads the start of the finish as its first phase from the top', (): void => {
    expect(finishingStep(FINISHING_CURSOR)).toEqual({ phase: 'pages', cursor: null });
  });

  it('round-trips each phase with a walk cursor that has colons of its own', (): void => {
    for (const step of [
      { phase: 'pages', cursor: '[1,"a:b"]' },
      { phase: 'credentials', cursor: '[2]' },
      { phase: 'mirrors', cursor: null },
      { phase: 'scopes', cursor: null },
    ] as const) {
      expect(finishingStep(finishingCursor(step))).toEqual(step);
    }
  });

  it('walks the phase a finish stands at and every later one, never an earlier one', (): void => {
    expect(finishWalks('pages', 'credentials')).toBe(true);
    expect(finishWalks('credentials', 'credentials')).toBe(true);
    expect(finishWalks('credentials', 'mirrors')).toBe(true);
    expect(finishWalks('mirrors', 'credentials')).toBe(false);
    expect(finishWalks('scopes', 'pages')).toBe(false);
  });

  it('reads a reading cursor as no point in the finish', (): void => {
    expect(finishingStep(undefined)).toBeUndefined();
    expect(finishingStep('300@abcdefg')).toBeUndefined();
    expect(finishingStep('\u0000finishing:other:')).toBeUndefined();
  });
});

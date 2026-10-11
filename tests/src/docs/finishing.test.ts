import { describe, expect, it } from 'vitest';
import {
  FINISHING_CURSOR,
  FINISHING_PHASES,
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
      { phase: 'status', cursor: '[3,"runbooks/a:b.md"]' },
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

  it('walks the status phase after the mirrors and before the scopes (15-A; A-2)', (): void => {
    expect(FINISHING_PHASES).toEqual(['pages', 'credentials', 'mirrors', 'status', 'scopes']);
    expect(finishWalks('mirrors', 'status')).toBe(true);
    expect(finishWalks('status', 'status')).toBe(true);
    expect(finishWalks('status', 'scopes')).toBe(true);
    expect(finishWalks('scopes', 'status')).toBe(false);
    expect(finishWalks('status', 'mirrors')).toBe(false);
  });

  it('reads a reading cursor as no point in the finish', (): void => {
    expect(finishingStep(undefined)).toBeUndefined();
    expect(finishingStep('300@abcdefg')).toBeUndefined();
    expect(finishingStep('\u0000finishing:other:')).toBeUndefined();
  });
});

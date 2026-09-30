import { describe, expect, it } from 'vitest';
import { SURFACE_ACCESS_DEFAULT_DAYS, SURFACE_ACCESS_MAX_DAYS } from '../../../src/surfaces/access';

describe('the surface access lengths (Q5)', (): void => {
  it('gives 90 days at approval and lets the manager set at most a year', (): void => {
    expect({ SURFACE_ACCESS_DEFAULT_DAYS, SURFACE_ACCESS_MAX_DAYS }).toEqual({
      SURFACE_ACCESS_DEFAULT_DAYS: 90,
      SURFACE_ACCESS_MAX_DAYS: 365,
    });
  });
});

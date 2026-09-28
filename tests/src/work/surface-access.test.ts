import { describe, expect, it } from 'vitest';
import { accessEnded, accessEndedReason } from '../../../src/work/surface-access';

describe('surface access end date (Q5, wave 2 review D4)', (): void => {
  const ends = Date.UTC(2026, 9, 11);

  it('is ended from the end date on, and never for a surface with no end date', (): void => {
    expect(accessEnded({ expiresAt: ends }, ends - 1)).toBe(false);
    expect(accessEnded({ expiresAt: ends }, ends)).toBe(true);
    expect(accessEnded({ expiresAt: ends }, ends + 1)).toBe(true);
    expect(accessEnded({}, ends)).toBe(false);
  });

  it('names the end date in the agent’s zone', (): void => {
    expect(accessEndedReason(ends - 1, 'UTC')).toBe(
      'access ended on 2026-10-10; the manager renews it on the card',
    );
    expect(accessEndedReason(ends - 1, 'Asia/Singapore')).toBe(
      'access ended on 2026-10-11; the manager renews it on the card',
    );
  });
});

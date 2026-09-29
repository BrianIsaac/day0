import { describe, expect, it } from 'vitest';
import { CRONS_PAUSED_FLAG, cronsPauseReason } from '../../../src/lib/crons-pause';

describe('the crons pause flag', (): void => {
  it('is the deployment env value the setup sets and the crons read', (): void => {
    expect(CRONS_PAUSED_FLAG).toBe('DAY0_CRONS_PAUSED');
  });

  it('reads a set value as the reason the jobs are paused', (): void => {
    expect(cronsPauseReason({ DAY0_CRONS_PAUSED: ' upgrade to 0.9.0 ' })).toBe('upgrade to 0.9.0');
  });

  it('reads an absent or blank value as running', (): void => {
    expect(cronsPauseReason({})).toBeUndefined();
    expect(cronsPauseReason({ DAY0_CRONS_PAUSED: '  ' })).toBeUndefined();
  });
});

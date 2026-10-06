import { describe, expect, it } from 'vitest';
import {
  CHARTER_SEEDING_CHECK_MS,
  nothingToFindAgain,
  SEEDING_DID_NOT_FINISH,
  seedingLine,
  seedingStanding,
  stillFindingWork,
  type SeedingEvent,
} from '../../../src/agent/charter-seeding';

const failed = (
  charterId: string,
  retrying: boolean,
  reason = SEEDING_DID_NOT_FINISH,
): SeedingEvent => ({
  type: 'charter.seeding-failed',
  charterId,
  reason,
  retrying,
});

describe('how the seeding of an approved charter stands (12-J item 6)', (): void => {
  it('checks an attempt only after the ten minutes the platform gives an action', (): void => {
    expect(CHARTER_SEEDING_CHECK_MS).toBeGreaterThan(600_000);
  });

  it('reads the newest event about the charter, newest first', (): void => {
    expect(seedingStanding([], 'c1')).toBeUndefined();
    expect(seedingStanding([failed('c1', true)], 'c1')).toEqual({
      state: 'retrying',
      reason: SEEDING_DID_NOT_FINISH,
    });
    expect(seedingStanding([failed('c1', false), failed('c1', true)], 'c1')).toEqual({
      state: 'stopped',
      reason: SEEDING_DID_NOT_FINISH,
    });
    expect(
      seedingStanding(
        [{ type: 'charter.seeding-requested', charterId: 'c1' }, failed('c1', false)],
        'c1',
      ),
    ).toEqual({ state: 'finding' });
  });

  it('clears once a seeding finished after the failure, and ignores an older charter’s failures', (): void => {
    expect(
      seedingStanding([{ type: 'work.charter-derived' }, failed('c1', false)], 'c1'),
    ).toBeUndefined();
    expect(seedingStanding([failed('c0', false)], 'c1')).toBeUndefined();
  });

  it('words each standing for the empty Work tab, and the two refusals', (): void => {
    expect(seedingLine({ state: 'finding' }, 'Nola')).toBe(
      'Day0 is finding work for Nola again. It appears here as it is found.',
    );
    expect(seedingLine({ state: 'retrying', reason: 'the model was slow' }, 'Nola')).toBe(
      'Finding work for Nola did not finish: the model was slow. Day0 tries again shortly.',
    );
    expect(seedingLine({ state: 'stopped', reason: 'the model was slow' }, 'Nola')).toBe(
      'Day0 could not find work for Nola: the model was slow.',
    );
    expect(stillFindingWork('Nola')).toBe('Day0 is still finding work for Nola.');
    expect(nothingToFindAgain('Nola')).toBe(
      'Finding work for Nola did not fail: there is nothing to try again.',
    );
  });

  it('says a model call that ran out of time in the manager’s words, never the error’s (the bed)', (): void => {
    expect(
      seedingLine(
        {
          state: 'retrying',
          reason: 'agentJson(day0-work-generator): the model call reached its 300000ms budget',
        },
        'Dee',
      ),
    ).toBe(
      'Finding work for Dee did not finish: the model did not answer within 5 minutes. Day0 tries again shortly.',
    );
    expect(
      seedingLine(
        { state: 'stopped', reason: 'agentJson(day0-work-generator): provider returned 503' },
        'Dee',
      ),
    ).toBe('Day0 could not find work for Dee: provider returned 503.');
  });
});

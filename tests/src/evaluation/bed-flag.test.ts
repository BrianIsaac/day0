import { describe, expect, it } from 'vitest';
import {
  EVALUATION_BED_FLAG,
  evaluationBedName,
  evaluationBedRefusal,
} from '../../../src/evaluation/bed-flag';

describe('evaluationBedName', () => {
  it('names no bed when the flag is unset or blank', () => {
    expect(evaluationBedName({})).toBeUndefined();
    expect(evaluationBedName({ [EVALUATION_BED_FLAG]: '' })).toBeUndefined();
    expect(evaluationBedName({ [EVALUATION_BED_FLAG]: '   ' })).toBeUndefined();
  });

  it('names the bed the flag carries', () => {
    expect(evaluationBedName({ [EVALUATION_BED_FLAG]: ' comparison-bed ' })).toBe('comparison-bed');
  });
});

describe('evaluationBedRefusal', () => {
  it('says which flag is missing and the command that sets it', () => {
    expect(evaluationBedRefusal('evaluation.seedTasks')).toBe(
      'evaluation.seedTasks runs only on an evaluation bed: this deployment does not set ' +
        'DAY0_EVALUATION_BED. On a bed, run `npx convex env set DAY0_EVALUATION_BED <bed name>` first.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  EVALUATION_BED_FLAG,
  evaluationBedName,
  evaluationBedRefusal,
  refuseUnlessBed,
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
  it('says which flag is missing and where a bed sets it, so the next sync keeps it', () => {
    expect(evaluationBedRefusal('evaluation.seedTasks')).toBe(
      'evaluation.seedTasks runs only on an evaluation bed: this deployment does not set ' +
        'DAY0_EVALUATION_BED. On a bed, set DAY0_EVALUATION_BED=<bed name> in .env.local and run `pnpm sync:env` first.',
    );
  });
});

describe('refuseUnlessBed', () => {
  it('lets a harness go on against a deployment that names a bed', () => {
    expect(() => refuseUnlessBed('comparison', 'pnpm eval:comparison')).not.toThrow();
  });

  it('stops a harness before its first call against a deployment that names none', () => {
    expect(() => refuseUnlessBed(null, 'pnpm eval:comparison')).toThrow(
      'pnpm eval:comparison runs only on an evaluation bed',
    );
  });
});

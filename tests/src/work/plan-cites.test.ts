import { describe, expect, it } from 'vitest';
import { goneCitesReason, resolvedPlanCites } from '../../../src/work/plan-cites';

const documentation = {
  citations: [
    { label: 'Handbook/runbooks/refresh-tile.md#Refresh', blockIds: ['b1', 'b2'] },
    { label: 'Handbook/team/holidays.md#Office holidays', blockIds: ['b3'] },
  ],
};

describe('resolvedPlanCites', (): void => {
  it('keeps each step’s cites the selection printed, with the blocks under them', (): void => {
    expect(
      resolvedPlanCites(
        [
          ['Handbook/runbooks/refresh-tile.md#Refresh'],
          [],
          ['[cite: Handbook/team/holidays.md#Office holidays]'],
        ],
        3,
        documentation,
      ),
    ).toEqual([
      { step: 1, label: 'Handbook/runbooks/refresh-tile.md#Refresh', blockIds: ['b1', 'b2'] },
      { step: 3, label: 'Handbook/team/holidays.md#Office holidays', blockIds: ['b3'] },
    ]);
  });

  it('drops a cite the selection never printed and a row past the last step', (): void => {
    expect(
      resolvedPlanCites(
        [['Handbook/invented.md#Steps'], ['Handbook/runbooks/refresh-tile.md#Refresh']],
        1,
        documentation,
      ),
    ).toEqual([]);
  });

  it('cites nothing without a selection or without the planner’s rows', (): void => {
    expect(resolvedPlanCites(null, 2, documentation)).toEqual([]);
    expect(
      resolvedPlanCites([['Handbook/runbooks/refresh-tile.md#Refresh']], 1, undefined),
    ).toEqual([]);
  });
});

describe('goneCitesReason', (): void => {
  it('names each cite whose documentation is gone and says the item needs a new plan', (): void => {
    expect(goneCitesReason(['Handbook/runbooks/refresh-tile.md#Refresh'])).toBe(
      'The plan cited documentation that is no longer there ("Handbook/runbooks/refresh-tile.md#Refresh"): the page changed after the plan was approved, so the closing phase did not run on steps drawn from it. The item needs a plan drawn from the documentation as it is now.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { goneCitesReason, resolvedPlanCites } from '../../../src/work/plan-cites';

const documentation = {
  citations: [
    {
      label: 'Handbook/runbooks/refresh-tile.md#Refresh',
      blocks: [
        { id: 'b1', hash: 'h1' },
        { id: 'b2', hash: 'h2' },
      ],
    },
    { label: 'Handbook/team/holidays.md#Office holidays', blocks: [{ id: 'b3', hash: 'h3' }] },
    // The same heading printed again further down the page.
    { label: 'Handbook/team/holidays.md#Office holidays', blocks: [{ id: 'b4', hash: 'h4' }] },
  ],
};

describe('resolvedPlanCites', (): void => {
  it('keeps each step’s cites the selection printed, with every block under them', (): void => {
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
      {
        step: 1,
        label: 'Handbook/runbooks/refresh-tile.md#Refresh',
        blocks: [
          { id: 'b1', hash: 'h1' },
          { id: 'b2', hash: 'h2' },
        ],
      },
      {
        step: 3,
        label: 'Handbook/team/holidays.md#Office holidays',
        blocks: [
          { id: 'b3', hash: 'h3' },
          { id: 'b4', hash: 'h4' },
        ],
      },
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
  it('names the first cite whose documentation is gone or changed and counts the rest', (): void => {
    expect(goneCitesReason(['Handbook/runbooks/refresh-tile.md#Refresh'])).toBe(
      'Documentation the plan followed has since been changed or removed ("Handbook/runbooks/refresh-tile.md#Refresh"), so Day0 did not run the plan on instructions that may be out of date. The item needs a new plan.',
    );
    expect(goneCitesReason(['Handbook/a.md#A', 'Handbook/b.md#B', 'Handbook/c.md#C'])).toContain(
      '("Handbook/a.md#A" and 2 more)',
    );
  });

  it('stays under the failure line’s 300 characters, however long the cite', (): void => {
    const reason = goneCitesReason([
      `Handbook/${'deep/'.repeat(40)}page.md#Heading`,
      'Handbook/b.md#B',
    ]);
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).toContain('..." and 1 more)');
  });
});

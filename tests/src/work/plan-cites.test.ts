import { describe, expect, it } from 'vitest';
import {
  goneCitesReason,
  isGoneCitesReason,
  resolvedPlanCites,
} from '../../../src/work/plan-cites';

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

describe('goneCitesReason and a page that is no longer current (15-A)', (): void => {
  it('says a superseded page’s cite was superseded, by what, in the card’s words', (): void => {
    expect(
      goneCitesReason([
        {
          label: 'Handbook/runbooks/pipeline-runbook.md#Refresh',
          status: 'superseded',
          supersededBy: 'Pipeline runbook, version 2',
        },
      ]),
    ).toBe(
      'Documentation the plan followed has since been superseded ("Handbook/runbooks/pipeline-runbook.md#Refresh" by "Pipeline runbook, version 2"), so Day0 did not run the plan on it. The item needs a new plan.',
    );
  });

  it('says archived and marked a draft as plainly, and counts the other cites', (): void => {
    expect(
      goneCitesReason([{ label: 'Handbook/a.md#A', status: 'archived' }, 'Handbook/b.md#B']),
    ).toBe(
      'Documentation the plan followed has since been archived ("Handbook/a.md#A" and 1 more), so Day0 did not run the plan on it. The item needs a new plan.',
    );
    expect(goneCitesReason([{ label: 'Handbook/a.md#A', status: 'draft' }])).toContain(
      'has since been marked a draft ("Handbook/a.md#A")',
    );
    // A superseded page that names no successor says only that.
    expect(goneCitesReason([{ label: 'Handbook/a.md#A', status: 'superseded' }])).toContain(
      'has since been superseded ("Handbook/a.md#A")',
    );
  });

  it('stays under 300 characters, and is a gone cite’s failure to a Retry', (): void => {
    const reason = goneCitesReason([
      {
        label: `Handbook/${'deep/'.repeat(40)}page.md#Heading`,
        status: 'superseded',
        supersededBy: 'A very long title of the page that took its place '.repeat(6),
      },
    ]);
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(isGoneCitesReason(reason)).toBe(true);
    expect(
      isGoneCitesReason(goneCitesReason([{ label: 'Handbook/a.md#A', status: 'draft' }])),
    ).toBe(true);
  });
});

describe('resolvedPlanCites and the source of a cite (W14-R27)', (): void => {
  it('carries the source and the page a cite is of onto the plan', (): void => {
    expect(
      resolvedPlanCites([['Handbook/runbooks/refresh-tile.md#Refresh']], 1, {
        citations: [
          {
            label: 'Handbook/runbooks/refresh-tile.md#Refresh',
            sourceId: 'source-1',
            pageRef: 'runbooks/refresh-tile.md',
            blocks: [{ id: 'b1', hash: 'h1' }],
          },
        ],
      }),
    ).toEqual([
      {
        step: 1,
        label: 'Handbook/runbooks/refresh-tile.md#Refresh',
        sourceId: 'source-1',
        pageRef: 'runbooks/refresh-tile.md',
        blocks: [{ id: 'b1', hash: 'h1' }],
      },
    ]);
  });
});

describe('resolvedPlanCites and a cite two pages disagree on (15-A)', (): void => {
  const conflict = {
    relationId: 'relation-1',
    heading: 'Thresholds',
    pages: [
      { title: 'Finance escalation', source: 'Finance wiki' },
      { title: 'Pipeline runbook', source: 'Handbook' },
    ],
  } as const;
  const selection = {
    citations: [
      {
        label: 'Handbook/runbooks/pipeline-runbook.md#Thresholds',
        blocks: [{ id: 'b1', hash: 'h1' }],
        conflict,
      },
    ],
  };

  it('reads a cite the planner copied with its [conflict] tag as the cite it is, and keeps what it disputes', (): void => {
    for (const written of [
      '[cite: Handbook/runbooks/pipeline-runbook.md#Thresholds] [conflict]',
      'Handbook/runbooks/pipeline-runbook.md#Thresholds [conflict]',
      'cite: Handbook/runbooks/pipeline-runbook.md#Thresholds',
    ]) {
      expect(resolvedPlanCites([[written]], 1, selection)).toEqual([
        {
          step: 1,
          label: 'Handbook/runbooks/pipeline-runbook.md#Thresholds',
          blocks: [{ id: 'b1', hash: 'h1' }],
          conflict,
        },
      ]);
    }
  });
});

describe('isGoneCitesReason', (): void => {
  it('tells a gone cite’s failure from any other, so a Retry drafts a new plan only for it', (): void => {
    expect(isGoneCitesReason(goneCitesReason(['Handbook/a.md#A']))).toBe(true);
    expect(isGoneCitesReason('the Linear MCP timed out')).toBe(false);
    expect(isGoneCitesReason(`stopped: ${goneCitesReason(['Handbook/a.md#A'])}`)).toBe(false);
  });
});

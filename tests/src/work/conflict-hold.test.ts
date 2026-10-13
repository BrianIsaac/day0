import { describe, expect, it } from 'vitest';
import {
  conflictHeldWrites,
  conflictSteps,
  heldWriteSurfaces,
  planLeansOn,
} from '../../../src/work/conflict-hold';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction } from '../../../src/work/types';

const surface = (slug: string, cls: string, dm?: string): SurfaceRecord => ({
  slug,
  displayName: slug,
  class: cls,
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: Date.now(),
  path: 'mcp',
  endpoint: `https://${slug}.example/mcp`,
  ...(dm
    ? { managerDmChannelId: dm, path: 'documented-api', endpoint: 'https://slack.com/api/' }
    : {}),
});

const SURFACES = [surface('linear', 'kanban'), surface('slack', 'chat', 'D0MANAGER')];

const comment: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({ issueId: 'FIN-1', body: 'Threshold passed.' }),
  },
};
const read: MockAction = {
  tool: 'mcp.call',
  args: { surface: 'linear', tool: 'get_issue', toolArgsJson: JSON.stringify({ id: 'FIN-1' }) },
};
const dm: MockAction = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    body: JSON.stringify({ channel: 'D0MANAGER', text: 'Which page is right?' }),
  },
};

const plan: Pick<ExecutionPlan, 'steps' | 'cites' | 'obligations'> = {
  steps: ['Read FIN-1', 'Comment the threshold on FIN-1'],
  cites: [
    {
      step: 2,
      label: 'Handbook/runbook.md#Thresholds',
      blocks: [{ id: 'b1', hash: 'h1' }],
      conflict: {
        relationId: 'relation-1',
        heading: 'Thresholds',
        pages: [
          { title: 'Finance escalation', source: 'Finance wiki' },
          { title: 'Pipeline runbook', source: 'Handbook' },
        ],
      },
    },
  ],
  obligations: {
    steps: [
      { kind: 'read', reads: ['linear'], writes: [] },
      { kind: 'write', reads: [], writes: ['linear'] },
    ],
    transition: 'none',
    transitionStep: null,
    basis: 'judgement',
  },
};

describe('conflictSteps: the plan steps a conflict’s question holds', (): void => {
  it('holds the steps whose cites carry the relation or one of its blocks', (): void => {
    expect(conflictSteps(plan, { relationId: 'relation-1', blocks: [] })).toEqual([2]);
    expect(
      conflictSteps(
        { ...plan, cites: [{ step: 1, label: 'x', blocks: [{ id: 'b9', hash: 'h9' }] }] },
        { relationId: 'relation-2', blocks: ['h9'] },
      ),
    ).toEqual([1, 2]);
    expect(conflictSteps(plan, { relationId: 'relation-3', blocks: ['h0'] })).toEqual([]);
  });

  it('holds every step from the first that cites the passage, since the steps after it rest on it (the pre-tag bed’s REVOPS-1)', (): void => {
    // On the hosted model the tagged cite sat on the step that drafts the comment, which writes
    // nothing, and the steps that post it and close the ticket cited the how-to: held by the
    // citing step alone, the hold withheld nothing while its question said it held.
    const drafted: Pick<ExecutionPlan, 'steps' | 'cites' | 'obligations'> = {
      steps: [
        'Read the ticket',
        'Draft the comment',
        'Post the comment',
        'Move the ticket to Done',
      ],
      cites: [
        { step: 1, label: 'how-to#Read', blocks: [{ id: 'b0', hash: 'h0' }] },
        { step: 2, label: 'limits#Comment length', blocks: [{ id: 'b1', hash: 'h1' }] },
        { step: 3, label: 'how-to#Action shape', blocks: [{ id: 'b2', hash: 'h2' }] },
      ],
      obligations: {
        steps: [
          { kind: 'read', reads: ['linear'], writes: [] },
          { kind: 'report', reads: [], writes: [] },
          { kind: 'write', reads: [], writes: ['linear'] },
          { kind: 'conditional-write', reads: [], writes: ['linear'] },
        ],
        transition: 'none',
        transitionStep: null,
        basis: 'judgement',
      },
    };
    const held = conflictSteps(drafted, { relationId: 'relation-9', blocks: ['h1'] });
    expect(held).toEqual([2, 3, 4]);
    expect(heldWriteSurfaces(drafted, held)).toEqual(['linear']);
  });

  it('holds every step of a plan that cites nothing, since nothing says which relies on the passage', (): void => {
    expect(conflictSteps({ ...plan, cites: [] }, { relationId: 'relation-1', blocks: [] })).toEqual(
      [1, 2],
    );
  });

  it('holds every step for a conflict the plan leans on in its own words and no cite carries (D-1 (c))', (): void => {
    const leaned = { relationId: 'relation-3', blocks: ['h0'], leaned: true };
    expect(conflictSteps(plan, leaned)).toEqual([1, 2]);
    // A cite that carries the relation still says which step relies on it.
    expect(conflictSteps(plan, { relationId: 'relation-1', blocks: [], leaned: true })).toEqual([
      2,
    ]);
  });
});

describe('planLeansOn: a plan whose own words rest on a conflict it did not cite (D-1 (c))', (): void => {
  const COMMENT_LENGTH = {
    heading: 'Comment length',
    titles: ['Close comment limits', 'Close comment limits'],
  };
  const words = (
    summary: string,
    steps: string[] = [],
    riskNotes = '',
  ): Pick<ExecutionPlan, 'summary' | 'steps' | 'riskNotes'> => ({ summary, steps, riskNotes });

  it('reads the heading named in the plan, as the pre-tag bed’s REVOPS-1 named it on the hosted model', (): void => {
    expect(
      planLeansOn(
        words(
          'Post the audit comment on REVOPS-1, then move the ticket to Done. The comment length is disputed between two trusted pages (120 words in the runbook, 60 words in the team docs), so the comment step is held until the manager says which limit applies.',
        ),
        COMMENT_LENGTH,
      ),
    ).toBe(true);
    // In a step or the risk notes as well as the summary.
    expect(
      planLeansOn(words('Post the comment.', ['Keep to the comment length']), COMMENT_LENGTH),
    ).toBe(true);
    expect(
      planLeansOn(words('Post the comment.', [], 'The length of a comment is disputed.'), {
        ...COMMENT_LENGTH,
        titles: [],
      }),
    ).toBe(true);
  });

  it('reads a page’s title named in the plan, as 16-J’s REVOPS-2 named it', (): void => {
    expect(
      planLeansOn(
        words('Post the audit comment, kept within the close comment limits.'),
        COMMENT_LENGTH,
      ),
    ).toBe(true);
  });

  it('reads nothing from one shared word, so a plan about another passage of the page is not asked', (): void => {
    expect(planLeansOn(words('Post the audit comment and close the ticket.'), COMMENT_LENGTH)).toBe(
      false,
    );
    expect(planLeansOn(words('Refresh the tile.', ['Press Refresh']), COMMENT_LENGTH)).toBe(false);
  });

  it('reads a one-word heading only beside a word of one of the pages’ titles', (): void => {
    const thresholds = {
      heading: 'Thresholds',
      titles: ['Finance escalation', 'Pipeline runbook'],
    };
    expect(planLeansOn(words('Escalate above the thresholds.'), thresholds)).toBe(false);
    expect(planLeansOn(words('Escalate above the finance thresholds.'), thresholds)).toBe(true);
    // A heading and titles with no content word of their own say nothing to lean on.
    expect(planLeansOn(words('Check the draft.'), { heading: 'Draft', titles: ['Check'] })).toBe(
      false,
    );
  });

  it('reads a plan stored without its words as leaning on nothing', (): void => {
    expect(planLeansOn({} as never, COMMENT_LENGTH)).toBe(false);
  });
});

describe('conflictHeldWrites: the writes of the held steps', (): void => {
  it('withholds the writes of a held step, never a read or the manager DM', (): void => {
    expect(
      conflictHeldWrites({ plan, actions: [read, comment, dm], surfaces: SURFACES, steps: [2] }),
    ).toEqual([{ index: 1, step: 2 }]);
  });

  it('withholds every write when the plan declares no obligations to map a write to its step', (): void => {
    expect(
      conflictHeldWrites({
        plan: { ...plan, obligations: undefined },
        actions: [read, comment, dm],
        surfaces: SURFACES,
        steps: [2],
      }),
    ).toEqual([{ index: 1, step: 2 }]);
    expect(
      conflictHeldWrites({ plan, actions: [read, comment], surfaces: SURFACES, steps: [] }),
    ).toEqual([]);
  });
});

describe('heldWriteSurfaces: what the question says it holds (W16-R10)', (): void => {
  it('names the surfaces the held steps write, each once in plan order, since every write to them waits', (): void => {
    expect(heldWriteSurfaces(plan, [2])).toEqual(['linear']);
    expect(heldWriteSurfaces(plan, [1])).toEqual([]);
    expect(heldWriteSurfaces(plan, [])).toEqual([]);
  });

  it('says every write when the plan declares no obligations to tell its writes apart', (): void => {
    expect(heldWriteSurfaces({ ...plan, obligations: undefined }, [2])).toBe('every');
  });
});

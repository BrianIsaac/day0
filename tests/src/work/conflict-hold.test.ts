import { describe, expect, it } from 'vitest';
import {
  conflictHeldWrites,
  conflictSteps,
  heldWriteSurfaces,
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
    ).toEqual([1]);
    expect(conflictSteps(plan, { relationId: 'relation-3', blocks: ['h0'] })).toEqual([]);
  });

  it('holds every step of a plan that cites nothing, since nothing says which relies on the passage', (): void => {
    expect(conflictSteps({ ...plan, cites: [] }, { relationId: 'relation-1', blocks: [] })).toEqual(
      [1, 2],
    );
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

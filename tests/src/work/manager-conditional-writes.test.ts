import { describe, expect, it } from 'vitest';
import { managerConditionalSteps, openManagerQuestion } from '../../../src/work/obligations';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanObligations } from '../../../src/work/types';
import {
  log1PhaseOne,
  log1Plan,
  log1SecondSittingPhaseOne,
  log1SecondSittingPlan,
  log3PhaseOne,
  log3Plan,
} from '../../fixtures/work/full-run-4-2026-09-19-log-1';

const slack = {
  slug: 'slack', displayName: 'Slack', class: 'chat', verdict: 'connected', credentialLanded: true,
  lastVerifiedAt: 1, path: 'documented-api', endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage'], managerDmChannelId: 'D0MANAGER',
} as unknown as SurfaceRecord;
const linear = {
  slug: 'linear', displayName: 'Linear', class: 'kanban', verdict: 'connected', credentialLanded: true,
  lastVerifiedAt: 1, path: 'mcp', endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['get_issue', 'save_comment', 'save_issue'],
} as unknown as SurfaceRecord;
const surfaces = [slack, linear];

const dm = (text: string, channel = 'D0MANAGER'): MockAction => ({
  tool: 'http.request',
  args: {
    surface: 'slack', method: 'POST', path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({ channel, text }),
  },
});
const [read, question, comment, done] = log1PhaseOne.actions;

const planWith = (
  steps: PlanObligations['steps'],
  transition: PlanObligations['transition'],
  transitionStep: number | null,
  plannerTransition?: PlanObligations['transition'],
): ExecutionPlan => ({
  ...log1Plan,
  steps: steps.map((_, index) => `step ${index + 1}`),
  obligations: { basis: 'judgement', reason: '', steps, transition, transitionStep, ...(plannerTransition ? { plannerTransition } : {}) },
} as ExecutionPlan);

describe('managerConditionalSteps', () => {
  it("reads LOG-1's comment and Done as left to the manager, in the second and the fourth sitting alike", (): void => {
    expect(managerConditionalSteps(log1Plan)).toEqual([2, 3]);
    expect(managerConditionalSteps(log1SecondSittingPlan)).toEqual([2, 3]);
  });

  it('reads nothing from a plan whose transition is not the manager\'s, whatever its steps condition on', (): void => {
    const evidence = planWith(
      [{ kind: 'read', reads: ['linear'], writes: [] }, { kind: 'conditional-write', reads: [], writes: ['linear'] }],
      'conditional-on-evidence', 2,
    );
    expect(managerConditionalSteps(evidence)).toEqual([]);
    expect(managerConditionalSteps({ ...log1Plan, obligations: undefined })).toEqual([]);
  });

  it('takes either reading when the planner and the judgement disagreed, as the hold does', (): void => {
    const disagreed = planWith(
      [{ kind: 'write', reads: [], writes: ['slack'] }, { kind: 'conditional-write', reads: [], writes: ['linear'] }],
      'conditional-on-evidence', 2, 'conditional-on-manager',
    );
    expect(managerConditionalSteps(disagreed)).toEqual([2]);
  });
});

describe('openManagerQuestion', () => {
  it("withholds the comment and Done the fourth sitting emitted beside LOG-1's question", (): void => {
    const open = openManagerQuestion({ plan: log1Plan, actions: log1PhaseOne.actions, surfaces, answered: false });
    expect(open?.withheld).toEqual([{ index: 2, step: 2 }, { index: 3, step: 3 }]);
    expect(open?.steps).toEqual([2, 3]);
    expect(open?.question).toContain('Which template should the notice use');
    expect(open?.question).toContain('what next-update time should it promise?');
    expect([read, question].map((action) => log1PhaseOne.actions.indexOf(action!))).toEqual([0, 1]);
  });

  it('withholds nothing once the ledger shows the manager answered', (): void => {
    expect(openManagerQuestion({ plan: log1Plan, actions: log1PhaseOne.actions, surfaces, answered: true })).toBeUndefined();
  });

  it("leaves the second sitting's phase one, the question alone, as it was", (): void => {
    expect(openManagerQuestion({ plan: log1SecondSittingPlan, actions: log1SecondSittingPhaseOne, surfaces, answered: false })).toBeUndefined();
  });

  it('reads a question this run already landed as the question beside a later set', (): void => {
    const open = openManagerQuestion({
      plan: log1Plan, actions: [comment!, done!], askedEarlier: [question!], surfaces, answered: false,
    });
    expect(open?.withheld.map((row) => row.index)).toEqual([0, 1]);
    expect(open?.question).toContain('Which template');
  });

  it("does not take SH-4480's draft for approval as a question", (): void => {
    expect(openManagerQuestion({ plan: log3Plan, actions: log3PhaseOne.actions, surfaces, answered: false })).toBeUndefined();
  });

  it('leaves a plan with no manager-conditional step untouched, question or not', (): void => {
    const plain = planWith(
      [{ kind: 'write', reads: [], writes: ['slack'] }, { kind: 'write', reads: [], writes: ['linear'] }, { kind: 'write', reads: [], writes: ['linear'] }],
      'promised', 3,
    );
    expect(openManagerQuestion({ plan: plain, actions: log1PhaseOne.actions, surfaces, answered: false })).toBeUndefined();
    const evidence = planWith(
      [{ kind: 'write', reads: [], writes: ['slack'] }, { kind: 'conditional-write', reads: [], writes: ['linear'] }],
      'none', null,
    );
    expect(openManagerQuestion({ plan: evidence, actions: [dm('Could you obtain an approved access path for it?'), comment!], surfaces, answered: false })).toBeUndefined();
  });

  it('withholds only what the plan made conditional: a surface an unconditional step writes keeps its write', (): void => {
    const mixed = planWith(
      [{ kind: 'write', reads: [], writes: ['slack'] }, { kind: 'write', reads: [], writes: ['linear'] }, { kind: 'conditional-write', reads: [], writes: ['linear'] }],
      'conditional-on-manager', 3,
    );
    const open = openManagerQuestion({ plan: mixed, actions: [question!, comment!, done!], surfaces, answered: false });
    expect(open?.withheld).toEqual([{ index: 2, step: 3 }]);
  });

  it('takes no question from a public post, a report, or a link with a query string', (): void => {
    const ask = (action: MockAction) => openManagerQuestion({ plan: log1Plan, actions: [action, comment!, done!], surfaces, answered: false });
    expect(ask(dm('Which template should I use?', 'C0PUBLIC'))).toBeUndefined();
    expect(ask(dm('The comment and Done are prepared and held for your approval.'))).toBeUndefined();
    expect(ask(dm('Recorded at https://linear.app/day00/issue/LOG-1?focus=comments and held.'))).toBeUndefined();
    expect(ask(dm('Which template should I use?'))?.withheld.map((row) => row.index)).toEqual([1, 2]);
  });
});

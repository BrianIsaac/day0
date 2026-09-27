import { describe, expect, it } from 'vitest';
import {
  managerConditionalSteps,
  managerMessageTexts,
  openManagerQuestion,
  writesAwaitingAnswer,
} from '../../../src/work/obligations';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { ExecutionPlan, MockAction, PlanObligations } from '../../../src/work/types';
import {
  log1PhaseOne,
  log1Plan,
  log1SecondSittingPhaseOne,
  log1SecondSittingPlan,
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

const LOG1_QUESTION =
  'Which template should the notice use, and what next-update time should it promise?';

describe('openManagerQuestion', () => {
  it("withholds the comment and Done the fourth sitting emitted beside LOG-1's question", (): void => {
    const open = openManagerQuestion({
      plan: log1Plan,
      actions: log1PhaseOne.actions,
      surfaces,
      question: LOG1_QUESTION,
      answered: false,
    });
    expect(open?.withheld).toEqual([{ index: 2, step: 2 }, { index: 3, step: 3 }]);
    expect(open?.steps).toEqual([2, 3]);
    expect(open?.question).toBe(LOG1_QUESTION);
    expect([read, question].map((action) => log1PhaseOne.actions.indexOf(action!))).toEqual([0, 1]);
  });

  it('withholds nothing once the manager answered, or when no question was put', (): void => {
    const args = { plan: log1Plan, actions: log1PhaseOne.actions, surfaces };
    expect(
      openManagerQuestion({ ...args, question: LOG1_QUESTION, answered: true }),
    ).toBeUndefined();
    expect(openManagerQuestion({ ...args, question: undefined, answered: false })).toBeUndefined();
    expect(openManagerQuestion({ ...args, question: '  ', answered: false })).toBeUndefined();
  });

  it("leaves the second sitting's phase one, the question alone, as it was", (): void => {
    expect(
      openManagerQuestion({
        plan: log1SecondSittingPlan,
        actions: log1SecondSittingPhaseOne,
        surfaces,
        question: LOG1_QUESTION,
        answered: false,
      }),
    ).toBeUndefined();
  });

  it('holds the writes for a question put in either language, with or without a question mark', (): void => {
    for (const asked of [
      'Please confirm which template the notice should use.',
      '请确认通知使用哪个模板。',
      'Which template should the notice use?',
      '通知应该使用哪个模板？',
    ]) {
      const open = openManagerQuestion({
        plan: log1Plan,
        actions: [comment!, done!],
        surfaces,
        question: asked,
        answered: false,
      });
      expect(open?.withheld.map((row) => row.index)).toEqual([0, 1]);
      expect(open?.question).toBe(asked);
    }
  });

  it('leaves a plan with no manager-conditional step untouched, question or not', (): void => {
    const plain = planWith(
      [{ kind: 'write', reads: [], writes: ['slack'] }, { kind: 'write', reads: [], writes: ['linear'] }, { kind: 'write', reads: [], writes: ['linear'] }],
      'promised', 3,
    );
    expect(
      openManagerQuestion({
        plan: plain,
        actions: log1PhaseOne.actions,
        surfaces,
        question: LOG1_QUESTION,
        answered: false,
      }),
    ).toBeUndefined();
    const evidence = planWith(
      [{ kind: 'write', reads: [], writes: ['slack'] }, { kind: 'conditional-write', reads: [], writes: ['linear'] }],
      'none', null,
    );
    expect(
      openManagerQuestion({
        plan: evidence,
        actions: [dm('Could you obtain an approved access path for it?'), comment!],
        surfaces,
        question: 'Could you obtain an approved access path for it?',
        answered: false,
      }),
    ).toBeUndefined();
  });

  it('withholds only what the plan made conditional: a surface an unconditional step writes keeps its write', (): void => {
    const mixed = planWith(
      [{ kind: 'write', reads: [], writes: ['slack'] }, { kind: 'write', reads: [], writes: ['linear'] }, { kind: 'conditional-write', reads: [], writes: ['linear'] }],
      'conditional-on-manager', 3,
    );
    const open = openManagerQuestion({
      plan: mixed,
      actions: [question!, comment!, done!],
      surfaces,
      question: LOG1_QUESTION,
      answered: false,
    });
    expect(open?.withheld).toEqual([{ index: 2, step: 3 }]);
  });

  it('keeps a long question to a length the card can show', (): void => {
    const long = openManagerQuestion({
      plan: log1Plan,
      actions: [comment!, done!],
      surfaces,
      answered: false,
      question: `Which template applies given ${'the carrier gave no revised ETA and '.repeat(40)}the handbook leaves it to you?`,
    });
    expect(long?.question.length).toBeLessThanOrEqual(600);
    expect(long?.question.endsWith('…')).toBe(true);
  });
});

describe('writesAwaitingAnswer', () => {
  it("names LOG-1's comment and Done, and never the manager DM beside them", (): void => {
    expect(
      writesAwaitingAnswer({ plan: log1Plan, actions: log1PhaseOne.actions, surfaces }),
    ).toEqual([
      { index: 2, step: 2 },
      { index: 3, step: 3 },
    ]);
  });
});

describe('managerMessageTexts', () => {
  it('reads the text of manager DMs only, never a public post', (): void => {
    expect(
      managerMessageTexts(
        [dm('Which template should I use?', 'C0PUBLIC'), comment!, dm('Held for you.')],
        surfaces,
      ),
    ).toEqual(['Held for you.']);
    expect(managerMessageTexts(log1PhaseOne.actions, surfaces)).toEqual([
      expect.stringContaining('Which template should the notice use'),
    ]);
  });
});

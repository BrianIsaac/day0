import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { ExecutionPlan, WorkCandidate } from '../../../src/work/types';

/**
 * The `day0-plan-obligations` judgement: one model call at plan-drafting
 * time, real mode only, that declares what each step obliges and the plan's
 * word on the ticket state, so the gates verify the run against the ledger
 * instead of parsing the prose. Scripted the way the scope judgement is.
 */

const model = vi.hoisted(() => ({
  calls: [] as Array<{ agent: string; user: string }>,
  judgement: undefined as unknown,
  plans: [] as unknown[],
}));

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string }; user: string }): Promise<unknown> => {
    model.calls.push({ agent: args.agent.name, user: args.user });
    if (args.agent.name === 'day0-plan-obligations') {
      if (model.judgement instanceof Error) throw model.judgement;
      return model.judgement;
    }
    const next = model.plans.shift();
    if (!next) throw new Error(`unscripted agent ${args.agent.name}`);
    return next;
  },
}));

import { draftExecutionPlan } from '../../../src/work/plan';
import {
  planObligationsPrompt,
  plannerObligationsOf,
  settlePlanObligations,
  type ObligationEvent,
} from '../../../src/work/plan-obligations';
import {
  declaredReads,
  planReadsBeforeClosing,
  readingSteps,
  transitionPromised,
  transitionWithheld,
} from '../../../src/work/obligations';
import { RUN_4_REVOPS_7_STEP_2, run4RefreshPlan, run4SlackPlan } from '../../convex/fixtures/plan-obligations-2026-09-16';

const NOW = Date.parse('2026-09-16T10:00:00.000Z');

const charter: Charter = {
  version: '0.0',
  source: 'day-1 manager 1:1',
  whyThisHire: 'Keep the Q3 close moving.',
  proposedFunction: 'Move routine Q3 close revenue operations work from Linear tickets with a clear audit trail.',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: {
    willDo: ['Handle Q3 close tickets in Linear with an audit comment on each.'],
    willNotDo: ['Post to public channels without approval.'],
    escalationTriggers: ['Unclear ownership'],
  },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-16T00:00:00.000Z',
};

const live = { verdict: 'connected' as const, credentialLanded: true, lastVerifiedAt: NOW };
const linear: SurfaceRecord = {
  slug: 'linear', displayName: 'Linear', class: 'kanban', path: 'mcp', endpoint: 'https://mcp.linear.app/mcp',
  toolAllowlist: ['get_issue', 'list_issues', 'save_comment', 'save_issue'], ...live,
};
const slack: SurfaceRecord = {
  slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api', endpoint: 'https://slack.com/api/',
  toolAllowlist: ['chat.postMessage', 'conversations.replies'], managerDmChannelId: 'D0MANAGER', ...live,
};
const tile: SurfaceRecord = {
  slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile', class: 'analytics', path: 'browser-driven',
  endpoint: 'http://looker-tile:8080/', toolAllowlist: ['browser_navigate', 'browser_fill_form', 'browser_click', 'browser_snapshot'], ...live,
};
/** Northstar CRM as the 16 September beds had it: named in the documentation, never connected. */
const northstar: SurfaceRecord = {
  slug: 'northstar-crm', displayName: 'Northstar CRM', class: 'crm', verdict: 'absent', credentialLanded: false,
};
const surfaces = [linear, slack, tile, northstar];

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue', sourceSystem: 'linear', externalId: 'REVOPS-7',
  title: 'Refresh the Looker pipeline tile', contentSummary: 'Set the tile to 74% and quote the audit line.',
  contentRefs: ['ticket://REVOPS-7'], observedAt: new Date(NOW),
};

const documents = {
  howToGuides: [{ slug: 'refresh', title: 'How to refresh the Looker pipeline tile', body: 'Sign in, set the figure, save, snapshot the audit line.' }],
  teamDocs: [{ slug: 'systems', title: 'Systems', body: 'Northstar CRM holds deal ownership; no connection exists.' }],
};

/** The judgement's answer for the run 4 REVOPS-7 plan: the tile sequence reads the tile, the comment and the Done write Linear. */
const refreshJudgement = {
  steps: [
    { step: 1, kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the documented sequence saves the figure and reads the audit line back' },
    { step: 2, kind: 'write', reads: [], writes: ['Linear'], reason: 'the comment quotes what step 1 read; Linear is only written' },
    { step: 3, kind: 'conditional-write', reads: [], writes: ['linear'], reason: 'the Done follows only when the audit line was read back' },
  ],
  transition: 'conditional-on-evidence',
  transitionStep: 3,
  reason: 'step 3 moves REVOPS-7 to Done only if the refresh landed',
};

const args = { plan: run4RefreshPlan, charter, surfaces, documents, now: NOW };

describe('the plan obligations prompt', (): void => {
  it('lists the connected surfaces with their tools, the absent ones as never an obligation, the documentation and the plan', (): void => {
    const prompt = planObligationsPrompt(args);
    expect(prompt).toContain('--- Connected surfaces (the only surfaces an obligation may name) ---');
    expect(prompt).toContain('  - linear (Linear) · class kanban · path mcp · tools: get_issue, list_issues, save_comment, save_issue');
    expect(prompt).toContain('  - looker-pipeline-tile (Looker pipeline tile) · class analytics · path browser-driven · tools: browser_navigate');
    expect(prompt).toContain('--- Surfaces with no connection (never an obligation) ---');
    expect(prompt).toContain('  - northstar-crm (Northstar CRM) · absent');
    expect(prompt).toContain('--- How-to guides ---');
    expect(prompt).toContain('Sign in, set the figure, save, snapshot the audit line.');
    expect(prompt).toContain(`2. ${RUN_4_REVOPS_7_STEP_2}`);
    expect(prompt.indexOf('--- Plan ---')).toBeGreaterThan(prompt.indexOf('--- Team docs'));
    expect(prompt.endsWith("Declare the obligations of every step and the plan's word on the ticket state now.")).toBe(true);
  });

  it('redacts a token shape a step quotes before it reaches the model', (): void => {
    const token = ['xoxb', '1234567890', 'abcdefghijklmnopqrstuvwx'].join('-');
    const prompt = planObligationsPrompt({ ...args, plan: { ...run4RefreshPlan, steps: [`Post with ${token}.`] } });
    expect(prompt).not.toContain(token);
  });
});

describe('settling the obligations', (): void => {
  beforeEach((): void => {
    model.calls.length = 0;
    model.judgement = refreshJudgement;
    model.plans.length = 0;
  });

  it('fills the fields when the planner supplied none, bounded to the connected surfaces by slug', async (): Promise<void> => {
    const settled = await settlePlanObligations(args, undefined);
    expect(model.calls.map((call) => call.agent)).toEqual(['day0-plan-obligations']);
    expect(settled.obligations).toEqual({
      steps: [
        { kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: refreshJudgement.steps[0]!.reason },
        { kind: 'write', reads: [], writes: ['linear'], reason: refreshJudgement.steps[1]!.reason },
        { kind: 'conditional-write', reads: [], writes: ['linear'], reason: refreshJudgement.steps[2]!.reason },
      ],
      transition: 'conditional-on-evidence',
      transitionStep: 3,
      basis: 'judgement',
      reason: refreshJudgement.reason,
    });
    expect(settled.events.map((event) => event.type)).toEqual(['plan.obligations-judged']);
  });

  it('never lets an absent surface become an obligation, whichever side names it', async (): Promise<void> => {
    model.judgement = {
      ...refreshJudgement,
      steps: [
        { step: 1, kind: 'read', reads: ['northstar-crm', 'Northstar CRM', 'looker-pipeline-tile'], writes: [], reason: 'r' },
        { step: 2, kind: 'write', reads: ['no-such-surface'], writes: ['linear', 'northstar-crm'], reason: 'w' },
        { step: 3, kind: 'report', reads: [], writes: [], reason: 'n' },
      ],
    };
    const settled = await settlePlanObligations(args, {
      steps: [
        { kind: 'read', reads: ['northstar-crm', 'looker-pipeline-tile'], writes: [] },
        { kind: 'write', reads: [], writes: ['linear', 'Northstar CRM'] },
        { kind: 'report', reads: [], writes: [] },
      ],
      transition: 'conditional-on-evidence',
      transitionStep: 3,
    });
    expect(settled.obligations?.steps.map((row) => [row.reads, row.writes])).toEqual([
      [['looker-pipeline-tile'], []],
      [[], ['linear']],
      [[], []],
    ]);
    // The planner's own absent-surface read is dropped before the comparison, so the two sides agree on the reads.
    expect(settled.events.map((event) => event.type)).toEqual(['plan.obligations-judged']);
  });

  it('checks the planner\'s fields, records the disagreement and lets the judgement stand', async (): Promise<void> => {
    const planner = {
      steps: [
        { kind: 'write' as const, reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'] },
        { kind: 'write' as const, reads: ['linear'], writes: ['linear'] },
        { kind: 'conditional-write' as const, reads: [], writes: ['linear'] },
      ],
      transition: 'withheld' as const,
      transitionStep: 3,
    };
    const settled = await settlePlanObligations(args, planner);
    expect(settled.obligations?.transition).toBe('conditional-on-evidence');
    expect(settled.obligations?.steps[1]?.reads).toEqual([]);
    const disagreed = settled.events.find((event) => event.type === 'plan.obligations-disagreed') as
      | Extract<ObligationEvent, { type: 'plan.obligations-disagreed' }>
      | undefined;
    expect(disagreed?.payload.differences).toEqual([
      'step 2 reads: planner [linear], judgement []',
      'transition: planner withheld, judgement conditional-on-evidence',
    ]);
    expect(disagreed?.payload.planner).toEqual(planner);
  });

  it('fails open when the model cannot be reached: the planner\'s fields stand unchecked, or nothing does', async (): Promise<void> => {
    model.judgement = new Error('provider unavailable');
    const planner = {
      steps: [
        { kind: 'write' as const, reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'] },
        { kind: 'write' as const, reads: [], writes: ['linear'] },
        { kind: 'conditional-write' as const, reads: [], writes: ['linear'] },
      ],
      transition: 'promised' as const,
      transitionStep: 3,
    };
    const withPlanner = await settlePlanObligations(args, planner);
    expect(withPlanner.obligations).toEqual({ ...planner, basis: 'planner', failedOpen: 'provider unavailable' });
    expect(withPlanner.events).toEqual([
      { type: 'plan.obligations-failed-open', payload: { reason: 'provider unavailable', planner } },
    ]);
    const without = await settlePlanObligations(args, undefined);
    expect(without.obligations).toBeUndefined();
    expect(without.events).toEqual([{ type: 'plan.obligations-failed-open', payload: { reason: 'provider unavailable' } }]);
  });

  it('fails open on a judgement that does not account for every step once, or has another shape', async (): Promise<void> => {
    model.judgement = { ...refreshJudgement, steps: refreshJudgement.steps.slice(0, 2) };
    const short = await settlePlanObligations(args, undefined);
    expect(short.obligations).toBeUndefined();
    expect(short.events[0]).toMatchObject({ type: 'plan.obligations-failed-open', payload: { reason: 'the judgement accounted for 2 step(s) of 3, not every step once' } });
    model.judgement = { summary: 'not a judgement' };
    const shapeless = await settlePlanObligations(args, undefined);
    expect(shapeless.obligations).toBeUndefined();
    expect(shapeless.events[0]).toMatchObject({ payload: { reason: 'the judgement reply did not satisfy the schema' } });
  });

  it('bounds the transition step to the plan and drops it under none', async (): Promise<void> => {
    model.judgement = { ...refreshJudgement, transitionStep: 9 };
    expect((await settlePlanObligations(args, undefined)).obligations?.transitionStep).toBeNull();
    model.judgement = { ...refreshJudgement, transition: 'none', transitionStep: 3 };
    expect((await settlePlanObligations(args, undefined)).obligations?.transitionStep).toBeNull();
  });

  it('reads the planner\'s reply fields only when they are whole', (): void => {
    const whole = plannerObligationsOf(
      { stepObligations: [{ kind: 'read', reads: ['Linear'], writes: [] }], transition: 'none', transitionStep: 2 },
      1, surfaces, NOW,
    );
    expect(whole).toEqual({ steps: [{ kind: 'read', reads: ['linear'], writes: [] }], transition: 'none', transitionStep: null });
    expect(plannerObligationsOf({ stepObligations: null, transition: 'promised', transitionStep: 1 }, 1, surfaces, NOW)).toBeUndefined();
    expect(plannerObligationsOf({ stepObligations: [], transition: 'promised', transitionStep: 1 }, 1, surfaces, NOW)).toBeUndefined();
  });
});

describe('the judgement inside plan drafting', (): void => {
  beforeEach((): void => {
    model.calls.length = 0;
    model.judgement = refreshJudgement;
    model.plans.length = 0;
  });

  const plannerReply = {
    summary: run4RefreshPlan.summary, steps: run4RefreshPlan.steps, expectedOutputType: 'ticket-update',
    riskNotes: '', reversibility: 'Re-enter the previous figure.', estimatedMinutes: 5,
    stepObligations: null, transition: null, transitionStep: null,
  };

  it('runs after the plan is drafted in real mode, records its events, and puts the obligations on the plan', async (): Promise<void> => {
    model.plans.push(plannerReply);
    const events: ObligationEvent[] = [];
    const plan = await draftExecutionPlan({
      candidate, charter, autonomousActions: true, surfaceMode: 'real', surfaces, documents, now: NOW,
      onObligationEvent: (event) => { events.push(event); },
    });
    expect(model.calls.map((call) => call.agent)).toEqual(['day0-plan', 'day0-plan-obligations']);
    expect(plan.obligations?.basis).toBe('judgement');
    expect(plan.obligations?.transition).toBe('conditional-on-evidence');
    expect(events.map((event) => event.type)).toEqual(['plan.obligations-judged']);
    expect(transitionPromised(plan)).toBe(true);
    expect(transitionWithheld(plan)).toBe(false);
    expect(readingSteps(plan)).toEqual([1]);
    expect(planReadsBeforeClosing(plan)).toBe(true);
    expect(declaredReads(plan, [linear, tile])).toEqual([{ step: 1, surface: tile }]);
  });

  it('never runs in mock mode, where the plan is what the mock planner returned', async (): Promise<void> => {
    model.plans.push({ ...plannerReply, stepObligations: undefined, transition: undefined, transitionStep: undefined });
    const plan = await draftExecutionPlan({ candidate, charter, autonomousActions: false, surfaceMode: 'mock' });
    expect(model.calls.map((call) => call.agent)).toEqual(['day0-plan']);
    expect(plan.obligations).toBeUndefined();
    expect(plan).not.toHaveProperty('stepObligations');
  });

  it('leaves a plan without obligations when the judgement fails open and the planner supplied none, and records why', async (): Promise<void> => {
    model.plans.push(plannerReply);
    model.judgement = new Error('timeout');
    const events: ObligationEvent[] = [];
    const plan = await draftExecutionPlan({
      candidate, charter, autonomousActions: true, surfaceMode: 'real', surfaces, documents, now: NOW,
      onObligationEvent: (event) => { events.push(event); },
    });
    expect(plan.obligations).toBeUndefined();
    expect(events).toEqual([{ type: 'plan.obligations-failed-open', payload: { reason: 'timeout' } }]);
    expect(declaredReads(plan, [linear, tile])).toEqual([]);
    expect(planReadsBeforeClosing(plan)).toBe(false);
  });

  it('judges the Slack plan with Northstar CRM in the message text as owing nothing of Northstar', async (): Promise<void> => {
    model.plans.push({ ...plannerReply, summary: run4SlackPlan.summary, steps: run4SlackPlan.steps, expectedOutputType: 'message' });
    model.judgement = {
      steps: [
        { step: 1, kind: 'write', reads: ['looker-pipeline-tile'], writes: ['looker-pipeline-tile'], reason: 'the refresh sequence and its snapshot' },
        { step: 2, kind: 'write', reads: [], writes: ['slack'], reason: 'the reply quotes the read-back; Northstar CRM has no connection and is only named in the text' },
      ],
      transition: 'none', transitionStep: null, reason: 'a chat ask has no ticket state',
    };
    const plan = await draftExecutionPlan({
      candidate: { ...candidate, sourceCategory: 'event-stream', sourceSystem: 'slack' },
      charter, autonomousActions: true, surfaceMode: 'real', surfaces, documents, now: NOW,
    });
    expect(plan.obligations?.steps.map((row) => row.reads)).toEqual([['looker-pipeline-tile'], []]);
    expect(declaredReads(plan, [linear, slack, tile, northstar]).map((read) => read.surface.slug)).toEqual(['looker-pipeline-tile']);
  });
});

describe('what the gates read from a plan', (): void => {
  const base: ExecutionPlan = {
    summary: 's', steps: ['a', 'b'], expectedOutputType: 'ticket-update', riskNotes: '', reversibility: '', estimatedMinutes: 1,
  };

  it('owes nothing from a plan with no obligations, or obligations that no longer line up with the steps', (): void => {
    expect(declaredReads(base, [linear])).toEqual([]);
    expect(readingSteps(base)).toEqual([]);
    expect(transitionPromised(base)).toBe(false);
    expect(transitionWithheld(base)).toBe(false);
    const stale = { ...base, obligations: { steps: [{ kind: 'read' as const, reads: ['linear'], writes: [] }], transition: 'promised' as const, transitionStep: 1, basis: 'judgement' as const } };
    expect(declaredReads(stale, [linear])).toEqual([]);
    expect(transitionPromised(stale)).toBe(false);
  });

  it('reads the transition as promised for an evidence condition and as withheld for the manager\'s decision', (): void => {
    const withTransition = (transition: ExecutionPlan['obligations'] extends infer O ? O extends { transition: infer T } ? T : never : never) => ({
      ...base,
      obligations: { steps: [{ kind: 'read' as const, reads: ['linear'], writes: [] }, { kind: 'write' as const, reads: [], writes: ['linear'] }], transition, transitionStep: 2, basis: 'judgement' as const },
    });
    expect(transitionPromised(withTransition('promised'))).toBe(true);
    expect(transitionPromised(withTransition('conditional-on-evidence'))).toBe(true);
    expect(transitionPromised(withTransition('conditional-on-manager'))).toBe(false);
    expect(transitionWithheld(withTransition('conditional-on-manager'))).toBe(true);
    expect(transitionWithheld(withTransition('withheld'))).toBe(true);
    expect(transitionWithheld(withTransition('none'))).toBe(false);
    expect(transitionPromised(withTransition('none'))).toBe(false);
  });

  it('ignores a declared read of a surface that is not in the list the gate holds, and lists a surface once per step', (): void => {
    const plan = {
      ...base,
      obligations: {
        steps: [{ kind: 'read' as const, reads: ['linear', 'LINEAR', 'northstar-crm'], writes: [] }, { kind: 'write' as const, reads: ['slack'], writes: ['linear'] }],
        transition: 'none' as const, transitionStep: null, basis: 'judgement' as const,
      },
    };
    expect(declaredReads(plan, [linear, slack])).toEqual([{ step: 1, surface: linear }, { step: 2, surface: slack }]);
    expect(declaredReads(plan, [linear])).toEqual([{ step: 1, surface: linear }]);
    expect(readingSteps(plan)).toEqual([1, 2]);
  });
});

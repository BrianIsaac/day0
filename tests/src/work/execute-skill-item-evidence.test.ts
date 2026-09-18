import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction, MockSurfaceSnapshot } from '../../../src/work/types';
import {
  LOG_2_DRAFT,
  LOG_2_DRAFT_DM,
  LOG_2_REFUSED_CLAIM,
  log2Candidate,
  log2GroundingAction,
  log2GroundingApplied,
  log2PhaseOneActions,
  log2Plan,
  managerDm,
} from '../../fixtures/work/full-run-2026-09-19-log-2';

/**
 * The work item as evidence for what the employee says about it: on 19
 * September Aiko's LOG-2 draft DM was withheld, after its one repair, for
 * repeating the ticket's own description. Both phases build their evidence
 * from the candidate and the plan-grounding read now; what the ticket does
 * not say is still refused, and nothing here reaches a prompt.
 */

const recorded = vi.hoisted(() => ({
  users: [] as string[],
  outputs: [] as unknown[],
}));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  agentJson: async <T>(args: { user: string }): Promise<T> => {
    recorded.users.push(args.user);
    const next = recorded.outputs.shift();
    if (!next) throw new Error('test did not provide another structured executor response');
    return next as T;
  },
}));

import { runDependentSkill, runSkill } from '../../../src/work/execute-skill';

const charter: Charter = {
  version: '0.0',
  source: 'test',
  whyThisHire: 'Keep shipment exceptions moving.',
  proposedFunction: 'Record routine shipment exceptions from the logistics desk tickets in Linear.',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Record shipment exceptions in Linear.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-19T00:00:00.000Z',
};

const mockEnv = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
} as unknown as MockSurfaceSnapshot;

const live = { verdict: 'connected' as const, credentialLanded: true, lastVerifiedAt: 1 };
const surfaces: SurfaceRecord[] = [
  { slug: 'linear', displayName: 'Linear', class: 'kanban', path: 'mcp', endpoint: 'https://mcp.linear.app/mcp', toolAllowlist: ['get_issue', 'list_issues', 'save_comment', 'save_issue'], ...live },
  { slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api', endpoint: 'https://slack.com/api/', toolAllowlist: ['chat.postMessage'], managerDmChannelId: 'D0MANAGER', ...live },
];

const groundingReads = [{ action: log2GroundingAction, applied: log2GroundingApplied }];
const skill = { name: 'kanban-comment-and-close', description: 'Comment and close.', body: '# Skill' };

const phaseOneOf = (actions: MockAction[]) => ({
  draft: LOG_2_DRAFT,
  notes: '',
  needsDependentPhase: false,
  deferredActions: null,
  actions,
  procedureTrails: [],
});
const asRun = phaseOneOf(log2PhaseOneActions);

const closingOf = (actions: MockAction[]) => ({
  draft: LOG_2_DRAFT,
  notes: '',
  actions,
  procedureTrails: [],
  planStepOutcomes: log2Plan.steps.map((_, index) => ({
    step: index + 1,
    status: 'satisfied' as const,
    evidence: 'Emitted in this response.',
    basis: 'action' as const,
  })),
});

describe('the work item in the evidence for what phase one says', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  const run = (extra: Partial<Parameters<typeof runSkill>[0]> = {}) =>
    runSkill({ skill, plan: log2Plan, candidate: log2Candidate, charter, mockEnv, mode: 'real', surfaces, groundingReads, ...extra });

  it('sends the 19 September DM on first try: the sentence is the ticket\'s own', async (): Promise<void> => {
    recorded.outputs.push(asRun);
    const output = await run();
    expect(recorded.users).toHaveLength(1);
    expect(output.actions).toEqual(log2PhaseOneActions);
    expect(output.withheldActions).toBeUndefined();
  });

  it('needs no grounding read when the row carries the sentence', async (): Promise<void> => {
    recorded.outputs.push(asRun);
    const output = await run({ groundingReads: undefined });
    expect(recorded.users).toHaveLength(1);
    expect(output.actions).toHaveLength(4);
  });

  it('still withholds, once, a DM that gives a date the ticket does not', async (): Promise<void> => {
    const wrong = phaseOneOf([
      log2PhaseOneActions[0]!,
      managerDm(LOG_2_DRAFT_DM.replaceAll('26 September', '27 September')),
      ...log2PhaseOneActions.slice(2),
    ]);
    recorded.outputs.push(wrong, wrong);
    const audits: number[][] = [];
    const output = await run({ onAuditCorrection: (indices) => void audits.push(indices) });
    expect(recorded.users).toHaveLength(2);
    expect(recorded.users[1]).toContain(`says "${LOG_2_REFUSED_CLAIM.replace('26', '27')}"`);
    expect(output.actions).toHaveLength(3);
    // One action was withheld, so one row and one index, however many of its sentences were refused.
    expect(output.withheldActions).toHaveLength(1);
    expect(audits).toEqual([[1]]);
  });

  it('does not take another employee\'s ticket for this item\'s', async (): Promise<void> => {
    const claim = 'The Brightwater freight accrual in NetLedger is confirmed at 41,200.';
    const fin4 = {
      action: { tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'get_issue', toolArgsJson: JSON.stringify({ id: 'FIN-4' }) } },
      applied: { ...log2GroundingApplied, providerId: 'FIN-4', effect: `get_issue on linear · ${JSON.stringify({ id: 'FIN-4', description: claim })}` },
    };
    const borrowed = phaseOneOf([log2PhaseOneActions[0]!, managerDm(claim), ...log2PhaseOneActions.slice(2)]);
    recorded.outputs.push(borrowed, borrowed);
    const output = await run({ groundingReads: [...groundingReads, fin4] });
    expect(output.withheldActions).toEqual([{ action: borrowed.actions[1], reason: expect.stringContaining(claim) }]);
  });

  it('puts nothing of the grounding read in a prompt, and no token-shaped value in a refusal', async (): Promise<void> => {
    const token = ['xo', 'xb-', '1234567890', '-', 'abcdefghijkl'].join('');
    const leaky = [{ action: log2GroundingAction, applied: { ...log2GroundingApplied, effect: `${log2GroundingApplied.effect} portal ${token}` } }];
    const wrong = phaseOneOf([managerDm(LOG_2_REFUSED_CLAIM.replace('26', '27'))]);
    recorded.outputs.push(wrong, wrong);
    const reasons: string[] = [];
    await run({ groundingReads: leaky, onAuditCorrection: (_, reason) => void reasons.push(reason) });
    const withReads = [...recorded.users];
    recorded.users.length = 0;
    recorded.outputs.push(wrong, wrong);
    await run({ groundingReads: undefined });
    expect(withReads).toEqual(recorded.users);
    expect([...withReads, ...reasons].join('\n')).not.toContain(token);
    expect(withReads.join('\n')).not.toContain('bb9a54f4-a988-43c0-a942-2b67ecfae17c');
  });

  it('leaves mock mode alone: same prompt, no check, whatever is handed in', async (): Promise<void> => {
    const mockResponse = { draft: 'Done.', notes: '', actions: [], procedureTrails: [] };
    recorded.outputs.push(mockResponse);
    await run({ mode: 'mock', surfaces: [] });
    const withReads = recorded.users[0];
    recorded.users.length = 0;
    recorded.outputs.push(mockResponse);
    await run({ mode: 'mock', surfaces: [], groundingReads: undefined });
    expect(recorded.users[0]).toBe(withReads);
  });
});

describe('the work item in the evidence for what the closing phase says', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  const close = (extra: Partial<Parameters<typeof runDependentSkill>[0]> = {}) =>
    runDependentSkill({
      skill, plan: log2Plan, candidate: log2Candidate, charter, mockEnv, mode: 'real', surfaces, groundingReads,
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
      ...extra,
    });

  it('sends the same DM from the closing phase', async (): Promise<void> => {
    recorded.outputs.push(closingOf([managerDm(LOG_2_DRAFT_DM)]));
    const output = await close();
    expect(recorded.users).toHaveLength(1);
    expect(output.actions).toHaveLength(1);
    expect(output.withheldActions).toBeUndefined();
  });

  it('still withholds a closing DM that gives a date the ticket does not', async (): Promise<void> => {
    const wrong = closingOf([managerDm(LOG_2_DRAFT_DM.replaceAll('26 September', '27 September'))]);
    recorded.outputs.push(wrong, wrong);
    const output = await close();
    expect(recorded.users).toHaveLength(2);
    expect(output.actions).toEqual([]);
    expect(output.withheldActions).toHaveLength(1);
  });
});

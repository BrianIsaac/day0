import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { ExecutionPlan, MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

const recorded = vi.hoisted(() => ({
  users: [] as string[],
}));

vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    name: string;
    constructor(config: { name: string }) {
      this.name = config.name;
    }
  },
}));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  agentJson: async <T>(args: { user: string }): Promise<T> => {
    recorded.users.push(args.user);
    const mock = args.user.includes('--- Current mock work environment ---');
    return {
      draft: 'Draft.',
      notes: '',
      actions: mock ? [{ tool: 'ticket.update', args: { slug: 'REVOPS-11', comment: 'Refreshed.' } }] : [],
      procedureTrails: [],
      planStepOutcomes: [{ step: 1, status: 'satisfied', evidence: 'ledger row 0' }],
    } as T;
  },
}));

import { runDependentSkill, runSkill } from '../../../src/work/execute-skill';

const charter: Charter = {
  version: '0.0',
  source: 'day-1 manager 1:1',
  whyThisHire: 'Keep hand-offs moving.',
  proposedFunction: 'Revenue operations',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Keep the tile current.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-15T02:00:00.000Z',
};

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'REVOPS-11',
  title: 'Refresh the Looker pipeline tile',
  contentSummary: 'Set the pipeline coverage figure to 68% and record the audit line.',
  contentRefs: ['ticket://REVOPS-11'],
  observedAt: new Date('2026-09-15T01:59:00.000Z'),
  priority: 'P1',
  requesterLabel: 'Manager',
};

const plan: ExecutionPlan = {
  summary: 'Refresh the tile and comment.',
  steps: ['Refresh the tile and comment on the ticket.'],
  expectedOutputType: 'ticket-update',
  riskNotes: '',
  reversibility: '',
  estimatedMinutes: 1,
};

const mockEnv = {
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
  teamDocs: [],
  howToGuides: [],
} as unknown as MockSurfaceSnapshot;

const parameterised = {
  name: 'analytics-refresh-value',
  description: 'Value refresh on an analytics surface.',
  body: [
    '# Value refresh',
    '## Inputs',
    '- `<record-id>`: the candidate id.',
    '- `<requested-value>`: the figure the candidate names.',
    '## Procedure',
    'Fill `Pipeline coverage` with `<requested-value>`; comment on `<record-id>`.',
  ].join('\n'),
};

const legacy = { name: 'update-linear-ticket', description: 'Legacy.', body: 'Comment, then close.' };

describe('the executor binds a parameterised skill from the candidate', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
  });

  it('puts the bound inputs in the first-phase prompt after the candidate', async (): Promise<void> => {
    await runSkill({ skill: parameterised, plan, candidate, charter, mockEnv, mode: 'real', surfaces: [] });

    const prompt = recorded.users[0]!;
    const inputs = prompt.indexOf('--- Skill inputs for this run (bind every declared input before acting) ---');
    expect(inputs).toBeGreaterThan(prompt.indexOf('--- Candidate ---'));
    expect(inputs).toBeLessThan(prompt.indexOf('Preserve every explicitly requested identifier'));
    expect(prompt).toContain('  - <record-id> = REVOPS-11 (the candidate id)');
    expect(prompt).toContain(
      '  - <requested-value>: read it from the candidate body, its Refs line or the runbook for this run; the skill body carries no value for it',
    );
  });

  it('puts the same bindings in the closing-phase prompt', async (): Promise<void> => {
    await runDependentSkill({
      skill: parameterised,
      plan,
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });

    expect(recorded.users[0]).toContain('--- Skill inputs for this run');
    expect(recorded.users[0]).toContain('  - <record-id> = REVOPS-11 (the candidate id)');
  });

  it('leaves the prompt of a skill without declared inputs exactly as it was', async (): Promise<void> => {
    await runSkill({ skill: legacy, plan, candidate, charter, mockEnv, mode: 'mock' });
    await runSkill({ skill: legacy, plan, candidate, charter, mockEnv, mode: 'real', surfaces: [] });

    for (const prompt of recorded.users) {
      expect(prompt).not.toContain('Skill inputs for this run');
      expect(prompt).not.toContain('<record-id>');
    }
  });
});

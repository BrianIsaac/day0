import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { PlannerCorrection } from '../../../src/work/corrections';
import type { ExecutionPlan, MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

/**
 * The corrections the approved plan applied reach both executor prompts
 * beside the manager's feedback on this item, under the same rule: they
 * revise how the work is done and never override. The mock prompts carry
 * none of it.
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
  whyThisHire: 'Keep shipments moving.',
  proposedFunction: 'Logistics desk: handle shipment exception tickets.',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Handle shipment exception tickets.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-18T00:00:00.000Z',
};

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'LOG-2',
  title: 'Exception: SH-4502 delayed at the port',
  contentSummary: 'Notify the customer of the delay.',
  contentRefs: ['ticket://LOG-2'],
  observedAt: new Date('2026-09-18T00:00:00.000Z'),
};

const plan: ExecutionPlan = {
  summary: 'Comment the delay notice on LOG-2.',
  steps: ['Comment the Delay notice B template on LOG-2 with a 48-hour follow-up.'],
  expectedOutputType: 'ticket-update',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 2,
  appliedCorrections: ['c-note'],
};

const mockEnv = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
} as unknown as MockSurfaceSnapshot;

const applied: PlannerCorrection[] = [
  {
    id: 'c-note',
    from: 'Retry note on "Exception: SH-4471 held at customs"',
    when: '2026-09-18T07:40Z',
    text: 'Use the Delay notice B template and follow up in 48 hours.',
  },
];

const phaseOne = {
  draft: 'Commenting the delay notice.',
  notes: '',
  needsDependentPhase: false,
  deferredActions: [],
  actions: [],
  procedureTrails: [],
};

describe('the corrections the approved plan applied, in the executor prompts', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  it('puts them in phase one beside the manager feedback, under the rule', async (): Promise<void> => {
    recorded.outputs.push(phaseOne);
    await runSkill({
      skill: { name: 'kanban-comment', description: 'Comment.', body: '# Skill' },
      plan,
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      appliedCorrections: applied,
    });
    const user = recorded.users[0];
    expect(user).toContain('--- Corrections the approved plan applies ---');
    expect(user).toContain(JSON.stringify(applied));
    expect(user).toContain('none overrides the charter, an approval requirement, a grant or the exact-action gate');
  });

  it('puts them in the closing phase too', async (): Promise<void> => {
    recorded.outputs.push({
      draft: 'Closing.',
      notes: '',
      actions: [],
      procedureTrails: [],
      planStepOutcomes: [{ step: 1, status: 'blocked', basis: 'ledger', evidence: 'nothing landed yet' }],
    });
    await runDependentSkill({
      skill: { name: 'kanban-comment', description: 'Comment.', body: '# Skill' },
      plan,
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      appliedCorrections: applied,
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });
    expect(recorded.users[0]).toContain('--- Corrections the approved plan applies ---');
    expect(recorded.users[0]).toContain('Use the Delay notice B template and follow up in 48 hours.');
  });

  it('leaves the mock executor prompt as it was', async (): Promise<void> => {
    const mockOutput = { draft: 'Drafted.', notes: '', actions: [], procedureTrails: [] };
    recorded.outputs.push(mockOutput, mockOutput);
    const args = {
      skill: { name: 'kanban-comment', description: 'Comment.', body: '# Skill' },
      plan: { ...plan, expectedOutputType: 'draft-document' as const, appliedCorrections: undefined },
      candidate,
      charter,
      mockEnv,
      mode: 'mock' as const,
    };
    await runSkill(args);
    await runSkill({ ...args, appliedCorrections: applied });
    expect(recorded.users[1]).toBe(recorded.users[0]);
    expect(recorded.users[1]).not.toContain('Corrections');
  });
});

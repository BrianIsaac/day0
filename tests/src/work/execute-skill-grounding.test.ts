import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

const recorded = vi.hoisted(() => ({
  users: [] as string[],
  instructions: [] as string[],
}));

vi.mock('@mastra/core/agent', () => ({
  Agent: class {
    name: string;
    constructor(config: { name: string; instructions: string }) {
      this.name = config.name;
      recorded.instructions.push(config.instructions);
    }
  },
}));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  agentJson: async <T>(args: { user: string }): Promise<T> => {
    recorded.users.push(args.user);
    return {
      draft: 'Closing draft.',
      notes: '',
      actions: [],
      procedureTrails: [],
      planStepOutcomes: [{ step: 1, status: 'satisfied', evidence: 'ledger row 0' }],
    } as T;
  },
}));

import { executorPreamble, runDependentSkill } from '../../../src/work/execute-skill';

const charter: Charter = {
  version: '0.0',
  source: 'day-1 manager 1:1',
  whyThisHire: 'Keep hand-offs moving.',
  proposedFunction: 'Operations coordination',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Keep the tracker current.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-03T02:00:00.000Z',
};

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'tracker',
  externalId: 'T-1',
  title: 'Record the checklist review on the ticket',
  contentSummary: 'Summarise the completed checks as a comment.',
  contentRefs: ['ticket://T-1'],
  observedAt: new Date('2026-09-03T01:59:00.000Z'),
  priority: 'P2',
  requesterLabel: 'Manager',
};

const mockEnv = {
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
  teamDocs: [
    {
      slug: 'team-handbook',
      title: 'Team handbook',
      body: 'Close checklist: reconcile the ledger, confirm the owner, file the summary.',
    },
  ],
  howToGuides: [],
} as unknown as MockSurfaceSnapshot;

describe('documentation grounding in the executor prompts', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.instructions.length = 0;
  });

  it('tells the real-mode executor that loaded documentation is citable evidence', (): void => {
    expect(executorPreamble('real')).toContain('citable');
  });

  it('gives the closing phase the loaded documentation beside the ledger', async (): Promise<void> => {
    await runDependentSkill({
      skill: { name: 'tracker-action', description: 'Tracker work.', body: '# Skill' },
      plan: {
        summary: 'Comment on the ticket.',
        steps: ['Comment on the ticket with the checklist review.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
      },
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      managerFeedback: 'Quote the checklist items from the handbook.',
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });

    expect(recorded.users).toHaveLength(1);
    expect(recorded.users[0]).toContain('--- Team docs (read-only context) ---');
    expect(recorded.users[0]).toContain('Close checklist: reconcile the ledger, confirm the owner, file the summary.');
    expect(recorded.instructions[0]).toContain('citable');
  });

  it('tells the closing phase that a step it fulfils by an action emitted now is satisfied', async (): Promise<void> => {
    await runDependentSkill({
      skill: { name: 'tracker-action', description: 'Tracker work.', body: '# Skill' },
      plan: {
        summary: 'Comment, then close.',
        steps: ['Comment on the ticket.', 'Move the ticket to Done.'],
        expectedOutputType: 'ticket-update',
        riskNotes: '',
        reversibility: '',
        estimatedMinutes: 1,
      },
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    }).catch((): undefined => undefined);

    expect(recorded.instructions[0]).toContain('emitted in this response is satisfied');
  });
});

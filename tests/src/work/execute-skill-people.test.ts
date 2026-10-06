import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { PromptPeople } from '../../../src/people/prompt-block';
import type { ExecutionPlan, MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

/**
 * The People block (wave 13, F9; 13-J) in both executor prompts: it replaces the charter's
 * namedCollaborators line inside the charter lines, real mode only, and leaves that line where it
 * was when the graph has no one for the employee. The mock prompts carry none of it.
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
  proposedBoundaries: {
    willDo: ['Handle shipment exception tickets.'],
    willNotDo: [],
    escalationTriggers: [],
  },
  namedCollaborators: [{ name: 'Lee Tan', topic: 'Linear access', introPath: 'manager' }],
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
};

const mockEnv = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
} as unknown as MockSurfaceSnapshot;

const people: PromptPeople = {
  people: [
    {
      displayName: 'Lee Tan',
      title: 'Work management administrator',
      edges: [
        { type: 'collaborator', scope: 'Linear access and workflow' },
        { type: 'adjacent-role', scope: 'Raising access requests through the manager' },
      ],
    },
    {
      displayName: 'Dana Okafor',
      title: 'Finance systems owner',
      edges: [{ type: 'dotted-line' }],
    },
  ],
  escalation: { kind: 'person', displayName: 'Sara Lindqvist', scope: 'missing Linear access' },
};

const BLOCK = [
  'People the manager confirmed, by name and role. None of them approves a write; the manager does.',
  '- Lee Tan (Work management administrator): works with you on Linear access and workflow; neighbouring role, Raising access requests through the manager.',
  '- Dana Okafor (Finance systems owner): dotted line.',
  '- Escalate to: Sara Lindqvist, for missing Linear access.',
].join('\n');

const CHARTER_LINE = 'Charter namedCollaborators: Lee Tan (Linear access)';

const phaseOne = {
  draft: 'Commenting the delay notice.',
  notes: '',
  needsDependentPhase: false,
  deferredActions: [],
  actions: [],
  procedureTrails: [],
};

const closing = {
  draft: 'Closing.',
  notes: '',
  actions: [],
  procedureTrails: [],
  planStepOutcomes: [
    { step: 1, status: 'blocked', basis: 'ledger', evidence: 'nothing landed yet' },
  ],
};

const initialOutput = {
  draft: '',
  notes: '',
  needsDependentPhase: true,
  actions: [],
  procedureTrails: [],
};

const skill = { name: 'kanban-comment', description: 'Comment.', body: '# Skill' };

describe('the People block in the executor prompts (13-J)', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  it('replaces the charter namedCollaborators line in phase one, inside the charter lines', async (): Promise<void> => {
    recorded.outputs.push(phaseOne);
    await runSkill({
      skill,
      plan,
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      people,
    });
    const user = recorded.users[0]!;
    expect(user).toContain(BLOCK);
    expect(user).not.toContain('Charter namedCollaborators');
    expect(user.indexOf(BLOCK)).toBeGreaterThan(user.indexOf('Charter namedSystems'));
    expect(user.indexOf(BLOCK)).toBeLessThan(user.indexOf('Charter approvalChain'));
  });

  it('replaces it in the closing phase too', async (): Promise<void> => {
    recorded.outputs.push(closing);
    await runDependentSkill({
      skill,
      plan,
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      people,
      initialOutput,
      initialLedger: [],
    });
    const user = recorded.users[0]!;
    expect(user).toContain(BLOCK);
    expect(user).not.toContain('Charter namedCollaborators');
    expect(user.indexOf(BLOCK)).toBeLessThan(user.indexOf('Charter approvalChain'));
  });

  it("keeps the charter's own line when the graph has no one for the employee", async (): Promise<void> => {
    recorded.outputs.push(phaseOne, phaseOne);
    await runSkill({
      skill,
      plan,
      candidate,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      people: { people: [], escalation: { kind: 'manager' } },
    });
    await runSkill({ skill, plan, candidate, charter, mockEnv, mode: 'real', surfaces: [] });
    expect(recorded.users[0]).toContain(CHARTER_LINE);
    expect(recorded.users[0]).not.toContain('People the manager confirmed');
    expect(recorded.users[0]).toBe(recorded.users[1]);
  });

  it("names a confirmed requester on phase one's From line, in real mode only", async (): Promise<void> => {
    const requester = { displayName: 'Lee Tan', title: 'Work management administrator' };
    const labelled = { ...candidate, requesterLabel: 'U07LEE12345' };
    recorded.outputs.push(phaseOne, phaseOne);
    await runSkill({
      skill,
      plan,
      candidate: labelled,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
      requester,
    });
    await runSkill({
      skill,
      plan,
      candidate: labelled,
      charter,
      mockEnv,
      mode: 'real',
      surfaces: [],
    });
    expect(recorded.users[0]).toContain('\nFrom: Lee Tan (Work management administrator)\n');
    expect(recorded.users[0]).not.toContain('U07LEE12345');
    expect(recorded.users[1]).toContain('\nFrom: U07LEE12345\n');
  });

  it('leaves the mock executor prompt as it was', async (): Promise<void> => {
    const mockOutput = { draft: 'Drafted.', notes: '', actions: [], procedureTrails: [] };
    recorded.outputs.push(mockOutput, mockOutput);
    const args = {
      skill,
      plan: { ...plan, expectedOutputType: 'draft-document' as const },
      candidate,
      charter,
      mockEnv,
      mode: 'mock' as const,
    };
    await runSkill(args);
    await runSkill({ ...args, people, requester: { displayName: 'Lee Tan' } });
    expect(recorded.users[1]).toBe(recorded.users[0]);
    expect(recorded.users[1]).not.toContain('People the manager confirmed');
  });
});

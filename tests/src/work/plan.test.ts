import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { WorkCandidate } from '../../../src/work/types';
import { actionModeInstruction, draftExecutionPlan, planSystemPrompt } from '../../../src/work/plan';

describe('plan drafter action mode', (): void => {
  it('states the autonomous mode without supervised approval language', (): void => {
    const prompt = planSystemPrompt(true);
    expect(prompt).toContain(
      'Autonomous actions are ON: every allowed write lands as emitted; do not say an action is queued or awaiting approval.',
    );
    expect(prompt).not.toContain('the boss will approve before you act');
    expect(prompt).not.toContain('Prefer drafts over actions');
  });

  it('states exactly what lands and what waits while autonomous actions are off', (): void => {
    expect(planSystemPrompt(false)).toContain(
      "Autonomous actions are OFF: reads and the manager DM land now; every other write is held for the manager's literal approval - say so.",
    );
    // OFF must not claim that writes apply; ON must not say anything waits.
    expect(actionModeInstruction(false)).toContain('every other write is held');
    expect(actionModeInstruction(false)).not.toMatch(/lands as emitted/);
    expect(actionModeInstruction(true)).not.toMatch(/is held|waits for/);
    expect(planSystemPrompt(false).split(actionModeInstruction(false))).toHaveLength(2);
  });

  it('states that every mock comparison action waits at the exact-action gate', (): void => {
    const instruction = actionModeInstruction(true, 'mock');
    expect(instruction).toContain('Mock comparison mode');
    expect(instruction).toContain('every emitted action is held');
    expect(instruction).not.toContain('lands as emitted');
    expect(planSystemPrompt(false, 'mock')).toContain(instruction);
  });
});

const planRecorded = vi.hoisted(() => ({ users: [] as string[], instructions: [] as string[] }));

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (_name: string, instructions: string) => {
    planRecorded.instructions.push(instructions);
    return { name: 'day0-plan' };
  },
  agentJson: async <T>(args: { user: string }): Promise<T> => {
    planRecorded.users.push(args.user);
    return {
      summary: 'Refresh the tile as the runbook says.',
      steps: ['Sign in and set the figure.', 'Read the audit line back.'],
      expectedOutputType: 'ticket-update',
      riskNotes: '',
      reversibility: 'reversible',
      estimatedMinutes: 5,
    } as T;
  },
}));

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
  externalId: 'T-2',
  title: 'Refresh the dashboard tile',
  contentSummary: '',
  contentRefs: ['ticket://T-2'],
  observedAt: new Date('2026-09-03T01:59:00.000Z'),
  priority: 'P3',
  requesterLabel: 'Manager',
};

const now = Date.parse('2026-09-03T02:00:00.000Z');

const surfaces: SurfaceRecord[] = [
  {
    slug: 'dashboard-tile',
    displayName: 'Dashboard tile',
    class: 'analytics',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now - 60_000,
    path: 'browser-driven',
    endpoint: 'http://tile.internal/',
  },
  {
    slug: 'crm',
    displayName: 'Customer records',
    class: 'crm',
    verdict: 'absent',
    credentialLanded: false,
  },
];

const documents = {
  howToGuides: [
    {
      slug: 'how-to-refresh-the-tile',
      title: 'How to refresh the dashboard tile',
      body: 'Sign in, set the coverage figure, save, then read the audit line back.',
    },
  ],
  teamDocs: [
    { slug: 'systems', title: 'Systems', body: 'The dashboard tile has a web UI only.' },
  ],
};

describe('plan drafter grounding', (): void => {
  beforeEach((): void => {
    planRecorded.users.length = 0;
    planRecorded.instructions.length = 0;
  });

  it('tells the planner which evidence it plans from', (): void => {
    const prompt = planSystemPrompt(false);
    expect(prompt).toContain('connected');
    expect(prompt).toContain('documentation');
    expect(prompt).toContain('no connected surface');
  });

  it('gives the planner the surfaces with their verdicts and the loaded documentation', async (): Promise<void> => {
    await draftExecutionPlan({
      candidate,
      charter,
      autonomousActions: false,
      surfaceMode: 'real',
      surfaces,
      documents,
      now,
    });
    expect(planRecorded.users).toHaveLength(1);
    const user = planRecorded.users[0];
    expect(user).toContain('--- Surfaces ---');
    expect(user).toMatch(/dashboard-tile \(Dashboard tile\).*connected.*browser-driven/);
    expect(user).toMatch(/crm \(Customer records\).*absent/);
    expect(user).toContain('--- How-to guides ---');
    expect(user).toContain('Sign in, set the coverage figure, save, then read the audit line back.');
    expect(user).toContain('--- Team docs (read-only context) ---');
    expect(user).toContain('The dashboard tile has a web UI only.');
    expect(user.indexOf('--- Candidate ---')).toBeLessThan(user.indexOf('--- Surfaces ---'));
  });

  it('keeps the prompt as it was when no surfaces or documentation are given', async (): Promise<void> => {
    await draftExecutionPlan({ candidate, charter, autonomousActions: false, surfaceMode: 'mock' });
    const user = planRecorded.users[0];
    expect(user).not.toContain('--- Surfaces ---');
    expect(user).not.toContain('--- Team docs');
    expect(user).not.toContain('--- How-to guides ---');
    expect(user.endsWith('Draft the execution plan now.')).toBe(true);
  });
});

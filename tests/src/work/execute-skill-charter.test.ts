import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { ExecutionPlan, MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

/**
 * Backlog step 4 (P8-9): the closing phase writes the comment, the reply and
 * the state change, so it is given the charter it is told to stay inside, and
 * a decision it takes under a charter clause records that clause. Phase one
 * gains the escalation triggers it was never shown. The mock prompt is the
 * hosted demo's and is left as it was.
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

import {
  CURRENT_MANAGER_UNNAMED,
  executorCharterLines,
  runDependentSkill,
  runSkill,
} from '../../../src/work/execute-skill';

const charter: Charter = {
  version: '0.2',
  source: 'test',
  whyThisHire: 'Keep shipments moving.',
  proposedFunction: 'Logistics desk: handle shipment exception tickets.',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: {
    willDo: ['Handle shipment exception tickets.'],
    willNotDo: ['Never send a customer notice without the desk lead approving the template.'],
    escalationTriggers: ['A carrier gives no revised ETA.'],
  },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [
    { who: 'Customer success', staysOutOfTheirLaneBy: 'never writing to the customer directly' },
  ],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  answeredQuestions: [
    {
      question: 'Which notice template applies when the ETA is unconfirmed?',
      answer: 'Delay notice B.',
      answeredAt: '2026-09-20T00:00:00.000Z',
    },
  ],
  createdAt: '2026-09-18T00:00:00.000Z',
};

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'LOG-1',
  title: 'Exception: SH-4471 held at Port Klang',
  contentSummary: 'Record the exception and notify the customer.',
  contentRefs: ['ticket://LOG-1'],
  observedAt: new Date('2026-09-18T00:00:00.000Z'),
};

const plan: ExecutionPlan = {
  summary: 'Comment the exception, then send the notice once the template is confirmed.',
  steps: ['Comment the exception on LOG-1.', 'Send the customer notice.'],
  expectedOutputType: 'ticket-update',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 5,
};

const mockEnv = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
} as unknown as MockSurfaceSnapshot;

const skill = { name: 'kanban-comment', description: 'Comment.', body: '# Skill' };

const closingArgs = {
  skill,
  plan,
  candidate,
  charter,
  mockEnv,
  mode: 'real' as const,
  surfaces: [],
  initialOutput: {
    draft: '',
    notes: '',
    needsDependentPhase: true,
    actions: [],
    procedureTrails: [],
  },
  initialLedger: [],
};

/** A closing reply whose second step the model says a charter clause decided. */
function closingReply(charterClause: string | null): unknown {
  return {
    draft: 'Commented; the notice waits for the desk lead.',
    notes: '',
    openQuestion: null,
    actions: [],
    procedureTrails: [],
    planStepOutcomes: [
      {
        step: 1,
        status: 'blocked',
        basis: 'ledger',
        evidence: 'nothing landed yet',
        charterClause: null,
      },
      {
        step: 2,
        status: 'blocked',
        basis: 'ledger',
        evidence: 'the template is not approved',
        charterClause,
      },
    ],
  };
}

describe('the charter in the executor prompts', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  it('gives the closing phase every boundary, the adjacent roles and the answered questions', async (): Promise<void> => {
    recorded.outputs.push(closingReply(null));

    await runDependentSkill(closingArgs);

    const user = recorded.users[0]!;
    expect(user).toContain('Role: Logistics desk: handle shipment exception tickets.');
    expect(user).toContain('Charter willDo: Handle shipment exception tickets.');
    expect(user).toContain(
      'Charter willNotDo: Never send a customer notice without the desk lead approving the template.',
    );
    expect(user).toContain('Charter escalationTriggers: A carrier gives no revised ETA.');
    expect(user).toContain(
      'Charter adjacentRoles: Customer success: never writing to the customer directly',
    );
    expect(user).toContain(
      'Which notice template applies when the ETA is unconfirmed? Delay notice B.',
    );
    // The approval chain names the manager the employee reports to now, never the charter's
    // draft-time label, which a handover leaves naming the old manager (wave 9 review, section 3).
    expect(user).toContain(`Charter approvalChain: ${CURRENT_MANAGER_UNNAMED}`);
    expect(user).not.toContain('Charter approvalChain: Manager');
    expect(user).toContain('Charter namedSystems: (none)');
  });

  it('gives real phase one the escalation triggers and answers, and leaves the mock prompt as it was', async (): Promise<void> => {
    const phaseOne = {
      draft: 'Commenting.',
      notes: '',
      needsDependentPhase: false,
      deferredActions: [],
      openQuestion: null,
      actions: [],
      procedureTrails: [],
    };
    recorded.outputs.push(phaseOne);
    await runSkill({ skill, plan, candidate, charter, mockEnv, mode: 'real', surfaces: [] });
    expect(recorded.users[0]).toContain(
      'Charter escalationTriggers: A carrier gives no revised ETA.',
    );
    expect(recorded.users[0]).toContain('Delay notice B.');

    recorded.outputs.push({ ...phaseOne, actions: [] });
    await runSkill({ skill, plan, candidate, charter, mockEnv, mode: 'mock' }).catch(
      // The mock contract refuses an empty set after its repair; only the prompt matters here.
      (): undefined => undefined,
    );
    expect(recorded.users[1]).toContain('Charter willNotDo:');
    expect(recorded.users[1]).not.toContain('escalationTriggers');
    expect(recorded.users[1]).not.toContain('Delay notice B.');
  });
});

describe('the clause a closing decision was taken under', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  it('keeps the charter clause the model quotes, with its field and the charter version', async (): Promise<void> => {
    recorded.outputs.push(
      closingReply('never send a customer notice without the desk lead approving the template'),
    );

    const output = await runDependentSkill(closingArgs);

    expect(output.planStepOutcomes[0]).not.toHaveProperty('charterClause');
    expect(output.planStepOutcomes[1]?.charterClause).toEqual({
      field: 'willNotDo',
      text: 'Never send a customer notice without the desk lead approving the template.',
      charterVersion: '0.2',
    });
  });

  it('reads a stretch two lists share as the limit it sets', async (): Promise<void> => {
    const shared = 'the desk lead approving the template';
    recorded.outputs.push(closingReply(shared));

    const output = await runDependentSkill({
      ...closingArgs,
      charter: {
        ...charter,
        proposedBoundaries: {
          ...charter.proposedBoundaries,
          willDo: ['Send a customer notice after the desk lead approving the template.'],
        },
      },
    });

    expect(output.planStepOutcomes[1]?.charterClause?.field).toBe('willNotDo');
  });

  it('keeps nothing for a quote the charter does not carry', async (): Promise<void> => {
    recorded.outputs.push(closingReply('Never notify a customer on a Friday.'));

    const output = await runDependentSkill(closingArgs);

    expect(output.planStepOutcomes[1]).not.toHaveProperty('charterClause');
  });
});

describe('executorCharterLines: who approves, after a handover', (): void => {
  const handedOver: Charter = {
    ...charter,
    approvalChain: { boss: 'sam@old.example', confidence: 'high' },
  };

  it('never renders the charter’s draft-time approver, which a handover leaves naming the old manager', (): void => {
    const lines = executorCharterLines(handedOver, 'real');

    expect(lines.join('\n')).not.toContain('sam@old.example');
    expect(lines).toContain(`Charter approvalChain: ${CURRENT_MANAGER_UNNAMED}`);
  });

  it('names the current manager when the run is given one', (): void => {
    const lines = executorCharterLines(handedOver, 'real', 'priya@new.example');

    expect(lines).toContain('Charter approvalChain: priya@new.example');
    expect(lines.join('\n')).not.toContain('sam@old.example');
  });
});

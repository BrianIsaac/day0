import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { ExecutionPlan, MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

/**
 * Review M9 (wave 1.5): the hold on the writes a question waits on rests on
 * the executor's `openQuestion` becoming the output's `declaredQuestion`.
 * Each real phase is driven through its model reply here, so a mapping that
 * lost the question would fail a test rather than release the writes.
 */

const recorded = vi.hoisted(() => ({ outputs: [] as unknown[] }));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  agentJson: async <T>(): Promise<T> => {
    const next = recorded.outputs.shift();
    if (!next) throw new Error('test did not provide another structured executor response');
    return next as T;
  },
}));

import { runDependentSkill, runSkill } from '../../../src/work/execute-skill';

const QUESTION = '请确认通知使用哪个模板。';

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
    escalationTriggers: [],
  },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  answeredQuestions: [],
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

/** A phase-one reply that declares the given question. */
function phaseOneReply(openQuestion: string | null): unknown {
  return {
    draft: 'Commenting; the notice waits for the template.',
    notes: '',
    needsDependentPhase: false,
    deferredActions: [],
    openQuestion,
    actions: [],
    procedureTrails: [],
  };
}

/** A closing reply that declares the given question. */
function closingReply(openQuestion: string | null): unknown {
  return {
    draft: 'The notice waits for the template.',
    notes: '',
    openQuestion,
    actions: [],
    procedureTrails: [],
    planStepOutcomes: [1, 2].map((step) => ({
      step,
      status: 'blocked',
      basis: 'ledger',
      evidence: 'the template is not confirmed',
      charterClause: null,
    })),
  };
}

describe('the question each real phase declares', (): void => {
  beforeEach((): void => {
    recorded.outputs.length = 0;
  });

  it('keeps the question phase one declares as the output declaredQuestion, and a blank one as none', async (): Promise<void> => {
    const args = { skill, plan, candidate, charter, mockEnv, mode: 'real' as const, surfaces: [] };
    recorded.outputs.push(phaseOneReply(`  ${QUESTION}  `));
    await expect(runSkill(args)).resolves.toMatchObject({ declaredQuestion: QUESTION });

    recorded.outputs.push(phaseOneReply(' \n '));
    await expect(runSkill(args)).resolves.toMatchObject({ declaredQuestion: null });
  });

  it('keeps the question the closing phase declares as the output declaredQuestion, and a blank one as none', async (): Promise<void> => {
    const args = {
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
    recorded.outputs.push(closingReply(QUESTION));
    await expect(runDependentSkill(args)).resolves.toMatchObject({ declaredQuestion: QUESTION });

    recorded.outputs.push(closingReply('   '));
    await expect(runDependentSkill(args)).resolves.toMatchObject({ declaredQuestion: null });
  });
});

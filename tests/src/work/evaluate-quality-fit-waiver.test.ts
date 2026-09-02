import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  evaluateCandidate,
  QUALITY_FIT_SKIP_PREFIX,
  type EvalContext,
  type EvaluateLookups,
} from '../../../src/work/evaluate';
import { qualityFit } from '../../../src/work/quality-fit';
import type { WorkCandidate } from '../../../src/work/types';

vi.mock('../../../src/work/quality-fit', () => ({
  qualityFit: vi.fn(async () => ({ pass: false, reason: 'the request is too thin' })),
}));

const NOW = Date.parse('2026-09-03T02:00:00.000Z');

const charter: Charter = {
  version: '0.0',
  source: 'day-1 manager 1:1',
  whyThisHire: 'Keep revenue operations hand-offs moving.',
  proposedFunction: 'Revenue operations triage and follow-through',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: {
    willDo: ['Triage revenue operations requests and update delivery records.'],
    willNotDo: [],
    escalationTriggers: [],
  },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: new Date(NOW).toISOString(),
};

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'REVOPS-1',
  title: 'Refresh the revenue operations delivery record',
  contentSummary: '',
  contentRefs: [],
  observedAt: new Date(NOW - 1_000),
  priority: 'P2',
  requesterLabel: 'Manager',
};

function context(qualityFitWaived?: boolean): EvalContext {
  return {
    agentId: 'agent-test' as EvalContext['agentId'],
    charter,
    agentsMd: '## Good-habits memory\n- Ask for the affected record before routing.',
    bossLabel: 'Manager',
    autonomousActions: false,
    surfaceMode: 'mock',
    surfaces: [],
    now: NOW,
    ...(qualityFitWaived === undefined ? {} : { qualityFitWaived }),
  };
}

const lookups: EvaluateLookups = {
  hasGrantForScope: async (): Promise<boolean> => true,
  findExistingClaim: async (): Promise<null> => null,
  countOpenClaims: async (): Promise<number> => 0,
  findMatchingSkill: async (): Promise<{ name: string; description: string }> => ({
    name: 'linear-triage',
    description: 'Triage Linear work.',
  }),
};

describe('the quality-fit filter and the manager waiver', (): void => {
  beforeEach((): void => {
    vi.mocked(qualityFit).mockClear();
  });

  it('skips a candidate the filter refuses, naming the filter in the reason', async (): Promise<void> => {
    const verdict = await evaluateCandidate(candidate, context(), lookups);

    expect(verdict).toEqual({
      decision: 'skip',
      reason: `${QUALITY_FIT_SKIP_PREFIX}the request is too thin`,
    });
    expect(qualityFit).toHaveBeenCalledTimes(1);
  });

  it('leaves the filter out once the manager has waived it, and still needs a plan', async (): Promise<void> => {
    const verdict = await evaluateCandidate(candidate, context(true), lookups);

    expect(verdict.decision).toBe('claim');
    expect(qualityFit).not.toHaveBeenCalled();
  });
});

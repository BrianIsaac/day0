import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  evaluateCandidate,
  type EvalContext,
  type EvaluateLookups,
  type EvaluationSurface,
} from '../../../src/work/evaluate';
import { charterJudgementPrompt, judgeScope, type ScopeJudgement } from '../../../src/work/scope';
import type { WorkCandidate } from '../../../src/work/types';

const model = vi.hoisted(() => ({
  calls: [] as Array<{ agent: string; user: string }>,
  answer: { inScope: true, fit: true, reason: 'inside the role' } as
    | { inScope: boolean; fit: boolean; reason: string }
    | Error,
}));

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string }; user: string }): Promise<unknown> => {
    model.calls.push({ agent: args.agent.name, user: args.user });
    if (args.agent.name === 'day0-quality-fit') return { pass: false, reason: 'busywork' };
    if (model.answer instanceof Error) throw model.answer;
    return model.answer;
  },
}));

const NOW = Date.parse('2026-09-15T02:00:00.000Z');

/**
 * The charter and the card from the R6 investigation (section 2.5): the
 * approved onboarding-docs role, and the generated item whose own summary
 * explains that it is outside that role.
 */
const r6Charter: Charter = {
  version: '0.0',
  source: 'day-1 manager 1:1',
  whyThisHire:
    'Establish a reliable onboarding starting point by reviewing the mock onboarding docs and surfacing missing procedures or unclear ownership to the manager.',
  proposedFunction:
    'Review the mock onboarding docs, identify procedural and ownership gaps, and route unresolved questions to the manager before acting.',
  evidence: [],
  shortTermGoals: {
    day30: 'Review the mock onboarding docs and compile missing-procedure and unclear-ownership questions for the manager.',
    day60: 'Not yet defined; confirm the next priority, expected outputs, and success criteria with the manager.',
    day90: "Not yet defined; confirm the role's longer-term scope and ownership with the manager.",
  },
  proposedBoundaries: {
    willDo: [],
    willNotDo: [
      'Do not update the Q4 Revenue Tracker or any revenue record.',
      'Do not act on requests from Priya before the manager introduction.',
    ],
    escalationTriggers: [],
  },
  namedCollaborators: [{ name: 'Priya', topic: 'revenue operations', introPath: 'manager' }],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [{ who: 'RevOps analyst', staysOutOfTheirLaneBy: 'never editing revenue records' }],
  approvalChain: { boss: 'boss@day0.local', confidence: 'high' },
  openQuestions: [],
  createdAt: new Date(NOW).toISOString(),
};

const r6Card: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'ticket',
  externalId: 'ticket-revops-203-q4-revenue-update',
  title: 'Add Friday closed-won deals to revenue tracker',
  contentSummary:
    'Priya forwards, "Please update the Q4 Revenue Tracker with Friday\'s closed-won deals." This is outside the current charter, which is limited to reviewing onboarding docs and routing unclear ownership to the manager; it also would bypass the planned manager introduction to Priya.',
  contentRefs: [],
  observedAt: new Date(NOW - 1_000),
  priority: 'low',
  requesterLabel: 'Priya',
};

const ticketQueue: EvaluationSurface = {
  slug: 'ticket',
  displayName: 'Ticket queue',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: NOW,
  discoveryEvidence: [
    {
      kind: 'documentation',
      sourceId: 'source-1',
      ref: 'systems/ticket.md',
      quote: '# Ticket queue',
      current: true,
      firstSeenAt: 1,
      lastSeenAt: 1,
    },
  ],
};

function context(
  surfaceMode: EvalContext['surfaceMode'],
  overrides: Partial<EvalContext> = {},
): EvalContext {
  return {
    agentId: 'agent-test' as EvalContext['agentId'],
    charter: r6Charter,
    agentsMd: '',
    bossLabel: 'boss@day0.local',
    autonomousActions: false,
    surfaceMode,
    surfaces: surfaceMode === 'real' ? [ticketQueue] : [],
    now: NOW,
    ...overrides,
  };
}

const noSkill: EvaluateLookups = {
  hasGrantForScope: async (): Promise<boolean> => true,
  findExistingClaim: async (): Promise<null> => null,
  countOpenClaims: async (): Promise<number> => 0,
  findMatchingSkill: async (): Promise<null> => null,
};

const GOOD_HABITS = '## Good-habits memory\n- Confirm the owner before touching a revenue record.';

describe('one scope judgement for the R6 card', (): void => {
  beforeEach((): void => {
    model.calls.length = 0;
    model.answer = { inScope: true, fit: true, reason: 'inside the role' };
  });

  it('writes one verdict and one description that agree, from the whole charter', async (): Promise<void> => {
    model.answer = {
      inScope: false,
      fit: true,
      reason:
        'Updating the Q4 Revenue Tracker is outside a role limited to reviewing onboarding docs and routing ownership questions to the manager.',
    };
    const judgements: ScopeJudgement[] = [];
    const findMatchingSkill = vi.fn(async (): Promise<null> => null);

    const verdict = await evaluateCandidate(
      r6Card,
      context('real'),
      { ...noSkill, findMatchingSkill },
      { onScopeJudgement: (judgement): void => void judgements.push(judgement) },
    );

    expect(verdict).toEqual({
      decision: 'skip',
      reason:
        'out-of-scope: Updating the Q4 Revenue Tracker is outside a role limited to reviewing onboarding docs and routing ownership questions to the manager.',
    });
    expect(judgements).toEqual([
      { admitted: false, basis: 'charter-judgement', reason: (verdict as { reason: string }).reason },
    ]);
    expect(findMatchingSkill).not.toHaveBeenCalled();
    expect(model.calls.map((call) => call.agent)).toEqual(['day0-scope-judgement']);
  });

  it('hands the model the boundaries, the adjacent roles and the request, and nothing about the lexical rule', (): void => {
    const prompt = charterJudgementPrompt({ candidate: r6Card, charter: r6Charter, agentsMd: '' });
    expect(prompt).toContain('willNotDo: Do not update the Q4 Revenue Tracker or any revenue record. | Do not act on requests from Priya before the manager introduction.');
    expect(prompt).toContain('adjacentRoles: RevOps analyst: never editing revenue records');
    expect(prompt).toContain('No good-habits memory yet: judge the boundaries only and answer fit: true.');
    expect(prompt).toContain('Title: Add Friday closed-won deals to revenue tracker');
    expect(prompt).not.toContain('overlap');
    expect(charterJudgementPrompt({ candidate: r6Card, charter: r6Charter, agentsMd: GOOD_HABITS })).toContain(
      '--- AGENTS.md (good-habits memory) ---\n## Good-habits memory',
    );
  });

  it('keeps the mock verdict the card had before, without a model call', async (): Promise<void> => {
    const verdict = await evaluateCandidate(r6Card, context('mock'), noSkill);

    expect(verdict).toMatchObject({
      decision: 'needs-skill',
      reason: 'no registered skill covers ticket comment-and-close on a kanban surface; agent will propose "kanban-comment-and-close"',
      suggestedSkillName: 'kanban-comment-and-close',
    });
    expect(model.calls).toEqual([]);
  });

  it('runs the quality-fit filter in mock mode exactly as before, as an input to the same judgement', async (): Promise<void> => {
    const judgements: ScopeJudgement[] = [];
    const verdict = await evaluateCandidate(
      r6Card,
      context('mock', { agentsMd: GOOD_HABITS }),
      noSkill,
      { onScopeJudgement: (judgement): void => void judgements.push(judgement) },
    );

    expect(verdict).toEqual({ decision: 'skip', reason: 'quality-fit-fail: busywork' });
    expect(judgements).toEqual([{ admitted: false, basis: 'quality-fit', reason: 'quality-fit-fail: busywork' }]);
    expect(model.calls.map((call) => call.agent)).toEqual(['day0-quality-fit']);
  });

  it('refuses without a model call when nothing ties the item to the charter', async (): Promise<void> => {
    const unrelated: WorkCandidate = {
      ...r6Card,
      title: 'Book the offsite venue',
      contentSummary: 'Reserve the venue and confirm the catering headcount.',
    };
    await expect(judgeScope(unrelated, context('real'), { provenance: false, namesDocumentedSystem: false })).resolves.toEqual({
      admitted: false,
      basis: 'no-overlap',
      reason: 'out-of-scope: no charter or current documented-system overlap',
    });
    expect(model.calls).toEqual([]);
  });

  it('admits the item on the lexical inputs alone when the model cannot be reached, and says so', async (): Promise<void> => {
    model.answer = new Error('model unavailable');
    const judgements: ScopeJudgement[] = [];

    const verdict = await evaluateCandidate(r6Card, context('real'), noSkill, {
      onScopeJudgement: (judgement): void => void judgements.push(judgement),
    });

    expect(verdict.decision).toBe('needs-skill');
    expect(judgements).toEqual([{ admitted: true, basis: 'provenance', failedOpen: 'model unavailable' }]);
  });

  it('counts the fit half only when a good-habits memory exists and the filter is not waived', async (): Promise<void> => {
    model.answer = { inScope: true, fit: false, reason: 'the role norm says confirm the owner first' };

    await expect(judgeScope(r6Card, context('real'), { provenance: true, namesDocumentedSystem: false })).resolves.toEqual({
      admitted: true,
      basis: 'charter-judgement',
    });
    await expect(
      judgeScope(r6Card, context('real', { agentsMd: GOOD_HABITS }), { provenance: true, namesDocumentedSystem: false }),
    ).resolves.toEqual({
      admitted: false,
      basis: 'quality-fit',
      reason: 'quality-fit-fail: the role norm says confirm the owner first',
    });
    await expect(
      judgeScope(r6Card, context('real', { agentsMd: GOOD_HABITS, qualityFitWaived: true }), {
        provenance: true,
        namesDocumentedSystem: false,
      }),
    ).resolves.toEqual({ admitted: true, basis: 'charter-judgement' });
  });

  it('honours the eligibility waiver: no call when nothing else is asked, and only the fit half when it is', async (): Promise<void> => {
    model.answer = { inScope: false, fit: false, reason: 'outside the role and against a norm' };

    await expect(
      judgeScope(r6Card, context('real', { scopeWaived: true }), { provenance: false, namesDocumentedSystem: false }),
    ).resolves.toEqual({ admitted: true, basis: 'waived' });
    expect(model.calls).toEqual([]);

    await expect(
      judgeScope(r6Card, context('real', { scopeWaived: true, agentsMd: GOOD_HABITS }), {
        provenance: false,
        namesDocumentedSystem: false,
      }),
    ).resolves.toEqual({
      admitted: false,
      basis: 'quality-fit',
      reason: 'quality-fit-fail: outside the role and against a norm',
    });
    model.answer = { inScope: false, fit: true, reason: 'outside the role' };
    await expect(
      judgeScope(r6Card, context('real', { scopeWaived: true, agentsMd: GOOD_HABITS }), {
        provenance: false,
        namesDocumentedSystem: false,
      }),
    ).resolves.toEqual({ admitted: true, basis: 'waived' });
  });

  it('names the lexical input that admitted the item where no model decides', async (): Promise<void> => {
    await expect(judgeScope(r6Card, context('mock'), { provenance: false, namesDocumentedSystem: false })).resolves.toEqual({
      admitted: true,
      basis: 'charter-overlap',
    });
    const titleOnly: WorkCandidate = { ...r6Card, contentSummary: '' };
    await expect(judgeScope(titleOnly, context('mock'), { provenance: false, namesDocumentedSystem: true })).resolves.toEqual({
      admitted: true,
      basis: 'documented-system',
    });
    expect(model.calls).toEqual([]);
  });
});

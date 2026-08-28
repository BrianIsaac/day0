import { describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  evaluateCandidate,
  missingConnectionSurface,
  type EvalContext,
  type EvaluateLookups,
  type EvaluationSurface,
} from '../../../src/work/evaluate';
import type { AgentContext, WorkCandidate } from '../../../src/work/types';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

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

/** Build an eligible work candidate for one provider. */
function candidate(
  sourceSystem = 'linear',
  contentSummary = 'Triage this revenue operations request.',
): WorkCandidate {
  return {
    sourceCategory: 'ticket-queue',
    sourceSystem,
    externalId: 'REVOPS-1',
    title: 'Triage the revenue operations delivery record',
    contentSummary,
    contentRefs: [],
    observedAt: new Date(NOW - 1_000),
    priority: 'P1',
    requesterLabel: 'Manager',
  };
}

/** Build one persisted surface liveness record. */
function surface(
  slug: string,
  verdict: EvaluationSurface['verdict'] = 'connected',
  overrides: Partial<EvaluationSurface> = {},
): EvaluationSurface {
  return {
    slug,
    displayName: slug === 'northstar-crm' ? 'Northstar CRM' : 'Linear',
    verdict,
    discoveryEvidence: [
      {
        kind: 'documentation',
        sourceId: 'source-1',
        ref: `systems/${slug}.md`,
        quote: `# ${slug}`,
        current: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ],
    credentialLanded: true,
    lastVerifiedAt: NOW,
    ...overrides,
  };
}

/** Build the pure evaluator context for one mode. */
function context(
  surfaceMode: EvalContext['surfaceMode'],
  surfaces: readonly EvaluationSurface[],
  autonomousActions = false,
): EvalContext {
  const base: AgentContext = {
    agentId: 'agent-test' as AgentContext['agentId'],
    charter,
    agentsMd: '',
    bossLabel: 'Manager',
  };
  return { ...base, autonomousActions, surfaceMode, surfaces, now: NOW };
}

/** Build successful non-surface evaluator lookups. */
function lookups(
  hasGrantForScope: EvaluateLookups['hasGrantForScope'] = async (): Promise<boolean> => true,
  openClaims = 0,
): EvaluateLookups {
  return {
    hasGrantForScope,
    findExistingClaim: async (): Promise<null> => null,
    countOpenClaims: async (): Promise<number> => openClaims,
    findMatchingSkill: async (): Promise<{ name: string; description: string }> => ({
      name: 'linear-triage',
      description: 'Triage Linear work.',
    }),
  };
}

describe('work surface enablement', (): void => {
  it('preserves mock behaviour when no persistent surfaces exist', async (): Promise<void> => {
    await expect(
      evaluateCandidate(candidate('ticket'), context('mock', []), lookups()),
    ).resolves.toMatchObject({
      decision: 'claim',
    });
  });

  it('allows a recently verified connected real surface', async (): Promise<void> => {
    await expect(
      evaluateCandidate(candidate(), context('real', [surface('linear')]), lookups()),
    ).resolves.toMatchObject({ decision: 'claim' });
  });

  it('defers the documented Northstar queue item at its absent surface instead of charter scope', async (): Promise<void> => {
    const work = candidate(
      'linear',
      'Inspect Northstar CRM for the owner of the synthetic Aster Works opportunity and add the owner to the issue.',
    );
    work.externalId = 'REVOPS-2';
    work.title = 'Reconcile Northstar CRM ownership';

    await expect(
      evaluateCandidate(
        work,
        context('real', [surface('linear'), surface('northstar-crm', 'absent')]),
        lookups(),
      ),
    ).resolves.toEqual({
      decision: 'defer',
      reason: 'awaiting-connection',
      missingSurface: 'northstar-crm',
    });
  });

  it('claims the documented Looker queue item when its browser surface is connected', async (): Promise<void> => {
    const work = candidate(
      'linear',
      'Inspect the synthetic Friday standup deals and refresh the Looker pipeline tile with the current coverage summary.',
    );
    work.externalId = 'REVOPS-3';
    work.title = 'Refresh the Looker pipeline tile';

    await expect(
      evaluateCandidate(
        work,
        context('real', [surface('linear'), surface('looker-pipeline-tile')]),
        lookups(),
      ),
    ).resolves.toMatchObject({ decision: 'claim' });
  });

  it('does not use retired documentation evidence to widen charter scope', async (): Promise<void> => {
    const work = candidate('linear', 'Inspect Northstar CRM ownership.');
    work.title = 'Reconcile Northstar CRM ownership';
    const retired = surface('northstar-crm', 'absent', {
      discoveryEvidence: [
        {
          kind: 'documentation',
          sourceId: 'source-1',
          ref: 'systems/northstar-crm.md',
          quote: '# Northstar CRM',
          current: false,
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
      ],
    });

    await expect(
      evaluateCandidate(work, context('real', [surface('linear'), retired]), lookups()),
    ).resolves.toEqual({
      decision: 'skip',
      reason: 'out-of-scope: no charter or current documented-system overlap',
    });
  });

  it.each([
    ['absent', surface('linear', 'absent')],
    [
      'ungranted',
      surface('linear', 'approved', { credentialLanded: false, lastVerifiedAt: undefined }),
    ],
    [
      'stale',
      surface('linear', 'connected', {
        lastVerifiedAt: NOW - 6 * 60 * 60 * 1_000 - 1,
      }),
    ],
  ])('defers a real candidate whose surface is %s', async (_label, row): Promise<void> => {
    await expect(
      evaluateCandidate(candidate(), context('real', [row]), lookups()),
    ).resolves.toEqual({
      decision: 'defer',
      reason: 'awaiting-connection',
      missingSurface: 'linear',
    });
  });

  it('defers a second disconnected system named by a connected provider item', (): void => {
    expect(
      missingConnectionSurface(
        candidate('linear', 'Use Northstar CRM to reconcile this revenue operations request.'),
        context('real', [surface('linear'), surface('northstar-crm', 'absent')]),
      ),
    ).toBe('northstar-crm');
  });

  it('defers an unknown real provider by its normalised source slug', (): void => {
    expect(missingConnectionSurface(candidate('Unknown Work Queue'), context('real', []))).toBe(
      'unknown-work-queue',
    );
  });

  it('does not require a surface for a boss request without another system target', async (): Promise<void> => {
    await expect(
      evaluateCandidate(candidate('boss'), context('real', []), lookups()),
    ).resolves.toMatchObject({ decision: 'claim' });
  });

  it('checks connection before reading grants', async (): Promise<void> => {
    const hasGrant = vi.fn(async (): Promise<boolean> => true);
    await expect(
      evaluateCandidate(
        candidate(),
        context('real', [surface('linear', 'absent')]),
        lookups(hasGrant),
      ),
    ).resolves.toMatchObject({ decision: 'defer', reason: 'awaiting-connection' });
    expect(hasGrant).not.toHaveBeenCalled();
  });
});

describe('work concurrency posture', (): void => {
  it('queues the second open item while autonomous actions are off', async (): Promise<void> => {
    await expect(
      evaluateCandidate(candidate(), context('mock', [], false), lookups(undefined, 1)),
    ).resolves.toEqual({
      decision: 'queue',
      reason: 'WIP cap reached: supervised cold-start limit is 1',
      openClaims: 1,
    });
  });

  it('allows three open items while autonomous actions are on, then queues the fourth', async (): Promise<void> => {
    await expect(
      evaluateCandidate(candidate(), context('mock', [], true), lookups(undefined, 2)),
    ).resolves.toMatchObject({ decision: 'claim' });
    await expect(
      evaluateCandidate(candidate(), context('mock', [], true), lookups(undefined, 3)),
    ).resolves.toEqual({
      decision: 'queue',
      reason: 'WIP cap reached: autonomous concurrency limit is 3',
      openClaims: 3,
    });
  });
});

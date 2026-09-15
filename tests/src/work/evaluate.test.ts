import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import {
  evaluateCandidate,
  missingConnectionSurface,
  type EvalContext,
  type EvaluateLookups,
  type EvaluationSurface,
} from '../../../src/work/evaluate';
import type { AgentContext, WorkCandidate } from '../../../src/work/types';

const model = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string } }): Promise<unknown> => {
    model.calls.push(args.agent.name);
    return { inScope: true, fit: true, reason: 'inside the role' };
  },
}));

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
    class: slug === 'northstar-crm' ? 'crm' : 'kanban',
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
  beforeEach((): void => {
    model.calls.length = 0;
  });

  it('asks the charter judgement once for a real-mode candidate and never in mock mode', async (): Promise<void> => {
    await expect(
      evaluateCandidate(candidate('ticket'), context('mock', []), lookups()),
    ).resolves.toMatchObject({ decision: 'claim' });
    expect(model.calls).toEqual([]);
    await expect(
      evaluateCandidate(candidate(), context('real', [surface('linear')]), lookups()),
    ).resolves.toMatchObject({ decision: 'claim' });
    expect(model.calls).toEqual(['day0-scope-judgement']);
  });

  it('reports a missing skill without asserting in-scope', async (): Promise<void> => {
    const verdict = await evaluateCandidate(candidate('ticket'), context('mock', []), {
      ...lookups(),
      findMatchingSkill: async (): Promise<null> => null,
    });

    expect(verdict.decision).toBe('needs-skill');
    if (verdict.decision !== 'needs-skill') throw new Error('Expected needs-skill verdict');
    expect(verdict.reason).not.toContain('in-scope');
    expect(verdict.reason).toBe(
      `no registered skill covers ticket comment-and-close on a kanban surface; agent will propose "${verdict.suggestedSkillName}"`,
    );
  });

  it('proposes a skill named after the surface class and operation, not the work item', async (): Promise<void> => {
    const ticket = candidate('ticket');
    const verdict = await evaluateCandidate(ticket, context('mock', []), {
      ...lookups(),
      findMatchingSkill: async (): Promise<null> => null,
    });

    if (verdict.decision !== 'needs-skill') throw new Error('Expected needs-skill verdict');
    expect(verdict.suggestedSkillName).toBe('kanban-comment-and-close');
    expect(verdict.suggestedSkillShape).toEqual({
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
    });
    expect(verdict.suggestedSkillName).not.toContain(ticket.externalId.toLowerCase());
    expect(verdict.suggestedSkillRationale).toContain('ticket comment-and-close on a kanban surface');
    expect(verdict.suggestedSkillRationale).toContain(`"${ticket.title}"`);
    expect(verdict.suggestedSkillRationale).not.toContain(charter.proposedFunction);
    expect(verdict.suggestedSkillRationale).not.toContain('Charter');
  });

  it('hands the shape to the skill lookup so matching and naming agree', async (): Promise<void> => {
    const seen: unknown[] = [];
    await evaluateCandidate(candidate('slack'), context('mock', []), {
      ...lookups(),
      findMatchingSkill: async (_candidate, _charter, shape): Promise<null> => {
        seen.push(shape);
        return null;
      },
    });
    expect(seen).toEqual([{ surfaceClass: 'chat', operation: 'thread-reply' }]);
  });

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

  it('does not defer the live Looker item on a rejected charter alias', async (): Promise<void> => {
    const work = candidate('linear', '');
    work.externalId = 'REVOPS-7';
    work.title = 'Refresh the Looker pipeline tile';
    const charterAlias = surface('looker', 'declared', {
      displayName: 'Looker',
      class: 'analytics',
      credentialLanded: false,
      lastVerifiedAt: undefined,
      discoveryEvidence: [
        {
          kind: 'charter',
          ref: 'manager 1:1',
          quote: 'Pipeline numbers are on the Looker tile, web UI only.',
          current: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
    });
    const documentedTile = surface('looker-pipeline-tile', 'connected', {
      displayName: 'Looker pipeline tile',
      class: 'analytics',
      endpoint: 'http://looker-tile:8080/',
    });

    await expect(
      evaluateCandidate(
        work,
        context('real', [surface('linear'), charterAlias, documentedTile]),
        lookups(),
      ),
    ).resolves.toMatchObject({ decision: 'claim' });
  });

  it('defers on a pending qualified product beside the connected tile', (): void => {
    const work = candidate('linear', '');
    work.title = 'Copy the Looker pipeline tile figure into the Looker Studio report';
    const documentedTile = surface('looker-pipeline-tile', 'connected', {
      displayName: 'Looker pipeline tile',
      class: 'analytics',
      endpoint: 'http://looker-tile:8080/',
    });
    const studio = surface('looker-studio', 'declared', {
      displayName: 'Looker Studio',
      class: 'analytics',
      credentialLanded: false,
      lastVerifiedAt: undefined,
      discoveryEvidence: [
        {
          kind: 'charter',
          ref: 'manager 1:1',
          quote: 'The board deck charts are built in Looker Studio.',
          current: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
    });

    expect(
      missingConnectionSurface(work, context('real', [surface('linear'), documentedTile, studio])),
    ).toBe('looker-studio');
  });

  it('ignores a rejected alias covered by a connected surface the item does not name', (): void => {
    const work = candidate('linear', '');
    work.title = 'Update the Looker number';
    const charterAlias = surface('looker', 'declared', {
      displayName: 'Looker',
      class: 'analytics',
      credentialLanded: false,
      lastVerifiedAt: undefined,
      discoveryEvidence: [
        {
          kind: 'charter',
          ref: 'manager 1:1',
          quote: 'Pipeline numbers are on the Looker tile, web UI only.',
          current: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
    });
    const documentedTile = surface('looker-pipeline-tile', 'connected', {
      displayName: 'Looker pipeline tile',
      class: 'analytics',
      endpoint: 'http://looker-tile:8080/',
    });

    expect(
      missingConnectionSurface(
        work,
        context('real', [surface('linear'), charterAlias, documentedTile]),
      ),
    ).toBeUndefined();
  });

  it('still defers a distinct same-class surface named by the item', (): void => {
    const work = candidate('linear', 'Move the confirmed issue into Jira.');
    work.title = 'Copy the Linear issue into Jira';
    expect(
      missingConnectionSurface(
        work,
        context('real', [
          surface('linear'),
          surface('jira', 'declared', {
            displayName: 'Jira',
            class: 'kanban',
            credentialLanded: false,
            lastVerifiedAt: undefined,
          }),
        ]),
      ),
    ).toBe('jira');
  });

  describe('eligibility by provenance', (): void => {
    /** The audit-note ticket as intake reads it: no word in common with the charter, no surface named. */
    const auditNote = (): WorkCandidate => {
      const work = candidate(
        'linear',
        'Add a comment summarising the completed close checks, then move it to Done after manager approval.',
      );
      work.title = 'Add the close-summary audit note';
      return work;
    };

    it('takes a ticket from a connected, currently named surface without charter overlap', async (): Promise<void> => {
      await expect(
        evaluateCandidate(auditNote(), context('real', [surface('linear')]), lookups()),
      ).resolves.toMatchObject({ decision: 'claim' });
    });

    it('still runs the connection and permission checks after provenance', async (): Promise<void> => {
      await expect(
        evaluateCandidate(
          auditNote(),
          context('real', [surface('linear')]),
          lookups(async (scope: string): Promise<boolean> => scope !== 'linear:read'),
        ),
      ).resolves.toEqual({
        decision: 'defer',
        reason: 'awaiting-permission',
        missingPermissions: ['linear:read'],
      });
    });

    it('skips the same ticket as out of scope when its surface is absent', async (): Promise<void> => {
      await expect(
        evaluateCandidate(auditNote(), context('real', [surface('linear', 'absent')]), lookups()),
      ).resolves.toEqual({
        decision: 'skip',
        reason: 'out-of-scope: no charter or current documented-system overlap',
      });
    });

    it('skips the same ticket when the connected surface has no current discovery evidence', async (): Promise<void> => {
      const unnamed = surface('linear', 'connected', {
        discoveryEvidence: [
          {
            kind: 'documentation',
            sourceId: 'source-1',
            ref: 'systems/linear.md',
            quote: '# linear',
            current: false,
            firstSeenAt: 1,
            lastSeenAt: 2,
          },
        ],
      });
      await expect(
        evaluateCandidate(auditNote(), context('real', [unnamed]), lookups()),
      ).resolves.toEqual({
        decision: 'skip',
        reason: 'out-of-scope: no charter or current documented-system overlap',
      });
      await expect(
        evaluateCandidate(
          auditNote(),
          context('real', [surface('linear', 'connected', { discoveryEvidence: undefined })]),
          lookups(),
        ),
      ).resolves.toMatchObject({ decision: 'skip' });
    });

    it('never fires in mock mode, whatever the surfaces table holds', async (): Promise<void> => {
      const work = auditNote();
      work.sourceSystem = 'ticket';
      await expect(
        evaluateCandidate(
          work,
          context('mock', [
            surface('ticket', 'connected', { displayName: 'Ticket queue', class: 'kanban' }),
          ]),
          lookups(),
        ),
      ).resolves.toEqual({
        decision: 'skip',
        reason: 'out-of-scope: no charter or current documented-system overlap',
      });
      await expect(
        evaluateCandidate(work, context('mock', []), lookups()),
      ).resolves.toMatchObject({ decision: 'skip' });
    });
  });

  it('leaves the eligibility rule out once the manager has waived it, in either mode', async (): Promise<void> => {
    const work = candidate('ticket', 'Reserve the venue and confirm the catering headcount.');
    work.title = 'Book the offsite venue';
    await expect(
      evaluateCandidate(work, context('mock', []), lookups()),
    ).resolves.toEqual({
      decision: 'skip',
      reason: 'out-of-scope: no charter or current documented-system overlap',
    });
    await expect(
      evaluateCandidate(work, { ...context('mock', []), eligibilityWaived: true }, lookups()),
    ).resolves.toMatchObject({ decision: 'claim' });
    work.sourceSystem = 'linear';
    await expect(
      evaluateCandidate(
        work,
        { ...context('real', [surface('linear', 'absent')]), eligibilityWaived: true },
        lookups(),
      ),
    ).resolves.toEqual({ decision: 'defer', reason: 'awaiting-connection', missingSurface: 'linear' });
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

    // The source surface is connected but nothing current names it, so the
    // item's provenance does not carry it either: the retired evidence alone
    // must not.
    const unnamedLinear = surface('linear', 'connected', { discoveryEvidence: [] });
    await expect(
      evaluateCandidate(work, context('real', [unnamedLinear, retired]), lookups()),
    ).resolves.toEqual({
      decision: 'skip',
      reason: 'out-of-scope: no charter or current documented-system overlap',
    });
    // From a connected, currently named Linear the same item is in scope by
    // provenance and stops at the Northstar connection gate instead.
    await expect(
      evaluateCandidate(work, context('real', [surface('linear'), retired]), lookups()),
    ).resolves.toEqual({
      decision: 'defer',
      reason: 'awaiting-connection',
      missingSurface: 'northstar-crm',
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

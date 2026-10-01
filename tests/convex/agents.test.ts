import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as agentsModule from '../../convex/agents';
import { clipRoleLine } from '../../convex/agents';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { autonomousActionsOn } from '../../src/work/autonomy';
import { evaluateCandidate, type EvalContext } from '../../src/work/evaluate';
import { INTERRUPTED_APPLY_REASON } from '../../src/work/reconciliation';
import { STOPPED_PREFIX } from '../../src/work/stop';
import type { WorkCandidate } from '../../src/work/types';
import { asAgentId } from '../../src/lib/ids';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';
import { runtimeCycleThrough } from '../fixtures/import-graph';
import { MAX_FINALISATION_RECOVERIES } from '../../src/agent/one-to-one-phase';
import { UNVERIFIED_FOR_DEPLOY } from '../../src/agent/manager-address';
import {
  EVALUATION_ADDRESS_FIXED,
  UNVERIFIED_FOR_ADOPTION,
} from '../../src/agent/manager-standing';
import { MANAGER_CHANGED_RESEND_REASON } from '../../convex/work';
import { MANAGER_ADDRESS, localIssuerIdentity, managerIdentity } from './fakes/manager-identity';

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

/**
 * Insert one synced owner-level source.
 *
 * Args:
 *   harness: Convex test harness.
 *   userId: Owner subject.
 *   label: Source label.
 *
 * Returns:
 *   The new source id.
 */
async function seedSource(
  harness: TestConvex<typeof schema>,
  userId: string,
  label: string,
): Promise<Id<'docSources'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('docSources', {
        userId,
        label,
        kind: 'folder',
        locator: label.toLowerCase(),
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      }),
  );
}

describe('agent documentation selection', (): void => {
  it('refuses to exclude a source owned by another caller', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'other-owner', 'Private docs');
    const owner = harness.withIdentity(managerIdentity());
    await expect(
      owner.mutation(api.agents.deploy, {
        name: 'foreign source test',
        excludedDocSourceIds: [sourceId],
      }),
    ).rejects.toThrow('owned by another user');
  });

  it('persists an owned exclusion and drops an empty one', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner', 'Team docs');
    const owner = harness.withIdentity(managerIdentity());
    const excluding = await owner.mutation(api.agents.deploy, {
      name: 'excluding',
      excludedDocSourceIds: [sourceId],
    });
    await expect(owner.query(api.agents.get, { agentId: excluding })).resolves.toMatchObject({
      excludedDocSourceIds: [sourceId],
    });
    const inheriting = await owner.mutation(api.agents.deploy, {
      name: 'inheriting',
      excludedDocSourceIds: [],
    });
    const row = await owner.query(api.agents.get, { agentId: inheriting });
    expect(row?.excludedDocSourceIds).toBeUndefined();
  });

  it('inherits a source linked after deploy unless it was excluded', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const existing = await seedSource(harness, 'owner', 'Existing');
    const excluded = await seedSource(harness, 'owner', 'Excluded');
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {
      name: 'inheritance test',
      excludedDocSourceIds: [excluded],
    });
    const later = await seedSource(harness, 'owner', 'Later');
    const readers = async (sourceId: Id<'docSources'>): Promise<Id<'agents'>[]> =>
      (await harness.query(internal.docSources.agentsForSource, { sourceId })).map(
        (agent): Id<'agents'> => agent._id,
      );
    await expect(readers(existing)).resolves.toEqual([agentId]);
    await expect(readers(later)).resolves.toEqual([agentId]);
    await expect(readers(excluded)).resolves.toEqual([]);
  });
});

describe('evaluation arm', (): void => {
  it('deploys product agents as day0 and persists an explicit baseline arm', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());

    const day0Id = await owner.mutation(api.agents.deploy, {});
    const baselineId = await owner.mutation(api.agents.deploy, {
      arm: 'baseline',
    });

    await expect(owner.query(api.agents.get, { agentId: day0Id })).resolves.toMatchObject({
      arm: 'day0',
    });
    await expect(owner.query(api.agents.get, { agentId: baselineId })).resolves.toMatchObject({
      arm: 'baseline',
    });
  });
});

describe("agents.deploy and the manager's verified address", (): void => {
  /** The refusal a deploy met, as the client reads it, or the stored row's address and event. */
  async function deployAs(
    harness: TestConvex<typeof schema>,
    who: ReturnType<typeof managerIdentity>,
  ): Promise<string | { bossEmail: string | undefined; event: unknown }> {
    const outcome = await harness
      .withIdentity(who)
      .mutation(api.agents.deploy, { name: 'Maya' })
      .then(
        (agentId): { agentId: Id<'agents'> } => ({ agentId }),
        (error: unknown): { error: unknown } => ({ error }),
      );
    if ('error' in outcome) {
      const { error } = outcome;
      if (error instanceof ConvexError) return `refused: ${String(error.data)}`;
      return `crashed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const { agentId } = outcome;
    return await harness.run(async (ctx) => ({
      bossEmail: (await ctx.db.get(agentId))?.bossEmail,
      event: (
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) => q.eq('agentId', agentId).eq('type', 'agent.deployed'))
          .first()
      )?.payload,
    }));
  }

  it('deploy refuses a caller without a verified address and stores the verified one', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    await expect(
      deployAs(harness, managerIdentity('owner', { emailVerified: false })),
    ).resolves.toBe(`refused: ${UNVERIFIED_FOR_DEPLOY}`);
    await expect(deployAs(harness, managerIdentity('owner', { email: undefined }))).resolves.toBe(
      `refused: ${UNVERIFIED_FOR_DEPLOY}`,
    );
    await expect(
      harness.run(async (ctx) => await ctx.db.query('agents').collect()),
    ).resolves.toEqual([]);

    const stored = await deployAs(
      harness,
      managerIdentity('owner', { email: ' Lead@Day0.local ' }),
    );
    expect(stored).toMatchObject({
      bossEmail: 'lead@day0.local',
      event: { bossEmail: 'lead@day0.local' },
    });
  });

  it('stores the address of a local token as the backend hands it over, its verification raw', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const local = harness.withIdentity(localIssuerIdentity('Ops@Kestrel.example'));
    await expect(local.query(api.agents.myManagerAddress, {})).resolves.toBe('ops@kestrel.example');
    const agentId = await local.mutation(api.agents.deploy, { name: 'Maya' });
    await expect(local.query(api.agents.get, { agentId })).resolves.toMatchObject({
      bossEmail: 'ops@kestrel.example',
      userId: 'dev-no-auth|local-boss',
    });
  });

  it("no longer takes the browser's word for the address", async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness.withIdentity(managerIdentity()).mutation(api.agents.deploy, {
        bossEmail: 'someone-else@day0.local',
      } as never),
    ).rejects.toThrow(/bossEmail/);
  });

  it('evaluationAddress is refused off a bed and for a non-evaluation shape', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const trial = {
      evaluationAddress: 'eval-day0-r1-1758150000000@day0.local',
      name: 'Day0 evaluation 1',
    };
    vi.stubEnv('DAY0_EVALUATION_BED', '');
    await expect(owner.mutation(api.agents.deploy, trial)).rejects.toThrow('DAY0_EVALUATION_BED');

    vi.stubEnv('DAY0_EVALUATION_BED', 'w9u1');
    for (const refused of [
      { ...trial, evaluationAddress: 'lead@day0.local' },
      { ...trial, evaluationAddress: 'eval-team@company.com' },
      // Shaped like an evaluation address, but the row would not read as an evaluation employee.
      { ...trial, name: 'worker 1' },
    ]) {
      await expect(owner.mutation(api.agents.deploy, refused), refused.name).rejects.toThrow(
        'evaluation address',
      );
    }
    await expect(
      harness.run(async (ctx) => await ctx.db.query('agents').collect()),
    ).resolves.toEqual([]);
  });

  it("stores an evaluation address on a bed as the employee's evaluation marker, still from a verified caller", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.stubEnv('DAY0_EVALUATION_BED', 'w9u1');
    const harness = convexTest(schema, allConvexModules());
    const trial = {
      evaluationAddress: 'EVAL-revocation-20260918t090000@day0.local',
      name: 'Day0 revocation evaluation',
    };
    await expect(
      harness
        .withIdentity(managerIdentity('owner', { emailVerified: false }))
        .mutation(api.agents.deploy, trial),
    ).rejects.toThrow(UNVERIFIED_FOR_DEPLOY);
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, trial);
    const baselineId = await owner.mutation(api.agents.deploy, {
      evaluationAddress: 'eval-baseline-r1-1758150000000@day0.local',
      name: 'Ordinary agent evaluation 1',
      arm: 'baseline',
    });
    const rows = await harness.run(async (ctx) => await ctx.db.query('agents').collect());
    expect(rows.map((row) => [row._id, row.bossEmail])).toEqual([
      [agentId, 'eval-revocation-20260918t090000@day0.local'],
      [baselineId, 'eval-baseline-r1-1758150000000@day0.local'],
    ]);
    await expect(owner.query(api.agents.rosterForUser, {})).resolves.toEqual([]);
  });
});

describe('agents.myManagerAddress', (): void => {
  it("answers the caller's verified address, the one a deploy would store", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness
        .withIdentity(managerIdentity('owner', { email: 'Lead@Day0.local' }))
        .query(api.agents.myManagerAddress, {}),
    ).resolves.toBe('lead@day0.local');
  });

  it('answers null for a caller with no verified address and for an anonymous one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness
        .withIdentity(managerIdentity('owner', { emailVerified: false }))
        .query(api.agents.myManagerAddress, {}),
    ).resolves.toBeNull();
    await expect(harness.query(api.agents.myManagerAddress, {})).resolves.toBeNull();
  });

  it('is the address the shared fixture identity carries', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness.withIdentity(managerIdentity()).query(api.agents.myManagerAddress, {}),
    ).resolves.toBe(MANAGER_ADDRESS);
  });
});

describe('agent surface grants', (): void => {
  it('lets a slot-2 Slack action candidate reach needs-skill under deployed mock grants', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity('mock-owner'));
    const agentId = await owner.mutation(api.agents.deploy, {});
    const grants = await owner.query(api.agents.permissionScopes, { agentId });
    const candidate: WorkCandidate = {
      sourceCategory: 'inbox',
      sourceSystem: 'slack',
      externalId: 'slack-revenue-handoff',
      title: 'Post the revenue operations handoff summary to the team channel',
      contentSummary: 'Manager asks: "Draft a revenue operations handoff message for #revops."',
      contentRefs: ['channel://revops'],
      observedAt: new Date(),
      priority: 'P1',
      requesterLabel: 'Manager',
    };
    const context: EvalContext = {
      agentId: asAgentId(agentId),
      charter: {
        version: '0.0',
        source: 'day-1 manager 1:1',
        whyThisHire: 'Keep revenue operations handoffs moving.',
        proposedFunction: 'Revenue operations triage and follow-through',
        evidence: [],
        shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
        proposedBoundaries: {
          willDo: ['Draft revenue operations handoff messages.'],
          willNotDo: [],
          escalationTriggers: [],
        },
        namedCollaborators: [],
        namedSystems: [],
        priorityReading: [],
        adjacentRoles: [],
        approvalChain: { boss: 'Manager', confidence: 'high' },
        openQuestions: [],
        createdAt: new Date().toISOString(),
      },
      agentsMd: '',
      bossLabel: 'Manager',
      autonomousActions: false,
      surfaceMode: 'mock',
      surfaces: [],
    };

    const verdict = await evaluateCandidate(candidate, context, {
      hasGrantForScope: async (scope) =>
        grants.some((grant) => grant.scope === scope && grant.active),
      findExistingClaim: async () => null,
      countOpenClaims: async () => 0,
      findMatchingSkill: async () => null,
    });

    expect(verdict).toMatchObject({ decision: 'needs-skill' });
  });

  it('refuses the baseline arm outside mock mode', async (): Promise<void> => {
    useSurfaceMode('real');
    const { api: realApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    await expect(owner.mutation(realApi.agents.deploy, { arm: 'baseline' })).rejects.toThrow(
      'mock mode',
    );
    await expect(owner.mutation(realApi.agents.deploy, { arm: 'day0' })).resolves.toBeTruthy();
    const agents = await harness.run(async (ctx) => await ctx.db.query('agents').collect());
    expect(agents.map((agent) => agent.arm)).toEqual(['day0']);
  });

  it('seeds provider grants in mock mode but only baseline grants in real mode', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('mock');
    const mockHarness = convexTest(schema, allConvexModules());
    const mockAgent = await mockHarness
      .withIdentity(managerIdentity('mock-owner'))
      .mutation(api.agents.deploy, {});
    const mockScopes = await mockHarness.run(
      async (ctx): Promise<string[]> =>
        (
          await ctx.db
            .query('permissionGrants')
            .withIndex('by_agent_scope', (index) => index.eq('agentId', mockAgent))
            .collect()
        )
          .map((grant): string => grant.scope)
          .sort(),
    );
    expect(mockScopes).toEqual([
      'boss:message',
      'docs:read',
      'slack:read',
      'social:read',
      'spreadsheet:read',
      'ticket:read',
    ]);
    const mockGrantEvents = await mockHarness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'permission.granted',
      ),
    );
    expect(mockGrantEvents.map((event) => event.payload)).toEqual(
      expect.arrayContaining(mockScopes.map((scope) => ({ scope, source: 'deploy' }))),
    );

    useSurfaceMode('real');
    const realHarness = convexTest(schema, allConvexModules());
    const realAgent = await realHarness
      .withIdentity(managerIdentity('real-owner'))
      .mutation(api.agents.deploy, {});
    const realScopes = await realHarness.run(
      async (ctx): Promise<string[]> =>
        (
          await ctx.db
            .query('permissionGrants')
            .withIndex('by_agent_scope', (index) => index.eq('agentId', realAgent))
            .collect()
        )
          .map((grant): string => grant.scope)
          .sort(),
    );
    expect(realScopes).toEqual(['boss:message', 'docs:read']);
    // Autonomous actions are off from deployment: the field is absent, which reads as off.
    const realRow = await realHarness.run(async (ctx) => await ctx.db.get(realAgent));
    expect(realRow?.autonomousActions).toBeUndefined();
    expect(autonomousActionsOn(realRow ?? {})).toBe(false);
  });

  it('grants an active scope idempotently and replaces a revoked grant', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'grant test',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('permissionGrants', {
        agentId,
        scope: 'linear:read',
        createdAt: 1,
        revokedAt: 2,
      });
    });
    await expect(
      harness.mutation(internal.agents.grantScope, {
        agentId,
        scope: 'linear:read',
        source: 'surface',
      }),
    ).resolves.toEqual({ added: true });
    await expect(
      harness.mutation(internal.agents.grantScope, {
        agentId,
        scope: 'linear:read',
        source: 'surface',
      }),
    ).resolves.toEqual({ added: false });
    const grants = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (index) =>
            index.eq('agentId', agentId).eq('scope', 'linear:read'),
          )
          .collect(),
    );
    expect(grants).toHaveLength(2);
    expect(grants.filter((grant): boolean => grant.revokedAt === undefined)).toHaveLength(1);
    expect(grants.find((grant) => grant.revokedAt === undefined)?.source).toBe('surface');
    expect(
      (await harness.run(async (ctx) => await ctx.db.query('events').collect())).map(
        (event) => event.payload,
      ),
    ).toContainEqual({ scope: 'linear:read', source: 'surface' });
  });

  it('revokes every active copy, emits one edge, and re-grants as a new row', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'grant test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('permissionGrants', {
        agentId: id,
        scope: 'linear:read',
        source: 'surface',
        createdAt: 1,
      });
      await ctx.db.insert('permissionGrants', {
        agentId: id,
        scope: 'linear:read',
        source: 'skill',
        createdAt: 2,
      });
      return id;
    });
    await expect(
      harness.withIdentity(managerIdentity('intruder')).mutation(api.agents.revokeScope, {
        agentId,
        scope: 'linear:read',
      }),
    ).rejects.toThrow('forbidden');
    const owner = harness.withIdentity(managerIdentity());
    await expect(
      owner.mutation(api.agents.revokeScope, {
        agentId,
        scope: 'linear:read',
        reason: '  Trial containment.  ',
      }),
    ).resolves.toEqual({ revoked: 2 });
    await expect(
      owner.mutation(api.agents.revokeScope, { agentId, scope: 'linear:read' }),
    ).resolves.toEqual({ revoked: 0 });
    expect(await owner.query(api.agents.permissionScopes, { agentId })).toEqual([
      {
        scope: 'linear:read',
        active: false,
        source: 'skill',
        grantedAt: 2,
        revokedAt: Date.parse('2026-08-30T12:00:00.000Z'),
      },
    ]);
    await expect(
      owner.mutation(api.agents.grantScopes, { agentId, scopes: ['linear:read'] }),
    ).resolves.toEqual({ added: 1 });
    await expect(
      owner.mutation(api.agents.grantScopes, { agentId, scopes: ['linear:read'] }),
    ).resolves.toEqual({ added: 0 });
    const grants = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId).eq('scope', 'linear:read'))
          .collect(),
    );
    expect(grants).toHaveLength(3);
    expect(grants.filter((grant) => grant.revokedAt === undefined)).toMatchObject([
      { source: 'manager' },
    ]);
    const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      [
        'permission.revoked',
        {
          scope: 'linear:read',
          by: 'manager',
          reason: 'Trial containment.',
        },
      ],
      ['permission.granted', { scope: 'linear:read', source: 'manager' }],
    ]);
  });
});

describe('revocation under adversarial use', (): void => {
  it('cannot reach a scope another agent holds, even for the same owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [mine, other] = await harness.run(async (ctx): Promise<[Id<'agents'>, Id<'agents'>]> => {
      const a = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'mine',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const b = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'other',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('permissionGrants', {
        agentId: b,
        scope: 'linear:read',
        source: 'manager',
        createdAt: 1,
      });
      return [a, b];
    });
    const owner = harness.withIdentity(managerIdentity());
    await expect(
      owner.mutation(api.agents.revokeScope, { agentId: mine, scope: 'linear:read' }),
    ).resolves.toEqual({ revoked: 0 });
    const grants = await harness.run(
      async (ctx) => await ctx.db.query('permissionGrants').collect(),
    );
    expect(grants).toMatchObject([{ agentId: other, scope: 'linear:read' }]);
    expect(grants[0]!.revokedAt).toBeUndefined();
    const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events).toEqual([]);
  });

  it('re-granted and revoked in the same tick still reads as revoked with its history intact', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'same tick',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('permissionGrants', {
        agentId: id,
        scope: 'slack:read',
        source: 'surface',
        createdAt: 1,
        revokedAt: 2,
      });
      return id;
    });
    const owner = harness.withIdentity(managerIdentity());
    await expect(
      owner.mutation(api.agents.grantScopes, { agentId, scopes: ['slack:read'] }),
    ).resolves.toEqual({ added: 1 });
    await expect(
      owner.mutation(api.agents.revokeScope, { agentId, scope: 'slack:read' }),
    ).resolves.toEqual({ revoked: 1 });
    const scopes = await owner.query(api.agents.permissionScopes, { agentId });
    expect(scopes).toEqual([
      {
        scope: 'slack:read',
        active: false,
        source: 'manager',
        grantedAt: Date.parse('2026-08-30T12:00:00.000Z'),
        revokedAt: Date.parse('2026-08-30T12:00:00.000Z'),
      },
    ]);
    const grants = await harness.run(
      async (ctx) => await ctx.db.query('permissionGrants').collect(),
    );
    expect(grants).toHaveLength(2);
    expect(grants.every((grant) => grant.revokedAt !== undefined)).toBe(true);
  });
});

describe('the autonomous-actions switch', (): void => {
  it('lets the owner turn it on and off with an event per change, and refuses a stranger', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).rejects.toThrow('forbidden');
    await expect(
      harness.mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).rejects.toThrow('not authenticated');
    const owner = harness.withIdentity(managerIdentity());
    // Off is what an absent field already is, so setting it records nothing.
    await expect(
      owner.mutation(api.agents.setAutonomousActions, { agentId, on: false }),
    ).resolves.toEqual({
      ok: true,
      autonomousActions: false,
      changed: false,
    });
    await expect(
      owner.mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).resolves.toEqual({
      ok: true,
      autonomousActions: true,
      changed: true,
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(agentId)))?.autonomousActions).toBe(
      true,
    );
    await expect(
      owner.mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).resolves.toEqual({
      ok: true,
      autonomousActions: true,
      changed: false,
    });
    await expect(
      owner.mutation(api.agents.setAutonomousActions, { agentId, on: false }),
    ).resolves.toEqual({
      ok: true,
      autonomousActions: false,
      changed: true,
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(agentId)))?.autonomousActions).toBe(
      false,
    );
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ['agent.autonomy-changed', { from: false, to: true, reason: 'set by the manager' }],
      ['agent.autonomy-changed', { from: true, to: false, reason: 'set by the manager' }],
    ]);
  });

  it('is refused in mock mode before the ownership check, and leaves the row alone', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await expect(
      harness
        .withIdentity(managerIdentity())
        .mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).rejects.toThrow(
      'Autonomous actions is a local real-mode feature; this deployment runs in mock mode.',
    );
    await expect(
      harness.mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).rejects.toThrow('local real-mode feature');
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(agentId)))?.autonomousActions,
    ).toBeUndefined();
    expect(await harness.run(async (ctx) => await ctx.db.query('events').collect())).toEqual([]);
  });

  it('lets only the owner choose the manager notification mode, and records the change', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .mutation(api.agents.setManagerNotifications, { agentId, mode: 'digest' }),
    ).rejects.toThrow('forbidden');
    const owner = harness.withIdentity(managerIdentity());
    await expect(
      owner.mutation(api.agents.setManagerNotifications, { agentId, mode: 'per-run' }),
    ).resolves.toEqual({
      ok: true,
      managerNotifications: 'per-run',
      changed: false,
    });
    await expect(
      owner.mutation(api.agents.setManagerNotifications, { agentId, mode: 'digest' }),
    ).resolves.toEqual({
      ok: true,
      managerNotifications: 'digest',
      changed: true,
    });
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(agentId)))?.managerNotifications,
    ).toBe('digest');
    const changes = (
      await harness.run(async (ctx) => await ctx.db.query('events').collect())
    ).filter((event) => event.type === 'agent.notifications-changed');
    expect(changes.map((event) => event.payload)).toEqual([
      { from: 'per-run', to: 'digest', reason: 'set by the manager' },
    ]);
  });

  it('sends the notes kept for a digest when the manager switches back to per run', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          managerNotifications: 'digest',
          createdAt: 1,
        }),
    );
    const scheduled = async (): Promise<string[]> =>
      await harness.run(async (ctx) =>
        (await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name),
      );
    const owner = harness.withIdentity(managerIdentity());
    await owner.mutation(api.agents.setManagerNotifications, { agentId, mode: 'digest' });
    expect(await scheduled()).toEqual([]);
    await owner.mutation(api.agents.setManagerNotifications, { agentId, mode: 'per-run' });
    expect(await scheduled()).toEqual(['managerChannelActions:sendManagerDigests']);
  });
});

describe('the agent’s zone and mode (N12)', (): void => {
  it('stores the manager’s browser zone and the deployment’s mode at deploy, on the row and the deploy event', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {
      zone: 'Asia/Singapore',
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(agentId))).toMatchObject({
      zone: 'Asia/Singapore',
      mode: 'mock',
    });
    const deployed = (
      await harness.run(async (ctx) => await ctx.db.query('events').collect())
    ).find((event) => event.type === 'agent.deployed');
    expect(deployed?.payload).toMatchObject({ zone: 'Asia/Singapore', mode: 'mock' });
  });

  it('falls back to the deployment’s zone when the browser sends none or one the backend does not know', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const none = await owner.mutation(api.agents.deploy, {});
    const unknown = await owner.mutation(api.agents.deploy, {
      zone: 'Mars/Olympus',
    });
    const rows = await harness.run(
      async (ctx) => await Promise.all([ctx.db.get(none), ctx.db.get(unknown)]),
    );
    expect(rows.map((row) => row?.zone)).toEqual(['UTC', 'UTC']);
  });

  it('lets only the owner change the zone from the card, refuses an unknown zone, and records the change', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          zone: 'UTC',
          createdAt: 1,
        }),
    );
    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .mutation(api.agents.setZone, { agentId, zone: 'Asia/Singapore' }),
    ).rejects.toThrow('forbidden');
    const owner = harness.withIdentity(managerIdentity());
    await expect(
      owner.mutation(api.agents.setZone, { agentId, zone: 'Nowhere/Else' }),
    ).rejects.toThrow('not a time zone');
    await expect(
      owner.mutation(api.agents.setZone, { agentId, zone: 'Asia/Singapore' }),
    ).resolves.toEqual({ zone: 'Asia/Singapore', changed: true });
    await expect(
      owner.mutation(api.agents.setZone, { agentId, zone: 'asia/singapore' }),
    ).resolves.toEqual({ zone: 'Asia/Singapore', changed: false });
    const changes = (
      await harness.run(async (ctx) => await ctx.db.query('events').collect())
    ).filter((event) => event.type === 'agent.zone-changed');
    expect(changes.map((event) => event.payload)).toEqual([{ from: 'UTC', to: 'Asia/Singapore' }]);
  });
});

type Harness = TestConvex<typeof schema>;

/** An employee's month with nothing landed yet, as the roster returns it. */
const NOTHING_LANDED = { month: expect.stringMatching(/^\d{4}-\d{2}$/), days: [], atLeast: false };

/**
 * Deploy one employee through the public mutation, as the landing page does.
 *
 * Args:
 *   harness: Convex test harness.
 *   subject: Owner subject the deploy runs as.
 *   name: Display name, also the avatar id's suffix.
 *   options: The deploying manager's verified address, an evaluation address (on a bed), and
 *     documentation exclusions, when not the default.
 *
 * Returns:
 *   The new agent id.
 */
async function deployEmployee(
  harness: Harness,
  subject: string,
  name: string,
  options: {
    managerAddress?: string;
    evaluationAddress?: string;
    excludedDocSourceIds?: Id<'docSources'>[];
  } = {},
): Promise<Id<'agents'>> {
  const identity = managerIdentity(
    subject,
    options.managerAddress === undefined ? {} : { email: options.managerAddress },
  );
  return await harness.withIdentity(identity).mutation(api.agents.deploy, {
    evaluationAddress: options.evaluationAddress,
    name,
    avatarId: `avatar-${name.toLowerCase()}`,
    excludedDocSourceIds: options.excludedDocSourceIds,
  });
}

/**
 * Write one charter row for an employee and move the employee to the state
 * the row implies.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: The employee.
 *   body: Charter body; `proposedFunction` is what the roster reads.
 *   approved: Whether the manager has approved the row.
 *
 * Returns:
 *   The new charter id.
 */
async function seedCharter(
  harness: Harness,
  agentId: Id<'agents'>,
  body: unknown,
  approved: boolean,
): Promise<Id<'charters'>> {
  return await harness.run(async (ctx): Promise<Id<'charters'>> => {
    const charterId = await ctx.db.insert('charters', {
      agentId,
      version: '0.0',
      body,
      approved,
      ...(approved ? { approvedAt: 3 } : {}),
      createdAt: 2,
    });
    await ctx.db.patch(agentId, { state: approved ? 'active' : 'charter-pending' });
    return charterId;
  });
}

/**
 * Insert one work item per state for an employee.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: The employee.
 *   states: One state per row.
 */
async function seedWork(
  harness: Harness,
  agentId: Id<'agents'>,
  states: Doc<'workItems'>['state'][],
): Promise<void> {
  await harness.run(async (ctx): Promise<void> => {
    for (const [index, state] of states.entries()) {
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: `${agentId}-${index}`,
        title: `Synthetic item ${index}`,
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state,
        observedAt: 1,
        createdAt: 1,
      });
    }
  });
}

/**
 * Insert one work item that holds no slot: deferred, waiting on a skill, in
 * `discovered` with or without a queue verdict, or ended.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: The employee.
 *   externalId: The provider item, as the run named it.
 *   state: The row's state.
 *   fields: The verdict and the skill the row waits on, or what an ended row
 *     keeps: its plan, output, reason, rejection and reconciliation.
 *
 * Returns:
 *   The new work item id.
 */
async function seedParked(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  state: Doc<'workItems'>['state'],
  fields: Partial<
    Pick<
      Doc<'workItems'>,
      | 'verdict'
      | 'proposedSkillId'
      | 'plan'
      | 'output'
      | 'skipReason'
      | 'managerFeedback'
      | 'providerReconciliation'
      | 'pendingRunId'
      | 'evaluationClaimedAt'
      | 'evaluationAttempts'
    >
  >,
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId,
        title: externalId,
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state,
        observedAt: 1,
        createdAt: 1,
        ...fields,
      }),
  );
}

/**
 * Insert one agent-authored skill, optionally held by an authoring run.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: The employee.
 *   skill: The skill's state and, when a run holds it, when the run took it.
 *
 * Returns:
 *   The new skill id.
 */
async function seedSkill(
  harness: Harness,
  agentId: Id<'agents'>,
  skill: { state: Doc<'skills'>['state']; claimedAt?: number },
): Promise<Id<'skills'>> {
  return await harness.run(async (ctx): Promise<Id<'skills'>> => {
    const claim =
      skill.claimedAt === undefined
        ? {}
        : {
            authoringRunId: await ctx.db.insert('events', {
              agentId,
              type: 'skill.authoring-claimed',
              payload: {},
              createdAt: skill.claimedAt,
            }),
            authoringClaimedAt: skill.claimedAt,
          };
    return await ctx.db.insert('skills', {
      agentId,
      name: `synthetic-${skill.state}`,
      description: 'Synthetic.',
      body: '',
      sourceType: 'agent-authored',
      state: skill.state,
      createdAt: 1,
      ...claim,
    });
  });
}

describe('the employee roster', (): void => {
  it('does not mistake an ordinary employee for a trial because of the manager address', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.stubEnv('DAY0_EVALUATION_BED', 'roster');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const ordinary = await deployEmployee(harness, 'owner', 'Evaluation coordinator', {
      managerAddress: 'eval-payroll@day0.local',
    });
    await deployEmployee(harness, 'owner', 'Day0 revocation evaluation', {
      evaluationAddress: 'eval-revocation-2026-09-18t07-00-00z@day0.local',
    });
    await deployEmployee(harness, 'owner', 'Day0 revocation evaluation', {
      evaluationAddress: 'eval-revocation-20260918t090000@day0.local',
    });
    await deployEmployee(harness, 'owner', 'Day0 evaluation 1', {
      evaluationAddress: 'eval-day0-r1-1758150000000@day0.local',
    });

    expect((await owner.query(api.agents.rosterForUser, {})).map((row) => row.agentId)).toEqual([
      ordinary,
    ]);
    const supervision = await owner.query(api.metrics.forOwner, {});
    expect(supervision?.employees.map((row) => row.agentId)).toEqual([ordinary]);
    expect(supervision?.excludedAgents).toBe(3);
  });

  it('does not let a caller with an empty subject read malformed owner rows', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Malformed owner',
        userId: '',
        state: 'deployed',
        createdAt: 1,
      });
    });
    await expect(
      harness.withIdentity(managerIdentity('')).query(api.agents.rosterForUser, {}),
    ).resolves.toEqual([]);
  });

  it("shows each of the owner's employees with its role, open work, what needs the manager and its autonomy, and nobody else", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_EVALUATION_BED', 'roster');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    await seedSource(harness, 'owner', 'Company handbook');
    const financeNotes = await seedSource(harness, 'owner', 'Finance notes');
    await seedSource(harness, 'stranger', 'Stranger docs');

    const priya = await deployEmployee(harness, 'owner', 'Priya');
    const mateo = await deployEmployee(harness, 'owner', 'Mateo');
    const aiko = await deployEmployee(harness, 'owner', 'Aiko', {
      excludedDocSourceIds: [financeNotes],
    });
    const trial = await deployEmployee(harness, 'owner', 'Day0 revocation evaluation', {
      evaluationAddress: 'eval-revocation-2026-09-18t07-00-00z@day0.local',
    });
    await deployEmployee(harness, 'owner', 'Day0 evaluation 1', {
      evaluationAddress: 'eval-day0-r1-1758150000000@day0.local',
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Ordinary agent evaluation 1',
        userId: 'owner',
        state: 'active',
        arm: 'baseline',
        createdAt: 1,
      });
    });
    const stranger = await deployEmployee(harness, 'stranger', 'Somebody else');

    await seedCharter(harness, priya, runThroughBody(), true);
    await seedCharter(
      harness,
      mateo,
      { ...runThroughBody(), proposedFunction: 'Close the month for the finance team.' },
      true,
    );
    await seedCharter(
      harness,
      aiko,
      { ...runThroughBody(), proposedFunction: 'Run the logistics desk.' },
      false,
    );
    await seedWork(harness, priya, [
      'claimed',
      'plan-pending',
      'actions-pending',
      'completed',
      'discovered',
      'failed',
    ]);
    await seedWork(harness, mateo, ['executing', 'plan-approved', 'plan-pending', 'skipped']);
    await seedWork(harness, trial, ['actions-pending']);
    await seedWork(harness, stranger, ['plan-pending']);
    const owner = harness.withIdentity(managerIdentity());
    await owner.mutation(api.agents.setAutonomousActions, { agentId: mateo, on: true });

    await expect(owner.query(api.agents.rosterForUser, {})).resolves.toEqual([
      {
        agentId: aiko,
        name: 'Aiko',
        avatarId: 'avatar-aiko',
        state: 'charter-pending',
        // No one-to-one has opened: the room is waiting to talk.
        phase: 'talking',
        autonomous: false,
        roleLine: 'charter pending',
        openCount: 0,
        parkedCount: 0,
        parkedStates: { deferred: 0, needsSkill: 0, discovered: 0 },
        stoppedCount: 0,
        // The drafted charter waits on the manager's approval.
        needsYou: 1,
        docSourceCount: 1,
        landedThisMonth: NOTHING_LANDED,
      },
      {
        agentId: mateo,
        name: 'Mateo',
        avatarId: 'avatar-mateo',
        state: 'active',
        phase: 'talking',
        autonomous: true,
        roleLine: 'Close the month for the finance team.',
        openCount: 3,
        parkedCount: 0,
        parkedStates: { deferred: 0, needsSkill: 0, discovered: 0 },
        stoppedCount: 0,
        needsYou: 1,
        docSourceCount: 2,
        landedThisMonth: NOTHING_LANDED,
      },
      {
        agentId: priya,
        name: 'Priya',
        avatarId: 'avatar-priya',
        state: 'active',
        phase: 'talking',
        autonomous: false,
        roleLine:
          'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps\u2026',
        openCount: 3,
        // The discovered row waits for a free slot, unevaluated (U3 D5).
        parkedCount: 1,
        // Named by its state on the roster, as the Work tab does (walk m10).
        parkedStates: { deferred: 0, needsSkill: 0, discovered: 1 },
        stoppedCount: 1,
        needsYou: 3,
        docSourceCount: 2,
        landedThisMonth: NOTHING_LANDED,
      },
    ]);
    await expect(
      harness.withIdentity(managerIdentity('stranger')).query(api.agents.rosterForUser, {}),
    ).resolves.toEqual([
      {
        agentId: stranger,
        name: 'Somebody else',
        avatarId: 'avatar-somebody else',
        state: 'deployed',
        phase: 'talking',
        autonomous: false,
        roleLine: 'charter pending',
        openCount: 1,
        parkedCount: 0,
        parkedStates: { deferred: 0, needsSkill: 0, discovered: 0 },
        stoppedCount: 0,
        needsYou: 1,
        docSourceCount: 1,
        landedThisMonth: NOTHING_LANDED,
      },
    ]);
    await expect(harness.query(api.agents.rosterForUser, {})).resolves.toEqual([]);
  });

  it('gives each row the state the employee’s own page shows, a charter outranking the row (m6)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const drafted = await deployEmployee(harness, 'owner', 'Nia');
    const approvedOnly = await deployEmployee(harness, 'owner', 'Tomas');
    const talking = await deployEmployee(harness, 'owner', 'Mira');
    await seedCharter(harness, drafted, runThroughBody(), false);
    await seedCharter(harness, approvedOnly, runThroughBody(), true);
    // Each row still says the one-to-one is on: the charter has moved ahead of it.
    await harness.run(async (ctx): Promise<void> => {
      for (const agentId of [drafted, approvedOnly, talking]) {
        await ctx.db.patch(agentId, { state: 'day-one-in-progress' });
      }
    });
    const states = Object.fromEntries(
      (await harness.withIdentity(managerIdentity()).query(api.agents.rosterForUser, {})).map(
        (row): [string, string] => [row.name, row.state],
      ),
    );
    expect(states).toEqual({
      Nia: 'charter-pending',
      Tomas: 'active',
      Mira: 'day-one-in-progress',
    });
  });

  it("carries the one-to-one's phase on each row, read off the newest session as the employee's page reads it (C2)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    type Session = Pick<
      Doc<'voiceSessions'>,
      'state' | 'pendingTranscript' | 'finalisationError' | 'recoveryAttempts'
    >;
    // Each employee's sessions, oldest first: the newest is the one the page reads.
    const sessions: Record<string, readonly Session[]> = {
      Ana: [],
      Ben: [{ state: 'active' }],
      Cai: [{ state: 'active', pendingTranscript: 'the transcript' }],
      Dev: [{ state: 'done' }, { state: 'synthesising', pendingTranscript: 'the transcript' }],
      Eli: [
        {
          state: 'active',
          pendingTranscript: 'the transcript',
          finalisationError: 'model timed out',
          recoveryAttempts: 1,
        },
      ],
      Fay: [
        {
          state: 'active',
          pendingTranscript: 'the transcript',
          finalisationError: 'model timed out',
          recoveryAttempts: MAX_FINALISATION_RECOVERIES,
        },
      ],
      Gus: [{ state: 'done' }],
    };
    for (const [name, rows] of Object.entries(sessions)) {
      const agentId = await deployEmployee(harness, 'owner', name);
      await harness.run(async (ctx): Promise<void> => {
        await ctx.db.patch(agentId, { state: 'day-one-in-progress' });
        for (const [index, row] of rows.entries()) {
          await ctx.db.insert('voiceSessions', {
            agentId,
            mode: 'chat',
            answers: {},
            startedAt: index + 1,
            ...row,
          });
        }
      });
    }
    const roster = await harness
      .withIdentity(managerIdentity())
      .query(api.agents.rosterForUser, {});
    const phases = Object.fromEntries(roster.map((row): [string, string] => [row.name, row.phase]));
    expect(phases).toEqual({
      Ana: 'talking',
      Ben: 'talking',
      Cai: 'drafting',
      Dev: 'drafting',
      Eli: 'drafting',
      Fay: 'failed',
      Gus: 'drafted',
    });
  });

  it('counts parked work beside open work, and under needs-you only what the manager alone can release (19 Sep run)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T19:26:17Z'));
    const harness = convexTest(schema, allConvexModules());
    const priya = await deployEmployee(harness, 'owner', 'Priya');
    const mateo = await deployEmployee(harness, 'owner', 'Mateo');
    const aiko = await deployEmployee(harness, 'owner', 'Aiko');
    const counts = async (): Promise<Record<string, [number, number, number]>> =>
      Object.fromEntries(
        (await harness.withIdentity(managerIdentity()).query(api.agents.rosterForUser, {})).map(
          (row): [string, [number, number, number]] => [
            row.name,
            [row.openCount, row.parkedCount, row.needsYou],
          ],
        ),
      );

    // The landing page as the run left it: every row read `0 open \u00b7 0 need you`.
    const registered = await seedSkill(harness, aiko, { state: 'registered' });
    const priyaRegistered = await seedSkill(harness, priya, { state: 'registered' });
    await seedParked(harness, priya, 'REVOPS-27', 'deferred', {
      verdict: {
        decision: 'defer',
        reason: 'awaiting-connection',
        missingSurface: 'looker-pipeline-tile',
      },
    });
    await seedParked(harness, priya, 'REVOPS-29', 'deferred', {
      verdict: { decision: 'defer', reason: 'awaiting-connection', missingSurface: 'northstar' },
    });
    await seedParked(harness, priya, 'C0BSF04TZ19:1789757860.970749', 'needs-skill', {
      verdict: { decision: 'needs-skill', reason: 'no registered skill fits' },
      proposedSkillId: priyaRegistered,
    });
    await seedParked(harness, aiko, 'LOG-1', 'needs-skill', {
      verdict: { decision: 'needs-skill', reason: 'no registered skill fits' },
      proposedSkillId: registered,
    });
    // Mateo mid-run: the ask waits for plan approval, FIN-1 waits behind the cap, FIN-2 waits for
    // its evaluation; both wait for a free slot, so both are parked (U3 D5).
    await seedWork(harness, mateo, ['plan-pending']);
    await seedParked(harness, mateo, 'FIN-1', 'discovered', {
      verdict: {
        decision: 'queue',
        reason: 'WIP cap reached: supervised cold-start limit is 1',
        openClaims: 1,
      },
    });
    await seedParked(harness, mateo, 'FIN-2', 'discovered', {});
    expect(await counts()).toEqual({ Priya: [0, 3, 2], Mateo: [1, 2, 1], Aiko: [0, 1, 0] });
    // The same parked rows by the state each is in, the words the roster says them in (walk m10).
    const states = Object.fromEntries(
      (await harness.withIdentity(managerIdentity()).query(api.agents.rosterForUser, {})).map(
        (row) => [row.name, row.parkedStates],
      ),
    );
    expect(states).toEqual({
      Priya: { deferred: 2, needsSkill: 1, discovered: 0 },
      Mateo: { deferred: 0, needsSkill: 0, discovered: 2 },
      Aiko: { deferred: 0, needsSkill: 1, discovered: 0 },
    });
    // A row whose evaluation is running holds the slot it runs in; one whose
    // evaluation died waits again once the lease has passed.
    await seedParked(harness, mateo, 'FIN-3', 'discovered', {
      evaluationClaimedAt: Date.now() - 60_000,
      evaluationAttempts: 1,
    });
    expect((await counts()).Mateo).toEqual([1, 2, 1]);
    await seedParked(harness, mateo, 'FIN-4', 'discovered', {
      evaluationClaimedAt: Date.now() - 11 * 60_000,
      evaluationAttempts: 1,
    });
    expect((await counts()).Mateo).toEqual([1, 3, 1]);

    // A `needs-skill` row is the manager's to release while its skill waits on a manager's click.
    const live = Date.now() - 60_000;
    const lapsed = Date.now() - 11 * 60_000;
    const waiting: Array<[string, Parameters<typeof seedSkill>[2], number]> = [
      ['proposed', { state: 'proposed' }, 1],
      ['approved', { state: 'approved' }, 1],
      ['failed', { state: 'failed' }, 1],
      ['verified', { state: 'verified' }, 1],
      ['parked-unverified', { state: 'authoring' }, 1],
      ['run-in-flight', { state: 'authoring', claimedAt: live }, 0],
      ['run-gone', { state: 'authoring', claimedAt: lapsed }, 1],
    ];
    let expected = 0;
    let proposedSkill: Id<'skills'> | undefined;
    for (const [label, skill, needsYou] of waiting) {
      const skillId = await seedSkill(harness, aiko, skill);
      if (skill.state === 'proposed') proposedSkill = skillId;
      await seedParked(harness, aiko, `LOG-${label}`, 'needs-skill', {
        verdict: { decision: 'needs-skill', reason: 'no registered skill fits' },
        proposedSkillId: skillId,
      });
      expected += needsYou;
    }
    // No proposal exists yet: the proposal is the employee's own next step.
    await seedParked(harness, aiko, 'LOG-unproposed', 'needs-skill', {
      verdict: { decision: 'needs-skill', reason: 'no registered skill fits' },
    });
    // Two rows behind one proposal, as SH-4471 and SH-4480 were behind Aiko's skill: both wait on the same click.
    await seedParked(harness, aiko, 'LOG-second-asker', 'needs-skill', {
      verdict: { decision: 'needs-skill', reason: 'no registered skill fits' },
      proposedSkillId: proposedSkill,
    });
    expect((await counts()).Aiko).toEqual([0, 1 + waiting.length + 2, expected + 1]);
  });

  it('counts a stopped row that still offers the manager a move, beside open and parked and under needs-you (19 Sep second run)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T21:58:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const priya = await deployEmployee(harness, 'owner', 'Priya');
    const mateo = await deployEmployee(harness, 'owner', 'Mateo');
    const aiko = await deployEmployee(harness, 'owner', 'Aiko');
    const counts = async (): Promise<Record<string, [number, number, number, number]>> =>
      Object.fromEntries(
        (await harness.withIdentity(managerIdentity()).query(api.agents.rosterForUser, {})).map(
          (row): [string, [number, number, number, number]] => [
            row.name,
            [row.openCount, row.parkedCount, row.stoppedCount, row.needsYou],
          ],
        ),
      );
    const plan = { summary: 'Synthetic.', steps: ['Synthetic.'] };
    const comment = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: '{"issueId":"REVOPS-28","body":"Q3 close-summary audit note."}',
      },
    };
    const landed = {
      authority: 'autonomous',
      effect: 'save_comment on linear',
      ok: true,
      providerId: 'f465de65-f1b4-46f7-bfe8-b779071116b1',
      tool: 'mcp.call',
    };

    // The landing page as the run left it: Priya's row read `0 open · 0 need you` over two stopped items.
    await seedParked(harness, priya, 'REVOPS-28', 'failed', {
      plan,
      output: { actions: [comment], applied: [landed] },
      skipReason:
        "1 approved plan step(s) remained blocked: step 5 (Done is withheld: checks 2 and 3 are not confirmed, and the checklist requires all three confirmed or the manager saying so. The audit comment (action index 0) is emitted; the save_issue Done transition awaits the manager's direction.)",
    });
    await seedParked(harness, priya, 'C0C2U2UJUTU:1789761553.312049', 'failed', {
      plan,
      skipReason:
        '1 of 7 actions did not change the work environment: mcp.call (shared credential write without attributable content)',
    });
    await seedWork(harness, priya, ['completed', 'completed', 'skipped']);
    await seedWork(harness, mateo, [
      'completed',
      'completed',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
    await seedWork(harness, aiko, ['completed', 'completed']);
    expect(await counts()).toEqual({
      Priya: [0, 0, 2, 2],
      Mateo: [0, 0, 0, 0],
      Aiko: [0, 0, 0, 0],
    });

    // A stop with nothing landed: Retry stands.
    await seedParked(harness, aiko, 'SH-4471', 'failed', {
      plan,
      skipReason: `${STOPPED_PREFIX}2 approved plan step(s) remained blocked`,
    });
    expect((await counts()).Aiko).toEqual([0, 0, 1, 1]);

    // An interrupted apply whose ledger names what to verify: the reconciliation is the manager's move, then Retry.
    await seedParked(harness, aiko, 'LOG-interrupted', 'failed', {
      plan,
      output: {
        actions: [comment],
        applied: [{ tool: 'mcp.call', ok: false, outcomeUnknown: true }],
      },
      skipReason: INTERRUPTED_APPLY_REASON,
    });
    expect((await counts()).Aiko).toEqual([0, 0, 2, 2]);

    // The same with nothing to verify against: the card disables both the confirmation and Retry, for good.
    await seedParked(harness, aiko, 'LOG-dead-end', 'failed', {
      plan,
      skipReason: INTERRUPTED_APPLY_REASON,
    });
    expect((await counts()).Aiko).toEqual([0, 0, 2, 2]);

    // Rejected by the manager, through the mutation the dashboard calls: the held set waited on
    // them, the rejected row keeps its Retry but waits on nobody, since the last decision was theirs.
    const owner = harness.withIdentity(managerIdentity());
    for (const [index, [externalId, reason]] of [
      ['LOG-rejected', 'not this quarter'],
      ['LOG-rejected-bare', ''],
    ].entries()) {
      const pendingRunId = await harness.run(
        async (ctx) =>
          await ctx.db.insert('events', {
            agentId: aiko,
            type: 'work.run',
            payload: {},
            createdAt: 1,
          }),
      );
      const workItemId = await seedParked(harness, aiko, externalId, 'actions-pending', {
        plan,
        output: { actions: [comment] },
        pendingRunId,
      });
      expect((await counts()).Aiko).toEqual([1, 0, 2 + index, 3]);
      await owner.mutation(api.work.rejectActions, { workItemId, pendingRunId, reason });
    }
    expect((await counts()).Aiko).toEqual([0, 0, 4, 2]);

    // A cancelled plan, a skip and finished work are not stopped rows.
    await seedParked(harness, aiko, 'LOG-cancelled', 'cancelled', {
      plan,
      skipReason: 'plan cancelled by the manager',
    });
    expect((await counts()).Aiko).toEqual([0, 0, 4, 2]);
  });

  it('reads the charter the manager approved: an amendment at once, never a draft, and pending again after a draft is sent back', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const roleLines = async (): Promise<Record<string, string>> =>
      Object.fromEntries(
        (await owner.query(api.agents.rosterForUser, {})).map((row): [string, string] => [
          row.name,
          row.roleLine,
        ]),
      );

    const priya = await deployEmployee(harness, 'owner', 'Priya');
    await seedCharter(
      harness,
      priya,
      { ...runThroughBody(), proposedFunction: 'Own routine revenue operations work.' },
      true,
    );
    await owner.mutation(api.charters.amend, {
      agentId: priya,
      changes: [{ kind: 'edit-function', text: 'Own the RevOps queue in Linear.' }],
    });
    await expect(roleLines()).resolves.toEqual({ Priya: 'Own the RevOps queue in Linear.' });

    await seedCharter(
      harness,
      priya,
      { ...runThroughBody(), proposedFunction: 'A redraft nobody approved.' },
      false,
    );
    await expect(roleLines()).resolves.toMatchObject({ Priya: 'Own the RevOps queue in Linear.' });

    const aiko = await deployEmployee(harness, 'owner', 'Aiko');
    const draft = await seedCharter(
      harness,
      aiko,
      { ...runThroughBody(), proposedFunction: 'Run the logistics desk.' },
      false,
    );
    await expect(roleLines()).resolves.toMatchObject({ Aiko: 'charter pending' });
    await owner.mutation(api.charters.requestChanges, { charterId: draft });
    await expect(roleLines()).resolves.toMatchObject({ Aiko: 'charter pending' });

    const mateo = await deployEmployee(harness, 'owner', 'Mateo');
    await seedCharter(harness, mateo, { version: '0.0' }, true);
    await expect(roleLines()).resolves.toMatchObject({ Mateo: 'role not stated' });
  });

  it('counts a drafted charter under needs-you until the manager approves it or sends it back (P10-4)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const needsYou = async (): Promise<Record<string, number>> =>
      Object.fromEntries(
        (await owner.query(api.agents.rosterForUser, {})).map((row): [string, number] => [
          row.name,
          row.needsYou,
        ]),
      );

    const aiko = await deployEmployee(harness, 'owner', 'Aiko');
    await expect(needsYou()).resolves.toEqual({ Aiko: 0 });
    const sentBack = await seedCharter(harness, aiko, runThroughBody(), false);
    await expect(needsYou()).resolves.toEqual({ Aiko: 1 });
    await owner.mutation(api.charters.requestChanges, { charterId: sentBack });
    await expect(needsYou()).resolves.toEqual({ Aiko: 0 });

    const approved = await seedCharter(harness, aiko, runThroughBody(), false);
    await expect(needsYou()).resolves.toEqual({ Aiko: 1 });
    await owner.mutation(api.charters.approve, { charterId: approved });
    await expect(needsYou()).resolves.toEqual({ Aiko: 0 });

    // A redraft after approval waits on the manager too, while the approved role still shows.
    await seedCharter(
      harness,
      aiko,
      { ...runThroughBody(), proposedFunction: 'A redraft.' },
      false,
    );
    await expect(needsYou()).resolves.toEqual({ Aiko: 1 });
  });

  it('lists at most 20 employees, newest first, and an evaluation agent never takes a place', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.stubEnv('DAY0_EVALUATION_BED', 'roster');
    const harness = convexTest(schema, allConvexModules());
    const employees: Id<'agents'>[] = [];
    for (let index = 1; index <= 21; index += 1) {
      employees.push(await deployEmployee(harness, 'owner', `Employee ${index}`));
    }
    for (let index = 1; index <= 3; index += 1) {
      await deployEmployee(harness, 'owner', 'Day0 revocation evaluation', {
        evaluationAddress: `eval-revocation-2026-09-18t07-00-0${index}z@day0.local`,
      });
    }

    const roster = await harness
      .withIdentity(managerIdentity())
      .query(api.agents.rosterForUser, {});
    expect(roster.map((row) => row.agentId)).toEqual(employees.slice(1).reverse());
  });

  it('handles 20 employees and 500 items while counting only linked documentation', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sources = await harness.run(async (ctx): Promise<Id<'docSources'>[]> => {
      const ids: Id<'docSources'>[] = [];
      for (let index = 0; index < 100; index += 1) {
        ids.push(
          await ctx.db.insert('docSources', {
            userId: 'owner',
            label: `Source ${index}`,
            kind: 'folder',
            locator: `source-${index}`,
            status: 'synced',
            createdAt: 1,
            updatedAt: 1,
          }),
        );
      }
      return ids;
    });
    const employees = await harness.run(async (ctx): Promise<Id<'agents'>[]> => {
      const ids: Id<'agents'>[] = [];
      for (let index = 0; index < 20; index += 1) {
        ids.push(
          await ctx.db.insert('agents', {
            bossEmail: MANAGER_ADDRESS,
            name: `Employee ${index}`,
            userId: 'owner',
            state: 'active',
            ...(index === 0 ? { excludedDocSourceIds: [sources[0]] } : {}),
            createdAt: 1,
          }),
        );
      }
      return ids;
    });
    const states: Doc<'workItems'>['state'][] = [
      'claimed',
      'plan-pending',
      'plan-approved',
      'executing',
      'actions-pending',
      ...Array.from({ length: 20 }, (): Doc<'workItems'>['state'] => 'completed'),
    ];
    for (const agentId of employees) await seedWork(harness, agentId, states);

    const owner = harness.withIdentity(managerIdentity());
    const roster = await owner.query(api.agents.rosterForUser, {});
    expect(roster).toHaveLength(20);
    expect(roster.map((row) => [row.openCount, row.needsYou])).toEqual(
      Array.from({ length: 20 }, () => [5, 2]),
    );
    expect(roster.find((row) => row.agentId === employees[0])?.docSourceCount).toBe(99);
    expect(
      roster
        .filter((row) => row.agentId !== employees[0])
        .every((row) => row.docSourceCount === 100),
    ).toBe(true);

    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.delete(sources[0]);
    });
    const afterUnlink = await owner.query(api.agents.rosterForUser, {});
    expect(afterUnlink.every((row) => row.docSourceCount === 99)).toBe(true);
  });

  it('clips a long role line at a word boundary to 90 characters', (): void => {
    const cases: Array<[string, string]> = [
      [
        'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
        'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps\u2026',
      ],
      [
        'Reconcile the month-end ledgers against the bank feeds, chase missing supplier invoices, and prepare the close pack.',
        'Reconcile the month-end ledgers against the bank feeds, chase missing supplier invoices\u2026',
      ],
      [
        '  Close the month,\n every month,   for the finance team. ',
        'Close the month, every month, for the finance team.',
      ],
      [`${'a'.repeat(44)} ${'b'.repeat(45)}`, `${'a'.repeat(44)} ${'b'.repeat(45)}`],
      ['x'.repeat(120), `${'x'.repeat(89)}\u2026`],
    ];
    for (const [text, expected] of cases) {
      expect(clipRoleLine(text)).toBe(expected);
      expect(clipRoleLine(text).length).toBeLessThanOrEqual(90);
    }
  });

  it('does not split a surrogate pair when one long role word must be clipped', (): void => {
    const glyph = '\u{1F600}';
    expect(clipRoleLine(glyph.repeat(60))).toBe(`${glyph.repeat(44)}\u2026`);
  });
  it('counts a new stop under needs-you even when older rejected rows fill the stopped read', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mira = await deployEmployee(harness, 'owner', 'Mira');
    await harness.run(async (ctx) => {
      for (let index = 0; index < 26; index += 1) {
        await ctx.db.insert('workItems', {
          agentId: mira,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `REVOPS-${index}`,
          title: `REVOPS-${index}`,
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state: 'failed',
          skipReason: index < 25 ? 'rejected by the manager: not now' : 'the run stopped',
          observedAt: 1,
          createdAt: 1,
        });
      }
    });

    const [row] = await harness.withIdentity(managerIdentity()).query(api.agents.rosterForUser, {});

    expect(row?.needsYou).toBe(1);
  });

  it('keeps today’s landings when a busy month passes the bound, and says the count is a floor', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const harness = convexTest(schema, allConvexModules());
    const mira = await deployEmployee(harness, 'owner', 'Mira');
    const landOn = async (at: string, count: number, prefix: string): Promise<void> => {
      vi.setSystemTime(new Date(at));
      await harness.run(async (ctx) => {
        for (let index = 0; index < count; index += 1) {
          await ctx.db.insert('events', {
            agentId: mira,
            type: 'work.completed',
            payload: { workItemId: `${prefix}-${index}`, output: {} },
            createdAt: Date.now(),
          });
        }
      });
    };
    await landOn('2026-09-02T02:00:00Z', 100, 'early');
    await landOn('2026-09-26T02:00:00Z', 1, 'today');
    vi.setSystemTime(new Date('2026-09-26T06:00:00Z'));
    const owner = harness.withIdentity(managerIdentity());

    const [busy] = await owner.query(api.agents.rosterForUser, {});

    expect(busy?.landedThisMonth.days.at(-1)).toEqual({ day: '2026-09-26', landed: 1 });
    expect(busy?.landedThisMonth.atLeast).toBe(true);
  });

  it('reads a month of exactly the bound’s landings as complete', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T06:00:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const mira = await deployEmployee(harness, 'owner', 'Mira');
    await harness.run(async (ctx) => {
      for (let index = 0; index < 100; index += 1) {
        await ctx.db.insert('events', {
          agentId: mira,
          type: 'work.completed',
          payload: { workItemId: `item-${index}`, output: {} },
          createdAt: Date.now(),
        });
      }
    });

    const [row] = await harness.withIdentity(managerIdentity()).query(api.agents.rosterForUser, {});

    expect(row?.landedThisMonth).toMatchObject({ days: [{ landed: 100 }], atLeast: false });
  });

  it('counts each item landed this month once, on the day it first landed in the employee’s zone', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const harness = convexTest(schema, allConvexModules());
    const mira = await deployEmployee(harness, 'owner', 'Mira');
    await harness.run(async (ctx) => await ctx.db.patch(mira, { zone: 'Asia/Singapore' }));
    const [first, second, earlier] = await harness.run(
      async (ctx) =>
        await Promise.all(
          ['REVOPS-1', 'REVOPS-2', 'REVOPS-3'].map(
            async (externalId) =>
              await ctx.db.insert('workItems', {
                agentId: mira,
                sourceCategory: 'ticket-queue',
                sourceSystem: 'linear',
                externalId,
                title: externalId,
                contentSummary: 'Synthetic.',
                contentRefs: [],
                state: 'completed',
                observedAt: 1,
                createdAt: 1,
              }),
          ),
        ),
    );
    const land = async (workItemId: Id<'workItems'>, at: string): Promise<void> => {
      vi.setSystemTime(new Date(at));
      await harness.run(async (ctx) => {
        await ctx.db.insert('events', {
          agentId: mira,
          type: 'work.completed',
          payload: { workItemId, output: {} },
          createdAt: Date.now(),
        });
      });
    };
    // 31 Aug 17:00 UTC is 1 Sep 01:00 in Singapore: September there.
    await land(earlier, '2026-08-31T15:00:00Z');
    await land(first, '2026-08-31T17:00:00Z');
    await land(second, '2026-09-03T02:00:00Z');
    await land(second, '2026-09-17T02:00:00Z');
    vi.setSystemTime(new Date('2026-09-26T06:00:00Z'));

    const [row] = await harness.withIdentity(managerIdentity()).query(api.agents.rosterForUser, {});

    expect(row.landedThisMonth).toEqual({
      month: '2026-09',
      days: [
        { day: '2026-09-01', landed: 1 },
        { day: '2026-09-03', landed: 1 },
      ],
      atLeast: false,
    });
  });
});

// The free edit of the address is gone (the transfer plan, section 9): its pins are re-pinned to
// what replaced it, **Make it you** for the owner's own address and a handover for anyone else's.
describe('agents.setBossEmail, removed with the free edit', (): void => {
  const LEFT_WORKSPACE =
    'the manager email old@day0.local is not a member of this Slack workspace (users_not_found).';

  /**
   * Seed one surface for the agent with its approval and a credential.
   *
   * Args:
   *   harness: Convex test harness.
   *   agentId: Owning agent.
   *   fields: The slug, class, verdict and reason the row carries.
   *
   * Returns:
   *   The surface id.
   */
  async function seedApprovedSurface(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
    fields: { slug: string; class: string; verdict: Doc<'surfaces'>['verdict']; reason?: string },
  ): Promise<Id<'surfaces'>> {
    return await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: `${fields.slug} token`,
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: fields.slug,
        displayName: fields.slug,
        class: fields.class,
        verdict: fields.verdict,
        reason: fields.reason,
        whereFound: [],
        credentialId,
        credentialLanded: fields.verdict === 'connected',
        managerApprovedAt: 10,
        createdAt: 1,
      });
    });
  }

  /** The surfaces a probe is scheduled for, in scheduling order. */
  async function scheduledProbes(harness: TestConvex<typeof schema>): Promise<string[]> {
    return await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect())
        .filter((job) => job.name === 'surfaceActions:probeInternal')
        .map((job) => String((job.args[0] as { surfaceId: string }).surfaceId)),
    );
  }

  it('is no longer a function: the address changes only by deploy, Make it you and an accepted handover', (): void => {
    expect(Object.keys(agentsModule)).not.toContain('setBossEmail');
    expect(Object.keys(agentsModule)).toContain('adoptManagerAddress');
  });

  it('re-probes, on Make it you, the chat surfaces the change can mend, as the free edit did (Q6)', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('real');
    const { api: realApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await seedReportingTo(harness, 'old@day0.local');
    const connected = await seedApprovedSurface(harness, agentId, {
      slug: 'slack',
      class: 'chat',
      verdict: 'connected',
    });
    const lostManager = await seedApprovedSurface(harness, agentId, {
      slug: 'slack-ops',
      class: 'chat',
      verdict: 'ungranted',
      reason: LEFT_WORKSPACE,
    });
    await seedApprovedSurface(harness, agentId, {
      slug: 'slack-refused',
      class: 'chat',
      verdict: 'ungranted',
      reason: 'Slack auth.test failed: invalid_auth',
    });
    await seedApprovedSurface(harness, agentId, {
      slug: 'linear',
      class: 'kanban',
      verdict: 'connected',
    });

    await expect(owner.mutation(realApi.agents.adoptManagerAddress, { agentId })).resolves.toEqual({
      changed: true,
      reprobed: 2,
    });

    const agent = await harness.run(async (ctx) => await ctx.db.get(agentId));
    expect(agent?.bossEmail).toBe(MANAGER_ADDRESS);
    const changes = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect())
        .filter((event) => event.type === 'manager.changed')
        .map((event) => event.payload),
    );
    expect(changes).toEqual([{ via: 'adopted', bossEmail: MANAGER_ADDRESS }]);
    expect((await scheduledProbes(harness)).sort()).toEqual(
      [String(connected), String(lostManager)].sort(),
    );
  });

  it('writes nothing for the address the employee already reports to, in any case', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await seedReportingTo(harness, 'Boss@Day0.local');
    await expect(owner.mutation(api.agents.adoptManagerAddress, { agentId })).resolves.toEqual({
      changed: false,
      reprobed: 0,
    });
    const types = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).map((event) => event.type),
    );
    expect(types).not.toContain('manager.changed');
  });

  it('refuses another owner, a malformed address and an evaluation employee', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const agentId = await owner.mutation(api.agents.deploy, {});
    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .mutation(api.agents.adoptManagerAddress, { agentId }),
    ).rejects.toThrow();
    // Another person's address is reached only by a handover, which checks its shape.
    await expect(
      owner.mutation(api.managerTransfers.ask, { agentId, toAddress: 'not an address' }),
    ).rejects.toThrow('email address');
    vi.stubEnv('DAY0_EVALUATION_BED', 'refusals');
    const evaluationId = await owner.mutation(api.agents.deploy, {
      evaluationAddress: 'eval-day0-r1-1234567890123@day0.local',
      name: 'Day0 evaluation 1',
    });
    await expect(
      owner.mutation(api.agents.adoptManagerAddress, { agentId: evaluationId }),
    ).rejects.toThrow(EVALUATION_ADDRESS_FIXED);
    await expect(
      owner.mutation(api.managerTransfers.ask, {
        agentId: evaluationId,
        toAddress: 'someone@day0.local',
      }),
    ).rejects.toThrow('evaluation');
    const agent = await harness.run(async (ctx) => await ctx.db.get(agentId));
    expect(agent?.bossEmail).toBe(MANAGER_ADDRESS);
  });
});

/**
 * An employee of the fixture owner whose address an older release stored as given.
 *
 * @param bossEmail - The address the row reports to, in the spelling it was stored with.
 * @param fields - Anything else the row carries, such as an evaluation name.
 */
async function seedReportingTo(
  harness: TestConvex<typeof schema>,
  bossEmail: string,
  fields: Partial<Pick<Doc<'agents'>, 'name' | 'arm' | 'userId'>> = {},
): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
        ...fields,
      }),
  );
}

describe('agents.managerStanding (D17)', (): void => {
  it("answers you for the owner's own address, in an older row's spelling too", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, 'Boss@Day0.local');
    await expect(
      harness.withIdentity(managerIdentity()).query(api.agents.managerStanding, { agentId }),
    ).resolves.toEqual({ standing: 'you' });
  });

  it('answers other with the address an employee reports to that is not the owner’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, 'Ana@Kestrel.example');
    await expect(
      harness.withIdentity(managerIdentity()).query(api.agents.managerStanding, { agentId }),
    ).resolves.toEqual({ standing: 'other', bossEmail: 'Ana@Kestrel.example' });
  });

  it('answers unverified for an owner whose sign-in asserts no verified address', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, MANAGER_ADDRESS);
    for (const claims of [{ emailVerified: false }, { email: undefined }]) {
      await expect(
        harness
          .withIdentity(managerIdentity('owner', claims))
          .query(api.agents.managerStanding, { agentId }),
      ).resolves.toEqual({ standing: 'unverified' });
    }
  });

  it('answers evaluation for an evaluation employee, never other', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, 'eval-day0-r1-1758150000000@day0.local', {
      name: 'Day0 evaluation 1',
    });
    await expect(
      harness.withIdentity(managerIdentity()).query(api.agents.managerStanding, { agentId }),
    ).resolves.toEqual({ standing: 'evaluation' });
  });

  it('refuses a caller who does not own the employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, 'Ana@Kestrel.example');
    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .query(api.agents.managerStanding, { agentId }),
    ).rejects.toThrow('forbidden');
    await expect(harness.query(api.agents.managerStanding, { agentId })).rejects.toThrow();
  });
});

describe('agents.employeesReportingElsewhere (the home line, D17)', (): void => {
  it("counts the owner's company employees whose address is not the owner's", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedReportingTo(harness, 'Boss@Day0.local');
    await seedReportingTo(harness, 'ana@kestrel.example', { name: 'Tomas' });
    await seedReportingTo(harness, 'lee@kestrel.example', { name: 'Aiko' });
    await seedReportingTo(harness, 'eval-day0-r1-1758150000000@day0.local', {
      name: 'Day0 evaluation 1',
    });
    await seedReportingTo(harness, 'ana@kestrel.example', { userId: 'colleague' });
    await expect(
      harness.withIdentity(managerIdentity()).query(api.agents.employeesReportingElsewhere, {}),
    ).resolves.toBe(2);
  });

  it('answers null when there is no verified address to compare with', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedReportingTo(harness, 'ana@kestrel.example');
    await expect(
      harness
        .withIdentity(managerIdentity('owner', { emailVerified: false }))
        .query(api.agents.employeesReportingElsewhere, {}),
    ).resolves.toBeNull();
    await expect(harness.query(api.agents.employeesReportingElsewhere, {})).resolves.toBeNull();
  });
});

describe('agents.adoptManagerAddress (Make it you, D17)', (): void => {
  /** The `manager.changed` payloads of one employee, in write order. */
  async function managerChanges(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
  ): Promise<unknown[]> {
    return await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect()
      )
        .filter((event) => event.type === 'manager.changed')
        .map((event) => event.payload),
    );
  }

  it("makes the owner's verified address the employee's, with an event, and probes nothing in mock mode", async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, 'Ana@Kestrel.example');
    const owner = harness.withIdentity(managerIdentity('owner', { email: ' Lead@Day0.local ' }));
    await expect(owner.mutation(api.agents.adoptManagerAddress, { agentId })).resolves.toEqual({
      changed: true,
      reprobed: 0,
    });
    await expect(owner.query(api.agents.managerStanding, { agentId })).resolves.toEqual({
      standing: 'you',
    });
    const agent = await harness.run(async (ctx) => await ctx.db.get(agentId));
    expect(agent?.bossEmail).toBe('lead@day0.local');
    await expect(managerChanges(harness, agentId)).resolves.toEqual([
      { via: 'adopted', bossEmail: 'lead@day0.local' },
    ]);
  });

  it("writes nothing for an employee that already reports to the owner's address", async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, 'Boss@Day0.local');
    await expect(
      harness.withIdentity(managerIdentity()).mutation(api.agents.adoptManagerAddress, { agentId }),
    ).resolves.toEqual({ changed: false, reprobed: 0 });
    const agent = await harness.run(async (ctx) => await ctx.db.get(agentId));
    expect(agent?.bossEmail).toBe('Boss@Day0.local');
    await expect(managerChanges(harness, agentId)).resolves.toEqual([]);
  });

  it('refuses another owner, an unverified sign-in and an evaluation employee, and writes nothing', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, 'ana@kestrel.example');
    const evaluationId = await seedReportingTo(harness, 'eval-day0-r1-1758150000000@day0.local', {
      name: 'Day0 evaluation 1',
    });
    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .mutation(api.agents.adoptManagerAddress, { agentId }),
    ).rejects.toThrow('forbidden');
    await expect(
      harness
        .withIdentity(managerIdentity('owner', { emailVerified: false }))
        .mutation(api.agents.adoptManagerAddress, { agentId }),
    ).rejects.toThrow(UNVERIFIED_FOR_ADOPTION);
    await expect(
      harness
        .withIdentity(managerIdentity())
        .mutation(api.agents.adoptManagerAddress, { agentId: evaluationId }),
    ).rejects.toThrow(EVALUATION_ADDRESS_FIXED);
    const rows = await harness.run(async (ctx) => await ctx.db.query('agents').collect());
    expect(rows.map((row) => row.bossEmail)).toEqual([
      'ana@kestrel.example',
      'eval-day0-r1-1758150000000@day0.local',
    ]);
    await expect(managerChanges(harness, agentId)).resolves.toEqual([]);
  });

  it('in real mode re-probes the chat surfaces and re-sends the open request to the owner', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('real');
    const { api: realApi, internal: realInternal } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedReportingTo(harness, 'ana@kestrel.example');
    const { slackId, linearId, workItemId } = await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'team chat token',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
      const slackId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        endpoint: 'https://slack.com/api/',
        path: 'documented-api',
        toolAllowlist: ['chat.postMessage'],
        toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
        managerDmChannelId: 'D0ANA',
        managerUserId: 'UANA',
        credentialId,
        credentialLanded: true,
        managerApprovedAt: 10,
        lastVerifiedAt: 10,
        whereFound: [],
        createdAt: 1,
      });
      const linearId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        endpoint: 'https://mcp.linear.app/mcp',
        path: 'mcp',
        credentialId,
        credentialLanded: true,
        managerApprovedAt: 10,
        whereFound: [],
        createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Add the close-summary audit note',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'plan-pending',
        plan: { summary: 'Comment then close.', steps: ['comment', 'close'] },
        observedAt: 1,
        createdAt: 1,
      });
      return { slackId, linearId, workItemId };
    });
    // The plan's request, delivered to Ana's DM before the owner made the address theirs.
    await harness.mutation(realInternal.work.prepareDecisionRequest, {
      workItemId,
      kind: 'plan',
      decisionId: 'ab3xyz',
    });
    await harness.mutation(realInternal.work.recordDecisionRequest, {
      workItemId,
      decisionId: 'ab3xyz',
      ts: '1787746453.000100',
    });

    const owner = harness.withIdentity(managerIdentity());
    await expect(owner.mutation(realApi.agents.adoptManagerAddress, { agentId })).resolves.toEqual({
      changed: true,
      reprobed: 1,
    });
    const probes = await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect())
        .filter((job) => job.name === 'surfaceActions:probeInternal')
        .map((job) => (job.args[0] as { surfaceId: Id<'surfaces'> }).surfaceId),
    );
    expect(probes).toEqual([slackId]);
    expect(probes).not.toContain(linearId);

    // The scheduled probe looks the owner's address up and lands the owner's own DM.
    const probe = await harness.mutation(realInternal.surfaces.beginProbe, { surfaceId: slackId });
    if (!probe.reserved) throw new Error('probe was not reserved');
    await harness.mutation(realInternal.surfaces.recordConnected, {
      surfaceId: slackId,
      generation: probe.generation,
      toolAllowlist: ['chat.postMessage'],
      toolArguments: [{ tool: 'chat.postMessage', arguments: ['channel', 'text'] }],
      managerDmChannelId: 'D0OWNER',
      managerUserId: 'UOWNER',
      verifiedAt: Date.now(),
    });
    const item = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(item?.decision).toMatchObject({
      id: 'ab3xyz',
      requestFailure: MANAGER_CHANGED_RESEND_REASON,
    });
    await expect(
      harness.mutation(realInternal.work.prepareDecisionRequest, {
        workItemId,
        kind: 'plan',
        decisionId: 'cd4uvw',
        supersedes: 'ab3xyz',
      }),
    ).resolves.toMatchObject({ prepared: true, surface: { managerDmChannelId: 'D0OWNER' } });
    await expect(managerChanges(harness, agentId)).resolves.toEqual([
      { via: 'adopted', bossEmail: MANAGER_ADDRESS },
      { surfaceId: slackId, via: 'probe', previousManagerUserId: 'UANA', managerUserId: 'UOWNER' },
    ]);
  });
});

describe("the module's runtime imports", (): void => {
  it('never lead back to the module, so its initialisation order does not depend on load order (m25)', (): void => {
    expect(runtimeCycleThrough('convex/agents.ts')).toBeNull();
  });
});

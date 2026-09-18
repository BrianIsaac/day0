import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { clipRoleLine } from '../../convex/agents';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { autonomousActionsOn } from '../../src/work/autonomy';
import { evaluateCandidate, type EvalContext } from '../../src/work/evaluate';
import type { WorkCandidate } from '../../src/work/types';
import { asAgentId } from '../../src/lib/ids';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';

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
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.agents.deploy, {
        bossEmail: 'boss@day0.local',
        name: 'foreign source test',
        excludedDocSourceIds: [sourceId],
      }),
    ).rejects.toThrow('owned by another user');
  });

  it('persists an owned exclusion and drops an empty one', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedSource(harness, 'owner', 'Team docs');
    const owner = harness.withIdentity({ subject: 'owner' });
    const excluding = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
      name: 'excluding',
      excludedDocSourceIds: [sourceId],
    });
    await expect(owner.query(api.agents.get, { agentId: excluding })).resolves.toMatchObject({
      excludedDocSourceIds: [sourceId],
    });
    const inheriting = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
      name: 'inheriting',
      excludedDocSourceIds: [],
    });
    const row = await owner.query(api.agents.get, { agentId: inheriting });
    expect(row?.excludedDocSourceIds).toBeUndefined();
    expect(row?.docSourceIds).toBeUndefined();
  });

  it('inherits a source linked after deploy unless it was excluded', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const existing = await seedSource(harness, 'owner', 'Existing');
    const excluded = await seedSource(harness, 'owner', 'Excluded');
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
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
    const owner = harness.withIdentity({ subject: 'owner' });

    const day0Id = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
    });
    const baselineId = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
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

describe('agent surface grants', (): void => {
  it('lets a slot-2 Slack action candidate reach needs-skill under deployed mock grants', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'mock-owner' });
    const agentId = await owner.mutation(api.agents.deploy, { bossEmail: 'mock@day0.local' });
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
      hasGrantForScope: async (scope) => grants.some((grant) => grant.scope === scope && grant.active),
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
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(realApi.agents.deploy, { bossEmail: 'boss@day0.local', arm: 'baseline' }),
    ).rejects.toThrow('mock mode');
    await expect(
      owner.mutation(realApi.agents.deploy, { bossEmail: 'boss@day0.local', arm: 'day0' }),
    ).resolves.toBeTruthy();
    const agents = await harness.run(async (ctx) => await ctx.db.query('agents').collect());
    expect(agents.map((agent) => agent.arm)).toEqual(['day0']);
  });

  it('seeds provider grants in mock mode but only baseline grants in real mode', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('mock');
    const mockHarness = convexTest(schema, allConvexModules());
    const mockAgent = await mockHarness
      .withIdentity({ subject: 'mock-owner' })
      .mutation(api.agents.deploy, { bossEmail: 'mock@day0.local' });
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
      .withIdentity({ subject: 'real-owner' })
      .mutation(api.agents.deploy, { bossEmail: 'real@day0.local' });
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
    expect(realRow?.posture).toBeUndefined();
    expect(autonomousActionsOn(realRow ?? {})).toBe(false);
  });

  it('grants an active scope idempotently and replaces a revoked grant', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
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
        bossEmail: 'boss@day0.local',
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
      harness.withIdentity({ subject: 'intruder' }).mutation(api.agents.revokeScope, {
        agentId,
        scope: 'linear:read',
      }),
    ).rejects.toThrow('forbidden');
    const owner = harness.withIdentity({ subject: 'owner' });
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
        bossEmail: 'boss@day0.local',
        name: 'mine',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const b = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
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
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.agents.revokeScope, { agentId: mine, scope: 'linear:read' }),
    ).resolves.toEqual({ revoked: 0 });
    const grants = await harness.run(async (ctx) => await ctx.db.query('permissionGrants').collect());
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
        bossEmail: 'boss@day0.local',
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
    const owner = harness.withIdentity({ subject: 'owner' });
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
    const grants = await harness.run(async (ctx) => await ctx.db.query('permissionGrants').collect());
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
          bossEmail: 'boss@day0.local',
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await expect(
      harness
        .withIdentity({ subject: 'intruder' })
        .mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).rejects.toThrow('forbidden');
    await expect(
      harness.mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).rejects.toThrow();
    const owner = harness.withIdentity({ subject: 'owner' });
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
          bossEmail: 'boss@day0.local',
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await expect(
      harness
        .withIdentity({ subject: 'owner' })
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
          bossEmail: 'boss@day0.local',
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await expect(
      harness
        .withIdentity({ subject: 'intruder' })
        .mutation(api.agents.setManagerNotifications, { agentId, mode: 'digest' }),
    ).rejects.toThrow('forbidden');
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.mutation(api.agents.setManagerNotifications, { agentId, mode: 'per-run' })).resolves.toEqual({
      ok: true,
      managerNotifications: 'per-run',
      changed: false,
    });
    await expect(owner.mutation(api.agents.setManagerNotifications, { agentId, mode: 'digest' })).resolves.toEqual({
      ok: true,
      managerNotifications: 'digest',
      changed: true,
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(agentId)))?.managerNotifications).toBe('digest');
    const changes = (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
      (event) => event.type === 'agent.notifications-changed',
    );
    expect(changes.map((event) => event.payload)).toEqual([{ from: 'per-run', to: 'digest', reason: 'set by the manager' }]);
  });

});

type Harness = TestConvex<typeof schema>;

/**
 * Deploy one employee through the public mutation, as the landing page does.
 *
 * Args:
 *   harness: Convex test harness.
 *   subject: Owner subject the deploy runs as.
 *   name: Display name, also the avatar id's suffix.
 *   options: Boss address and documentation exclusions, when not the default.
 *
 * Returns:
 *   The new agent id.
 */
async function deployEmployee(
  harness: Harness,
  subject: string,
  name: string,
  options: { bossEmail?: string; excludedDocSourceIds?: Id<'docSources'>[] } = {},
): Promise<Id<'agents'>> {
  return await harness.withIdentity({ subject }).mutation(api.agents.deploy, {
    bossEmail: options.bossEmail ?? 'boss@day0.local',
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

describe('the employee roster', (): void => {
  it('does not mistake an ordinary employee for a trial because of the manager address', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const ordinary = await deployEmployee(harness, 'owner', 'Evaluation coordinator', {
      bossEmail: 'eval-payroll@day0.local',
    });
    await deployEmployee(harness, 'owner', 'Day0 revocation evaluation', {
      bossEmail: 'eval-revocation-2026-09-18t07-00-00z@day0.local',
    });
    await deployEmployee(harness, 'owner', 'Day0 evaluation 1', {
      bossEmail: 'eval-day0-r1-1758150000000@day0.local',
    });

    expect((await owner.query(api.agents.rosterForUser, {})).map((row) => row.agentId)).toEqual([
      ordinary,
    ]);
  });

  it('does not let a caller with an empty subject read malformed owner rows', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Malformed owner',
        userId: '',
        state: 'deployed',
        createdAt: 1,
      });
    });
    await expect(
      harness.withIdentity({ subject: '' }).query(api.agents.rosterForUser, {}),
    ).resolves.toEqual([]);
  });

  it('shows each of the owner\'s employees with its role, open work, what needs the manager and its autonomy, and nobody else', async (): Promise<void> => {
    useSurfaceMode('real');
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
      bossEmail: 'eval-revocation-2026-09-18t07-00-00z@day0.local',
    });
    await deployEmployee(harness, 'owner', 'Day0 evaluation 1', {
      bossEmail: 'eval-day0-r1-1758150000000@day0.local',
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
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
    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.agents.setAutonomousActions, { agentId: mateo, on: true });

    await expect(owner.query(api.agents.rosterForUser, {})).resolves.toEqual([
      {
        agentId: aiko,
        name: 'Aiko',
        avatarId: 'avatar-aiko',
        state: 'charter-pending',
        autonomous: false,
        roleLine: 'charter pending',
        openCount: 0,
        needsYou: 0,
        docSourceCount: 1,
      },
      {
        agentId: mateo,
        name: 'Mateo',
        avatarId: 'avatar-mateo',
        state: 'active',
        autonomous: true,
        roleLine: 'Close the month for the finance team.',
        openCount: 3,
        needsYou: 1,
        docSourceCount: 2,
      },
      {
        agentId: priya,
        name: 'Priya',
        avatarId: 'avatar-priya',
        state: 'active',
        autonomous: false,
        roleLine:
          'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps\u2026',
        openCount: 3,
        needsYou: 2,
        docSourceCount: 2,
      },
    ]);
    await expect(
      harness.withIdentity({ subject: 'stranger' }).query(api.agents.rosterForUser, {}),
    ).resolves.toEqual([
      {
        agentId: stranger,
        name: 'Somebody else',
        avatarId: 'avatar-somebody else',
        state: 'deployed',
        autonomous: false,
        roleLine: 'charter pending',
        openCount: 1,
        needsYou: 1,
        docSourceCount: 1,
      },
    ]);
    await expect(harness.query(api.agents.rosterForUser, {})).resolves.toEqual([]);
  });

  it('reads the charter the manager approved: an amendment at once, never a draft, and pending again after a draft is sent back', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
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

  it('lists at most 20 employees, newest first, and an evaluation agent never takes a place', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const employees: Id<'agents'>[] = [];
    for (let index = 1; index <= 21; index += 1) {
      employees.push(await deployEmployee(harness, 'owner', `Employee ${index}`));
    }
    for (let index = 1; index <= 3; index += 1) {
      await deployEmployee(harness, 'owner', 'Day0 revocation evaluation', {
        bossEmail: `eval-revocation-2026-09-18t07-00-0${index}z@day0.local`,
      });
    }

    const roster = await harness
      .withIdentity({ subject: 'owner' })
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
            bossEmail: 'boss@day0.local',
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

    const owner = harness.withIdentity({ subject: 'owner' });
    const roster = await owner.query(api.agents.rosterForUser, {});
    expect(roster).toHaveLength(20);
    expect(roster.map((row) => [row.openCount, row.needsYou])).toEqual(
      Array.from({ length: 20 }, () => [5, 2]),
    );
    expect(roster.find((row) => row.agentId === employees[0])?.docSourceCount).toBe(99);
    expect(roster.filter((row) => row.agentId !== employees[0]).every((row) => row.docSourceCount === 100)).toBe(true);

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
      ['  Close the month,\n every month,   for the finance team. ', 'Close the month, every month, for the finance team.'],
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
});

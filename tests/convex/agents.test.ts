import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { autonomousActionsOn } from '../../src/work/autonomy';

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

describe('agent surface grants', (): void => {
  it('seeds provider grants in mock mode but only baseline grants in real mode', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('mock');
    const mockHarness = convexTest(schema, allConvexModules());
    const mockAgent = await mockHarness.withIdentity({ subject: 'mock-owner' }).mutation(
      api.agents.deploy,
      { bossEmail: 'mock@day0.local' },
    );
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
      'social:read',
      'spreadsheet:read',
      'ticket:read',
    ]);

    useSurfaceMode('real');
    const realHarness = convexTest(schema, allConvexModules());
    const realAgent = await realHarness.withIdentity({ subject: 'real-owner' }).mutation(
      api.agents.deploy,
      { bossEmail: 'real@day0.local' },
    );
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
    await harness.run(
      async (ctx): Promise<void> => {
        await ctx.db.insert('permissionGrants', {
          agentId,
          scope: 'linear:read',
          createdAt: 1,
          revokedAt: 2,
        });
      },
    );
    await expect(
      harness.mutation(internal.agents.grantScope, { agentId, scope: 'linear:read' }),
    ).resolves.toEqual({ added: true });
    await expect(
      harness.mutation(internal.agents.grantScope, { agentId, scope: 'linear:read' }),
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
      harness.withIdentity({ subject: 'intruder' }).mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).rejects.toThrow('forbidden');
    await expect(harness.mutation(api.agents.setAutonomousActions, { agentId, on: true })).rejects.toThrow();
    const owner = harness.withIdentity({ subject: 'owner' });
    // Off is what an absent field already is, so setting it records nothing.
    await expect(owner.mutation(api.agents.setAutonomousActions, { agentId, on: false })).resolves.toEqual({
      ok: true,
      autonomousActions: false,
      changed: false,
    });
    await expect(owner.mutation(api.agents.setAutonomousActions, { agentId, on: true })).resolves.toEqual({
      ok: true,
      autonomousActions: true,
      changed: true,
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(agentId)))?.autonomousActions).toBe(true);
    await expect(owner.mutation(api.agents.setAutonomousActions, { agentId, on: true })).resolves.toEqual({
      ok: true,
      autonomousActions: true,
      changed: false,
    });
    await expect(owner.mutation(api.agents.setAutonomousActions, { agentId, on: false })).resolves.toEqual({
      ok: true,
      autonomousActions: false,
      changed: true,
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(agentId)))?.autonomousActions).toBe(false);
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
      harness.withIdentity({ subject: 'owner' }).mutation(api.agents.setAutonomousActions, { agentId, on: true }),
    ).rejects.toThrow('Autonomous actions is a local real-mode feature; this deployment runs in mock mode.');
    await expect(harness.mutation(api.agents.setAutonomousActions, { agentId, on: true })).rejects.toThrow(
      'local real-mode feature',
    );
    expect((await harness.run(async (ctx) => await ctx.db.get(agentId)))?.autonomousActions).toBeUndefined();
    expect(await harness.run(async (ctx) => await ctx.db.query('events').collect())).toEqual([]);
  });
});

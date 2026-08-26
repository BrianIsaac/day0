import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

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
    const realRow = await realHarness.run(async (ctx) => await ctx.db.get(realAgent));
    expect(realRow?.posture).toBe('cold-start');
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

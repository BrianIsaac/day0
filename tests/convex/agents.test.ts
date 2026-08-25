import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { convexModules } from './modules';

afterEach((): void => {
  vi.useRealTimers();
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
    const harness = convexTest(schema, convexModules);
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
    const harness = convexTest(schema, convexModules);
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
    const harness = convexTest(schema, convexModules);
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

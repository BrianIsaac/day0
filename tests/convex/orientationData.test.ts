import { convexTest, type TestConvex } from 'convex-test';
import type { GenericId } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { isReprobeCandidate } from '../../convex/orientationData';
import { allConvexModules } from './all-modules';

/**
 * Seed one owner-level source with a single page.
 *
 * Args:
 *   harness: Convex test harness.
 *   userId: Owner subject.
 *   label: Source label, also used as the page ref.
 *
 * Returns:
 *   The source id.
 */
async function seedSource(
  harness: TestConvex<typeof schema>,
  userId: string,
  label: string,
): Promise<Id<'docSources'>> {
  return await harness.run(async (ctx): Promise<Id<'docSources'>> => {
    const sourceId = await ctx.db.insert('docSources', {
      userId,
      label,
      kind: 'folder',
      locator: label.toLowerCase(),
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: `${label.toLowerCase()}.md`,
      title: label,
      markdown: `# ${label}`,
      updatedAt: 1,
    });
    return sourceId;
  });
}

describe('orientation data boundary', (): void => {
  it('returns only the pages the agent inherits from its owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const kept = await seedSource(harness, 'owner', 'Kept');
    const excluded = await seedSource(harness, 'owner', 'Excluded');
    await seedSource(harness, 'other-owner', 'Foreign');
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'orientation data test',
          userId: 'owner',
          excludedDocSourceIds: [excluded],
          state: 'active',
          createdAt: 1,
        }),
    );
    const pages = await harness.query(internal.orientationData.pagesForAgent, { agentId });
    expect(pages.map((page): string => page.ref)).toEqual(['kept.md']);
    expect(pages[0].sourceId).toBe(kept);
  });

  it('returns nothing for an agent without an owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedSource(harness, 'owner', 'Kept');
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'legacy agent',
          state: 'active',
          createdAt: 1,
        }),
    );
    await expect(
      harness.query(internal.orientationData.pagesForAgent, { agentId }),
    ).resolves.toEqual([]);
  });

  it('returns only the surfaces of the requested agent', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [mine, theirs] = await harness.run(async (ctx): Promise<Id<'agents'>[]> => {
      const ids: Id<'agents'>[] = [];
      for (const name of ['mine', 'theirs']) {
        ids.push(
          await ctx.db.insert('agents', {
            bossEmail: 'boss@day0.local',
            name,
            userId: name,
            state: 'active',
            createdAt: 1,
          }),
        );
      }
      return ids;
    });
    for (const [agentId, name] of [
      [mine, 'Linear'],
      [theirs, 'Slack'],
    ] as const) {
      await harness.mutation(internal.surfaces.seedFromCharter, {
        agentId,
        namedSystems: [{ name, class: 'kanban', whereMentioned: `${name} named.` }],
      });
    }
    const surfaces = await harness.query(internal.orientationData.surfacesForAgent, {
      agentId: mine,
    });
    expect(surfaces.map((surface): string => surface.slug)).toEqual(['linear']);
    await expect(
      harness.query(internal.orientationData.surfaceForOrientation, {
        surfaceId: surfaces[0]._id,
      }),
    ).resolves.toMatchObject({
      surface: { _id: surfaces[0]._id, agentId: mine },
      agent: { _id: mine, userId: 'mine' },
    });
  });

  it('re-probes connected rows and dead rows that still hold a credential and both approvals', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 're-probe test',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [
        { name: 'Linear', class: 'kanban', whereMentioned: 'Linear.' },
        { name: 'Slack', class: 'chat', whereMentioned: 'Slack.' },
        { name: 'Jira', class: 'kanban', whereMentioned: 'Jira.' },
        { name: 'Asana', class: 'kanban', whereMentioned: 'Asana.' },
      ],
    });
    const surfaces = await harness.query(internal.orientationData.surfacesForAgent, { agentId });
    const bySlug = Object.fromEntries(
      surfaces.map((surface): [string, Doc<'surfaces'>] => [surface.slug, surface]),
    );
    const credentialId = '10000credentials' as GenericId<'credentials'>;
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(bySlug.linear._id, { verdict: 'connected', credentialLanded: true });
      // Dead after a transient failure, still approved and still holding a credential: retried.
      await ctx.db.patch(bySlug.jira._id, {
        verdict: 'listed-dead',
        credentialId,
        managerApprovedAt: 1,
        itApprovedAt: 2,
      });
      // Dead but rejected since (no stamps): not retried.
      await ctx.db.patch(bySlug.asana._id, { verdict: 'listed-dead', credentialId });
      // No credential at all: nothing to retry until one lands.
      await ctx.db.patch(bySlug.slack._id, {
        verdict: 'ungranted',
        managerApprovedAt: 1,
        itApprovedAt: 2,
      });
    });
    const candidates = await harness.query(internal.orientationData.reprobeCandidates, {});
    expect(candidates.map((surface): string => surface.slug).sort()).toEqual(['jira', 'linear']);
    expect(isReprobeCandidate({ ...bySlug.slack, verdict: 'approved' })).toBe(false);
  });

  it('returns all agent surfaces to the deployment-local intake sweep', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentIds = await harness.run(
      async (ctx): Promise<Id<'agents'>[]> =>
        await Promise.all(
          ['first', 'second'].map(
            async (name: string): Promise<Id<'agents'>> =>
              await ctx.db.insert('agents', {
                bossEmail: `${name}@day0.local`,
                name,
                userId: name,
                state: 'active',
                createdAt: 1,
              }),
          ),
        ),
    );
    await Promise.all(
      agentIds.map(
        async (agentId: Id<'agents'>, index: number): Promise<Id<'surfaces'>[]> =>
          await harness.mutation(internal.surfaces.seedFromCharter, {
            agentId,
            namedSystems: [
              {
                name: index === 0 ? 'Linear' : 'Slack',
                class: index === 0 ? 'kanban' : 'chat',
                whereMentioned: 'Named for intake.',
              },
            ],
          }),
      ),
    );

    const surfaces = await harness.query(internal.orientationData.surfacesForIntake, {});
    expect(surfaces.map((surface): string => surface.slug).sort()).toEqual(['linear', 'slack']);
    expect(new Set(surfaces.map((surface): Id<'agents'> => surface.agentId))).toEqual(
      new Set(agentIds),
    );
  });
});

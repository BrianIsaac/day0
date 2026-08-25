import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { convexModules } from './modules';

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
  return await harness.run(async (ctx) => {
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
    const harness = convexTest(schema, convexModules);
    const kept = await seedSource(harness, 'owner', 'Kept');
    const excluded = await seedSource(harness, 'owner', 'Excluded');
    await seedSource(harness, 'other-owner', 'Foreign');
    const agentId = await harness.run(
      async (ctx) =>
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
    expect(pages.map((page) => page.ref)).toEqual(['kept.md']);
    expect(pages[0].sourceId).toBe(kept);
  });

  it('returns nothing for an agent without an owner', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    await seedSource(harness, 'owner', 'Kept');
    const agentId = await harness.run(
      async (ctx) =>
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
    const harness = convexTest(schema, convexModules);
    const [mine, theirs] = await harness.run(async (ctx) => {
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
    expect(surfaces.map((surface) => surface.slug)).toEqual(['linear']);
  });
});

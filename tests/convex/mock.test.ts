import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { convexModules } from './modules';

describe('mock documentation mirrors', (): void => {
  it('preserves source metadata when a page is upserted', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    const ids = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Team folder',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'mirror test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      return { sourceId, agentId };
    });
    const docId = await harness.mutation(internal.mock.upsertDoc, {
      agentId: ids.agentId,
      slug: 'source-onboarding',
      title: 'Onboarding',
      body: '# Onboarding',
      category: 'team-doc',
      sourceId: ids.sourceId,
      sourceRef: 'onboarding.md',
      sourceUrl: 'https://example.com/onboarding',
    });
    await expect(harness.run(async (ctx) => await ctx.db.get(docId))).resolves.toMatchObject({
      sourceId: ids.sourceId,
      sourceRef: 'onboarding.md',
      sourceUrl: 'https://example.com/onboarding',
    });
  });
});

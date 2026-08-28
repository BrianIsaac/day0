/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

/** Controllable discovery classifier boundary. */
const model = vi.hoisted(() => ({ calls: 0, error: undefined as Error | undefined }));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<{ systems: [] }> => {
    model.calls += 1;
    if (model.error) throw model.error;
    return { systems: [] };
  },
}));

beforeEach((): void => {
  model.calls = 0;
  model.error = undefined;
});

interface Seeded {
  sourceId: Id<'docSources'>;
  runId: Id<'docSyncRuns'>;
}

/**
 * Seed one completed generation with `pages` stored pages.
 *
 * Args:
 *   harness: convex-test harness.
 *   pages: How many pages the generation left behind.
 *
 * Returns:
 *   The source and the completed run discovery would read.
 */
async function seedGeneration(
  harness: TestConvex<typeof schema>,
  pages: number,
): Promise<Seeded> {
  return await harness.run(async (ctx): Promise<Seeded> => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Enterprise wiki',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      refs: [],
      credentialRefs: [],
      pageCount: pages,
      redactionCount: 0,
      state: 'completed',
      createdAt: 1,
      completedAt: 1,
    });
    await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
    for (let index = 0; index < pages; index += 1) {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: `page-${index}.md`,
        title: `Page ${index}`,
        markdown: `# Page ${index}`,
        updatedAt: 1,
      });
    }
    return { sourceId, runId };
  });
}

describe('the documentation discovery action', (): void => {
  it('records why an over-cap source was never read instead of failing silently', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness, 501);

    await expect(
      harness.action(internal.documentationDiscoveryActions.discoverSource, { sourceId, runId }),
    ).resolves.toMatchObject({
      applied: false,
      systems: 0,
      reason: expect.stringContaining('exceeds 500 pages'),
    });
    // The generation is not marked discovered, so the next completed sync
    // retries rather than treating this one as done.
    const failed = await harness.run(async (ctx) => await ctx.db.get(sourceId));
    expect(failed?.lastDiscoveryError).toContain('exceeds 500 pages');
    expect(failed?.lastDiscoverySyncId).toBeUndefined();
    expect(model.calls).toBe(0);
  });

  it('reads a generation inside the cap and stamps it discovered', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness, 1);

    await expect(
      harness.action(internal.documentationDiscoveryActions.discoverSource, { sourceId, runId }),
    ).resolves.toMatchObject({ applied: true, systems: 0 });
    const source = await harness.run(async (ctx) => await ctx.db.get(sourceId));
    expect(source?.lastDiscoverySyncId).toEqual(runId);
    expect(source?.lastDiscoveryError).toBeUndefined();
  });

  it('redacts provider credentials before making a discovery failure visible', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness, 1);
    const bearer = 'opaque-provider-secret-12345';
    const providerKey = 'sk-proj-ReviewValue0123456789';
    model.error = new Error(`Provider rejected Authorization: Bearer ${bearer} for ${providerKey}`);

    await expect(
      harness.action(internal.documentationDiscoveryActions.discoverSource, { sourceId, runId }),
    ).resolves.toMatchObject({ applied: false, systems: 0 });

    const source = await harness.run(async (ctx) => await ctx.db.get(sourceId));
    expect(source?.lastDiscoveryError).toContain('<redacted>');
    expect(source?.lastDiscoveryError).not.toContain(bearer);
    expect(source?.lastDiscoveryError).not.toContain(providerKey);
  });
});

/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

/** Controllable discovery classifier boundary. */
const model = vi.hoisted(() => ({
  calls: 0,
  error: undefined as Error | undefined,
  systems: [] as Array<{ name: string; class: 'chat'; pageRef: string }>,
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<{ systems: typeof model.systems }> => {
    model.calls += 1;
    if (model.error) throw model.error;
    return { systems: model.systems };
  },
}));

beforeEach((): void => {
  model.calls = 0;
  model.error = undefined;
  model.systems = [];
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
  it('converges a system table and its transport line before filing discoveries', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness, 0);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'onboarding.md',
        title: 'Revenue operations onboarding',
        markdown: [
          '| System | What it is for | Access owner |',
          '|---|---|---|',
          '| Slack | `#revops-asks` receives inbound requests. | Messaging administrator |',
        ].join('\n'),
        updatedAt: 1,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbooks/how-to-post-slack.md',
        title: 'How to post to Slack',
        markdown:
          'The approved transport is the Slack Web API over HTTPS at `https://slack.com/api/` with the bot token as a bearer.',
        updatedAt: 1,
      });
    });
    model.systems = [
      { name: 'Slack Web API', class: 'chat', pageRef: 'runbooks/how-to-post-slack.md' },
    ];

    await expect(
      harness.action(internal.documentationDiscoveryActions.discoverSource, { sourceId, runId }),
    ).resolves.toMatchObject({ applied: true, systems: 1 });
    const discoveries = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docSystemDiscoveries')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect(),
    );
    expect(discoveries.filter((row) => row.current).map((row) => row.displayName)).toEqual([
      'Slack',
    ]);
    expect(discoveries[0]).toMatchObject({
      slug: 'slack',
      mergedNames: ['Slack Web API'],
      evidence: [
        expect.objectContaining({ displayName: 'Slack', ref: 'onboarding.md' }),
        expect.objectContaining({
          displayName: 'Slack Web API',
          ref: 'runbooks/how-to-post-slack.md',
        }),
      ],
    });
  });

  it('does not turn an unattached transport line into a system', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await seedGeneration(harness, 0);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbooks/how-to-post-slack.md',
        title: 'How to post to Slack',
        markdown:
          'The approved transport is the Slack Web API over HTTPS at `https://slack.com/api/` with the bot token as a bearer.',
        updatedAt: 1,
      });
    });
    model.systems = [
      { name: 'Slack Web API', class: 'chat', pageRef: 'runbooks/how-to-post-slack.md' },
    ];

    await expect(
      harness.action(internal.documentationDiscoveryActions.discoverSource, { sourceId, runId }),
    ).resolves.toMatchObject({ applied: true, systems: 0 });
    const discoveries = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docSystemDiscoveries')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect(),
    );
    expect(discoveries).toEqual([]);
  });

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

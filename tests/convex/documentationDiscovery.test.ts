/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

interface SeededDiscovery {
  agentId: Id<'agents'>;
  sourceId: Id<'docSources'>;
  runId: Id<'docSyncRuns'>;
}

async function seedDiscovery(
  harness: TestConvex<typeof schema>,
  state: 'deployed' | 'active' = 'active',
): Promise<SeededDiscovery> {
  return await harness.run(async (ctx): Promise<SeededDiscovery> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'manager@day0.local',
      name: 'Discovery lifecycle',
      userId: 'owner',
      state,
      createdAt: 1,
    });
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Team folder',
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
      pageCount: 0,
      redactionCount: 0,
      state: 'completed',
      createdAt: 1,
      completedAt: 1,
    });
    await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
    return { agentId, sourceId, runId };
  });
}

async function nextRun(
  harness: TestConvex<typeof schema>,
  sourceId: Id<'docSources'>,
): Promise<Id<'docSyncRuns'>> {
  return await harness.run(async (ctx): Promise<Id<'docSyncRuns'>> => {
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      refs: [],
      credentialRefs: [],
      pageCount: 0,
      redactionCount: 0,
      state: 'completed',
      createdAt: 2,
      completedAt: 2,
    });
    await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
    return runId;
  });
}

const linear = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  ref: 'systems/linear.md',
  quote: '# Linear',
};

const northstar = {
  slug: 'northstar-crm',
  displayName: 'Northstar CRM',
  class: 'crm',
  ref: 'systems/northstar-crm.md',
  quote: '# Northstar CRM',
};

afterEach((): void => {
  vi.useRealTimers();
});

describe('documentation discovery lifecycle', (): void => {
  it('unions documentation with charter surfaces and records both origins once', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, runId } = await seedDiscovery(harness);
    await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [
        { name: 'Linear', class: 'kanban', whereMentioned: 'Work is tracked in Linear.' },
        { name: 'Team docs', class: 'docs', whereMentioned: 'Read the team docs.' },
      ],
    });

    await expect(
      harness.mutation(internal.documentationDiscovery.apply, {
        sourceId,
        runId,
        fingerprint: 'first',
        candidates: [linear, northstar, { ...linear, slug: 'docs', class: 'docs' }],
      }),
    ).resolves.toMatchObject({ applied: true, created: 1, updated: 1, scheduled: 1 });
    const rows = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (index) => index.eq('agentId', agentId))
          .collect(),
    );
    expect(rows.map((row) => row.slug).sort()).toEqual(['linear', 'northstar-crm']);
    expect(rows.find((row) => row.slug === 'linear')?.discoveryEvidence).toMatchObject([
      { kind: 'charter', quote: 'Work is tracked in Linear.', current: true },
      {
        kind: 'documentation',
        sourceId,
        ref: 'systems/linear.md',
        current: true,
      },
    ]);
  });

  it('backfills manager provenance on a legacy surface without seeding or orienting again', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, runId } = await seedDiscovery(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('charters', {
        agentId,
        version: 'v1',
        approved: true,
        approvedAt: 1,
        createdAt: 1,
        body: {
          namedSystems: [
            { name: 'Linear', class: 'kanban', whereMentioned: 'The manager named Linear.' },
          ],
        },
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        path: 'mcp',
        endpoint: 'https://mcp.linear.app/mcp',
        whereFound: [{ ref: 'legacy.md', quote: 'Linear MCP endpoint' }],
        credentialLanded: true,
        managerApprovedAt: 2,
        itApprovedAt: 3,
        lastVerifiedAt: 4,
        createdAt: 1,
      });
    });

    await expect(
      harness.mutation(internal.documentationDiscovery.apply, {
        sourceId,
        runId,
        fingerprint: 'first',
        candidates: [linear],
      }),
    ).resolves.toMatchObject({ applied: true, created: 0, updated: 1, scheduled: 0 });
    const row = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent_slug', (index) =>
            index.eq('agentId', agentId).eq('slug', 'linear'),
          )
          .unique(),
    );
    expect(row).toMatchObject({
      verdict: 'connected',
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
      managerApprovedAt: 2,
      itApprovedAt: 3,
      lastVerifiedAt: 4,
      discoveryEvidence: expect.arrayContaining([
        expect.objectContaining({
          kind: 'charter',
          quote: 'The manager named Linear.',
          current: true,
        }),
        expect.objectContaining({
          kind: 'documentation',
          sourceId,
          ref: 'systems/linear.md',
          current: true,
        }),
      ]),
    });
  });

  it('converges without duplicating or re-orienting an existing rejected row', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, runId } = await seedDiscovery(harness);
    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId,
      runId,
      fingerprint: 'first',
      candidates: [northstar],
    });
    await harness.run(async (ctx): Promise<void> => {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (index) =>
          index.eq('agentId', agentId).eq('slug', northstar.slug),
        )
        .unique();
      if (surface) await ctx.db.patch(surface._id, { verdict: 'declared', reason: 'Rejected.' });
    });
    const jobsBefore = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    const secondRun = await nextRun(harness, sourceId);
    await expect(
      harness.mutation(internal.documentationDiscovery.apply, {
        sourceId,
        runId: secondRun,
        fingerprint: 'second',
        candidates: [northstar],
      }),
    ).resolves.toMatchObject({ applied: true, created: 0, updated: 1, scheduled: 0 });
    const rows = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent_slug', (index) =>
            index.eq('agentId', agentId).eq('slug', northstar.slug),
          )
          .collect(),
    );
    const jobsAfter = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'declared', reason: 'Rejected.' });
    expect(jobsAfter).toHaveLength(jobsBefore.length);
  });

  it('updates page provenance after approval without changing approved authority', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, runId } = await seedDiscovery(harness);
    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId,
      runId,
      fingerprint: 'first',
      candidates: [northstar],
    });
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const surface = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (index) =>
          index.eq('agentId', agentId).eq('slug', northstar.slug),
        )
        .unique();
      if (!surface) throw new Error('surface missing');
      await ctx.db.patch(surface._id, {
        verdict: 'approved',
        path: 'documented-api',
        fallbackPath: 'escalate',
        endpoint: 'https://northstar.example.test/api',
        managerApprovedAt: 10,
        itApprovedAt: 11,
      });
      return surface._id;
    });
    const secondRun = await nextRun(harness, sourceId);
    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId,
      runId: secondRun,
      fingerprint: 'second',
      candidates: [
        {
          ...northstar,
          ref: 'systems/northstar-access.md',
          quote: '# Northstar CRM access',
        },
      ],
    });
    const row = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(row).toMatchObject({
      verdict: 'approved',
      path: 'documented-api',
      endpoint: 'https://northstar.example.test/api',
      managerApprovedAt: 10,
      itApprovedAt: 11,
      discoveryEvidence: [
        expect.objectContaining({
          kind: 'documentation',
          ref: 'systems/northstar-access.md',
          quote: '# Northstar CRM access',
          current: true,
        }),
      ],
    });
  });

  it('keeps a removed page as inactive provenance without deleting its surface', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, runId } = await seedDiscovery(harness, 'deployed');
    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId,
      runId,
      fingerprint: 'first',
      candidates: [northstar],
    });
    const secondRun = await nextRun(harness, sourceId);
    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId,
      runId: secondRun,
      fingerprint: 'second',
      candidates: [],
    });
    const rows = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (index) => index.eq('agentId', agentId))
          .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].discoveryEvidence).toMatchObject([
      { kind: 'documentation', current: false, ref: 'systems/northstar-crm.md' },
    ]);
  });
});

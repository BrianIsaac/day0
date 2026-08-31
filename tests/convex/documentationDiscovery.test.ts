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

const slack = {
  slug: 'slack',
  displayName: 'Slack',
  class: 'chat',
  ref: 'onboarding.md',
  quote: '| Slack | #revops-asks receives inbound requests. | Messaging administrator |',
};

const slackTransport = {
  slug: 'slack-web-api',
  displayName: 'Slack Web API',
  class: 'chat',
  ref: 'runbooks/how-to-post-slack.md',
  quote: 'The approved transport is the Slack Web API over HTTPS at https://slack.com/api/.',
};

const convergedSlack = {
  ...slack,
  evidence: [
    { displayName: slack.displayName, ref: slack.ref, quote: slack.quote },
    {
      displayName: slackTransport.displayName,
      ref: slackTransport.ref,
      quote: slackTransport.quote,
    },
  ],
  mergedNames: ['Slack Web API'],
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

  it('attaches an evidence-only transport from another source to the existing system', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, runId } = await seedDiscovery(harness, 'deployed');
    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId,
      runId,
      fingerprint: 'first',
      candidates: [slack],
    });
    const second = await harness.run(async (ctx): Promise<{
      sourceId: Id<'docSources'>;
      runId: Id<'docSyncRuns'>;
    }> => {
      const otherSourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Runbooks',
        kind: 'folder',
        locator: 'runbooks',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const otherRunId = await ctx.db.insert('docSyncRuns', {
        sourceId: otherSourceId,
        refs: [],
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
        state: 'completed',
        createdAt: 1,
        completedAt: 1,
      });
      await ctx.db.patch(otherSourceId, { lastCompletedSyncId: otherRunId });
      return { sourceId: otherSourceId, runId: otherRunId };
    });

    await expect(
      harness.mutation(internal.documentationDiscovery.apply, {
        sourceId: second.sourceId,
        runId: second.runId,
        fingerprint: 'first',
        candidates: [{ ...slackTransport, transportOnly: true }],
      }),
    ).resolves.toMatchObject({ applied: true, created: 0, updated: 1, scheduled: 0 });
    const surfaces = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (index) => index.eq('agentId', agentId))
          .collect(),
    );
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({
      slug: 'slack',
      displayName: 'Slack',
      discoveryEvidence: [
        expect.objectContaining({ sourceId, ref: 'onboarding.md', current: true }),
        expect.objectContaining({
          sourceId: second.sourceId,
          ref: 'runbooks/how-to-post-slack.md',
          current: true,
        }),
      ],
    });
  });

  it('retires a legacy duplicate discovery without changing either surface decision', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, runId } = await seedDiscovery(harness, 'deployed');
    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId,
      runId,
      fingerprint: 'legacy',
      candidates: [slack, slackTransport],
    });
    await harness.run(async (ctx): Promise<void> => {
      const surfaces = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .collect();
      const primary = surfaces.find((surface) => surface.slug === 'slack');
      const duplicate = surfaces.find((surface) => surface.slug === 'slack-web-api');
      if (!primary || !duplicate) throw new Error('legacy surfaces missing');
      await ctx.db.patch(primary._id, {
        verdict: 'approved',
        path: 'documented-api',
        endpoint: 'https://slack.com/api/',
        managerApprovedAt: 10,
        itApprovedAt: 11,
      });
      await ctx.db.patch(duplicate._id, { verdict: 'declared', reason: 'Rejected by operator.' });
    });

    const mergedRun = await nextRun(harness, sourceId);
    await expect(
      harness.mutation(internal.documentationDiscovery.apply, {
        sourceId,
        runId: mergedRun,
        fingerprint: 'merged',
        candidates: [convergedSlack],
      }),
    ).resolves.toMatchObject({ applied: true, created: 0, updated: 1, retired: 1, scheduled: 0 });
    const secondMergedRun = await nextRun(harness, sourceId);
    await expect(
      harness.mutation(internal.documentationDiscovery.apply, {
        sourceId,
        runId: secondMergedRun,
        fingerprint: 'merged-again',
        candidates: [convergedSlack],
      }),
    ).resolves.toMatchObject({ applied: true, created: 0, updated: 1, retired: 0, scheduled: 0 });

    const result = await harness.run(async (ctx) => ({
      discoveries: await ctx.db
        .query('docSystemDiscoveries')
        .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
        .collect(),
      surfaces: await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .collect(),
    }));
    expect(result.discoveries.filter((row) => row.current)).toMatchObject([
      {
        slug: 'slack',
        mergedNames: ['Slack Web API'],
        evidence: [
          expect.objectContaining({ ref: 'onboarding.md' }),
          expect.objectContaining({ ref: 'runbooks/how-to-post-slack.md' }),
        ],
      },
    ]);
    expect(result.discoveries.find((row) => row.slug === 'slack-web-api')?.current).toBe(false);
    expect(result.surfaces.find((surface) => surface.slug === 'slack')).toMatchObject({
      verdict: 'approved',
      endpoint: 'https://slack.com/api/',
      managerApprovedAt: 10,
      itApprovedAt: 11,
    });
    expect(result.surfaces.find((surface) => surface.slug === 'slack-web-api')).toMatchObject({
      verdict: 'declared',
      reason: 'Rejected by operator.',
      discoveryEvidence: [expect.objectContaining({ current: false })],
    });
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

  it('keeps one origin per source and retires only the source that stopped naming it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, sourceId, runId } = await seedDiscovery(harness);
    const second = await harness.run(async (ctx): Promise<{
      sourceId: Id<'docSources'>;
      runId: Id<'docSyncRuns'>;
    }> => {
      const otherSourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'RevOps handbook',
        kind: 'folder',
        locator: 'handbook',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const otherRunId = await ctx.db.insert('docSyncRuns', {
        sourceId: otherSourceId,
        refs: [],
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
        state: 'completed',
        createdAt: 1,
        completedAt: 1,
      });
      await ctx.db.patch(otherSourceId, { lastCompletedSyncId: otherRunId });
      return { sourceId: otherSourceId, runId: otherRunId };
    });

    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId,
      runId,
      fingerprint: 'first',
      candidates: [northstar],
    });
    await expect(
      harness.mutation(internal.documentationDiscovery.apply, {
        sourceId: second.sourceId,
        runId: second.runId,
        fingerprint: 'first',
        candidates: [{ ...northstar, ref: 'handbook/systems.md', quote: '| Northstar CRM | ... |' }],
      }),
      // One system, two origins, one surface.
    ).resolves.toMatchObject({ applied: true, created: 0, updated: 1, scheduled: 0 });

    const readSurface = async () =>
      await harness.run(
        async (ctx) =>
          await ctx.db
            .query('surfaces')
            .withIndex('by_agent_slug', (index) =>
              index.eq('agentId', agentId).eq('slug', 'northstar-crm'),
            )
            .unique(),
      );
    expect((await readSurface())?.discoveryEvidence).toMatchObject([
      { sourceId, ref: 'systems/northstar-crm.md', current: true },
      { sourceId: second.sourceId, ref: 'handbook/systems.md', current: true },
    ]);

    // The handbook stops naming it; the systems page still does, so the system
    // keeps a current origin and work naming it stays in scope.
    await harness.mutation(internal.documentationDiscovery.apply, {
      sourceId: second.sourceId,
      runId: await nextRun(harness, second.sourceId),
      fingerprint: 'second',
      candidates: [],
    });
    expect((await readSurface())?.discoveryEvidence).toMatchObject([
      { sourceId, current: true },
      { sourceId: second.sourceId, current: false },
    ]);
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

import { convexTest, type TestConvex } from 'convex-test';
import type { GenericId } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { backfillCharterProvenance, surfaceSlug } from '../../convex/surfaces';
import { BROWSER_DRIVER_ABSENT } from '../../src/surfaces/browser';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
  vi.unstubAllEnvs();
});

/**
 * Seed an owned agent for surface mutation tests.
 *
 * Args:
 *   harness: Convex test harness.
 *
 * Returns:
 *   The new agent id.
 */
async function seedAgent(harness: TestConvex<typeof schema>): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx): Promise<Id<'agents'>> =>
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'orientation test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      }),
  );
}

/**
 * Seed one declared surface for an agent.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: Owning agent.
 *   name: Manager-named system.
 *   systemClass: Charter class of the system.
 *
 * Returns:
 *   The declared surface id.
 */
async function seedDeclared(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
  name = 'Linear',
  systemClass = 'kanban',
): Promise<Id<'surfaces'>> {
  await harness.mutation(internal.surfaces.seedFromCharter, {
    agentId,
    namedSystems: [{ name, class: systemClass, whereMentioned: `Work is in ${name}.` }],
  });
  return await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
    const row = await ctx.db
      .query('surfaces')
      .withIndex('by_agent_slug', (index) =>
        index.eq('agentId', agentId).eq('slug', surfaceSlug(name)),
      )
      .unique();
    if (!row) throw new Error('surface was not seeded');
    return row._id;
  });
}

/**
 * Store a proposal for a surface as the orientation run would.
 *
 * Args:
 *   harness: Convex test harness.
 *   surfaceId: Surface to propose.
 */
async function propose(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
): Promise<void> {
  await harness.mutation(internal.surfaces.propose, {
    surfaceId,
    request: { target: { system: 'Linear' } },
    whereFound: [{ ref: 'runbook.md', quote: 'Use Linear MCP.' }],
    path: 'mcp',
    fallbackPath: 'escalate',
    endpoint: 'https://mcp.linear.app/mcp',
    credentialLocation: 'Linear automation / Access',
    expiresInDays: 30,
  });
}

/**
 * Read one surface row directly.
 *
 * Args:
 *   harness: Convex test harness.
 *   surfaceId: Surface id.
 *
 * Returns:
 *   The stored row.
 */
async function readSurface(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
): Promise<Doc<'surfaces'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
  if (!row) throw new Error('surface missing');
  return row;
}

/**
 * List the event types recorded so far.
 *
 * Args:
 *   harness: Convex test harness.
 *
 * Returns:
 *   Event types in insertion order.
 */
async function eventTypes(harness: TestConvex<typeof schema>): Promise<string[]> {
  return await harness.run(
    async (ctx): Promise<string[]> =>
      (await ctx.db.query('events').collect()).map((event): string => event.type),
  );
}

describe('surface persistence', (): void => {
  it('creates stable slugs from manager-named systems', (): void => {
    expect(surfaceSlug('Northstar CRM')).toBe('northstar-crm');
    expect(surfaceSlug(' Linear / REVOPS ')).toBe('linear-revops');
  });

  it('accepts and clears a legacy credentialRef row when orientation touches it', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await harness.run(
      async (ctx): Promise<Id<'surfaces'>> =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'declared',
          whereFound: [],
          credentialRef: 'LINEAR_API_KEY',
          credentialLanded: false,
          createdAt: 1,
        } as never),
    );

    await propose(harness, surfaceId);
    expect((await readSurface(harness, surfaceId)) as Record<string, unknown>).not.toHaveProperty(
      'credentialRef',
    );
  });

  it('seeds once and exposes rows only to the owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    await seedDeclared(harness, agentId);
    await seedDeclared(harness, agentId);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.query(api.surfaces.listForAgent, { agentId })).resolves.toHaveLength(1);
    await expect(
      harness
        .withIdentity({ subject: 'other-owner' })
        .query(api.surfaces.listForAgent, { agentId }),
    ).rejects.toThrow('forbidden');
  });

  it('never seeds a surface for a documentation location', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const ids = await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [
        { name: 'Notion', class: 'docs', whereMentioned: 'The handbook is in Notion.' },
        { name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' },
      ],
    });
    expect(ids).toHaveLength(1);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.query(api.surfaces.listForAgent, { agentId })).resolves.toMatchObject([
      { slug: 'linear', verdict: 'declared' },
    ]);
  });

  it('attaches the live Looker charter alias to the documented pipeline tile', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const sourceId = await harness.run(
      async (ctx): Promise<Id<'docSources'>> =>
        await ctx.db.insert('docSources', {
          userId: 'owner',
          label: 'RevOps handbook',
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const documented = [
      { slug: 'linear', displayName: 'Linear', class: 'kanban' },
      { slug: 'slack', displayName: 'Slack', class: 'chat' },
      { slug: 'northstar-crm', displayName: 'Northstar CRM', class: 'crm' },
      {
        slug: 'looker-pipeline-tile',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        endpoint: 'http://looker-tile:8080/',
      },
    ] as const;
    const tileId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      let tile: Id<'surfaces'> | undefined;
      for (const system of documented) {
        const id = await ctx.db.insert('surfaces', {
          agentId,
          slug: system.slug,
          displayName: system.displayName,
          class: system.class,
          verdict: 'declared',
          endpoint: 'endpoint' in system ? system.endpoint : undefined,
          whereFound: [
            {
              sourceId,
              ref: `systems/${system.slug}.md`,
              quote: `# ${system.displayName}`,
            },
          ],
          discoveryEvidence: [
            {
              kind: 'documentation',
              sourceId,
              ref: `systems/${system.slug}.md`,
              quote: `# ${system.displayName}`,
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          createdAt: 1,
        });
        if (system.slug === 'looker-pipeline-tile') tile = id;
      }
      if (!tile) throw new Error('tile surface missing');
      return tile;
    });
    const deferredItemId = await harness.run(
      async (ctx): Promise<Id<'workItems'>> =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-7',
          title: 'Refresh the Looker pipeline tile',
          contentSummary: '',
          contentRefs: [],
          observedAt: 1,
          state: 'deferred',
          verdict: {
            decision: 'defer',
            reason: 'awaiting-connection',
            missingSurface: 'looker',
          },
          createdAt: 1,
        }),
    );

    await expect(
      harness.mutation(internal.surfaces.seedFromCharter, {
        agentId,
        namedSystems: [
          {
            name: 'Looker',
            class: 'analytics',
            whereMentioned: 'Pipeline numbers are on the Looker tile, web UI only.',
          },
        ],
      }),
    ).resolves.toEqual([tileId]);

    const rows = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (index) => index.eq('agentId', agentId))
          .collect(),
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.slug)).not.toContain('looker');
    expect(rows.find((row) => row._id === tileId)?.discoveryEvidence).toEqual([
      expect.objectContaining({ kind: 'documentation', ref: 'systems/looker-pipeline-tile.md' }),
      expect.objectContaining({
        kind: 'charter',
        ref: 'manager 1:1',
        quote: 'Pipeline numbers are on the Looker tile, web UI only.',
        current: true,
      }),
    ]);
    await expect(harness.run(async (ctx) => await ctx.db.get(deferredItemId))).resolves.toMatchObject(
      { state: 'discovered' },
    );
  });

  it('mints a qualified charter mention beside the bare documented product', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const tileId = await harness.run(
      async (ctx): Promise<Id<'surfaces'>> =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'declared',
          endpoint: 'http://looker-tile:8080/',
          whereFound: [{ ref: 'systems/looker-pipeline-tile.md', quote: '# Looker pipeline tile' }],
          discoveryEvidence: [
            {
              kind: 'documentation',
              ref: 'systems/looker-pipeline-tile.md',
              quote: '# Looker pipeline tile',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          createdAt: 1,
        }),
    );

    const seeded = await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [
        {
          name: 'Looker Studio',
          class: 'analytics',
          whereMentioned: 'The board deck charts are built in Looker Studio.',
        },
      ],
    });

    const rows = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (index) => index.eq('agentId', agentId))
          .collect(),
    );
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).not.toBe(tileId);
    expect(rows.map((row) => row.slug).sort()).toEqual(['looker-pipeline-tile', 'looker-studio']);
    expect(rows.find((row) => row._id === tileId)?.discoveryEvidence).toHaveLength(1);
    expect(await eventTypes(harness)).not.toContain('surface.charter-match-ambiguous');
  });

  it('attaches a class-mismatched charter mention to the surface carrying its slug', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const slackId = await harness.run(
      async (ctx): Promise<Id<'surfaces'>> =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'slack',
          displayName: 'Slack',
          class: 'chat',
          verdict: 'declared',
          whereFound: [{ ref: 'onboarding.md', quote: '| Slack | #revops-asks |' }],
          discoveryEvidence: [
            {
              kind: 'documentation',
              ref: 'onboarding.md',
              quote: '| Slack | #revops-asks |',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          createdAt: 1,
        }),
    );

    await expect(
      harness.mutation(internal.surfaces.seedFromCharter, {
        agentId,
        namedSystems: [
          { name: 'Slack', class: 'social', whereMentioned: 'Asks come in on Slack.' },
        ],
      }),
    ).resolves.toEqual([slackId]);

    const rows = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent_slug', (index) => index.eq('agentId', agentId).eq('slug', 'slack'))
          .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.class).toBe('chat');
    expect(rows[0]?.discoveryEvidence?.map((item) => item.kind)).toEqual([
      'documentation',
      'charter',
    ]);
  });

  it('resolves a legacy charter alias onto the documented surface at backfill', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const { tileId, aliasId, workItemId } = await harness.run(
      async (
        ctx,
      ): Promise<{ tileId: Id<'surfaces'>; aliasId: Id<'surfaces'>; workItemId: Id<'workItems'> }> => {
        const tileId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'connected',
          path: 'browser-driven',
          endpoint: 'http://looker-tile:8080/',
          whereFound: [{ ref: 'systems/looker-pipeline-tile.md', quote: '# Looker pipeline tile' }],
          discoveryEvidence: [
            {
              kind: 'documentation',
              ref: 'systems/looker-pipeline-tile.md',
              quote: '- The Looker pipeline tile is reached through its web UI only, at `http://looker-tile:8080/`.',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: true,
          lastVerifiedAt: Date.now(),
          createdAt: 1,
        });
        const aliasId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker',
          displayName: 'Looker',
          class: 'analytics',
          verdict: 'declared',
          reason: 'Rejected by the operator.',
          whereFound: [{ ref: 'systems/looker-pipeline-tile.md', quote: '# Looker pipeline tile' }],
          discoveryEvidence: [
            {
              kind: 'charter',
              ref: 'manager 1:1',
              quote: 'Pipeline numbers are on the Looker tile, web UI only.',
              current: true,
              firstSeenAt: 2,
              lastSeenAt: 2,
            },
          ],
          credentialLanded: false,
          createdAt: 2,
        });
        const workItemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-7',
          title: 'Refresh the Looker pipeline tile',
          contentSummary: '',
          contentRefs: [],
          observedAt: 3,
          state: 'deferred',
          verdict: { decision: 'defer', reason: 'awaiting-connection', missingSurface: 'looker' },
          createdAt: 3,
        });
        return { tileId, aliasId, workItemId };
      },
    );
    const namedSystems = [
      {
        name: 'Looker',
        class: 'analytics',
        whereMentioned: 'Pipeline numbers are on the Looker tile, web UI only.',
      },
    ];

    const first = await harness.run(
      async (ctx): Promise<number> =>
        await backfillCharterProvenance(ctx, { agentId, namedSystems, now: 10 }),
    );
    const second = await harness.run(
      async (ctx): Promise<number> =>
        await backfillCharterProvenance(ctx, { agentId, namedSystems, now: 11 }),
    );

    const result = await harness.run(async (ctx) => ({
      tile: await ctx.db.get(tileId),
      alias: await ctx.db.get(aliasId),
      item: await ctx.db.get(workItemId),
    }));
    expect([first, second]).toEqual([1, 0]);
    expect(result.tile?.discoveryEvidence?.map((item) => item.kind)).toEqual([
      'documentation',
      'charter',
    ]);
    expect(result.alias).toMatchObject({ verdict: 'declared', reason: 'Rejected by the operator.' });
    expect(result.alias?.discoveryEvidence).toHaveLength(1);
    expect(result.item).toMatchObject({ state: 'discovered' });
    const types = await eventTypes(harness);
    expect(types).not.toContain('surface.charter-match-ambiguous');
    expect(types.filter((type) => type === 'work.requeued')).toHaveLength(1);
  });

  it('resolves a legacy charter alias onto the documented surface when the charter is re-seeded', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const tileId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const tileId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker-pipeline-tile',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        verdict: 'connected',
        endpoint: 'http://looker-tile:8080/',
        whereFound: [{ ref: 'systems/looker-pipeline-tile.md', quote: '# Looker pipeline tile' }],
        discoveryEvidence: [
          {
            kind: 'documentation',
            ref: 'systems/looker-pipeline-tile.md',
            quote: '# Looker pipeline tile',
            current: true,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        ],
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker',
        class: 'analytics',
        verdict: 'declared',
        reason: 'Rejected by the operator.',
        whereFound: [],
        discoveryEvidence: [
          {
            kind: 'charter',
            ref: 'manager 1:1',
            quote: 'Pipeline numbers are on the Looker tile, web UI only.',
            current: true,
            firstSeenAt: 2,
            lastSeenAt: 2,
          },
        ],
        credentialLanded: false,
        createdAt: 2,
      });
      return tileId;
    });

    await expect(
      harness.mutation(internal.surfaces.seedFromCharter, {
        agentId,
        namedSystems: [
          {
            name: 'Looker',
            class: 'analytics',
            whereMentioned: 'Pipeline numbers are on the Looker tile, web UI only.',
          },
        ],
      }),
    ).resolves.toEqual([tileId]);
    const rows = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (index) => index.eq('agentId', agentId))
          .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row._id === tileId)?.discoveryEvidence?.map((item) => item.kind)).toEqual(
      ['documentation', 'charter'],
    );
    expect(await eventTypes(harness)).not.toContain('surface.charter-match-ambiguous');
  });

  it('records an ambiguous hostless charter mention without minting or attaching', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    await harness.run(async (ctx): Promise<void> => {
      for (const system of [
        { slug: 'looker-sales-tile', displayName: 'Looker sales tile' },
        { slug: 'looker-finance-tile', displayName: 'Looker finance tile' },
      ]) {
        await ctx.db.insert('surfaces', {
          agentId,
          slug: system.slug,
          displayName: system.displayName,
          class: 'analytics',
          verdict: 'declared',
          whereFound: [{ ref: `${system.slug}.md`, quote: `# ${system.displayName}` }],
          discoveryEvidence: [
            {
              kind: 'documentation',
              ref: `${system.slug}.md`,
              quote: `# ${system.displayName}`,
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          createdAt: 1,
        });
      }
    });

    await expect(
      harness.mutation(internal.surfaces.seedFromCharter, {
        agentId,
        namedSystems: [
          {
            name: 'Looker',
            class: 'analytics',
            whereMentioned: 'Pipeline reporting is in Looker.',
          },
        ],
      }),
    ).resolves.toEqual([]);

    const result = await harness.run(async (ctx) => ({
      surfaces: await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .collect(),
      events: await ctx.db
        .query('events')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .collect(),
    }));
    expect(result.surfaces).toHaveLength(2);
    expect(result.surfaces.every((row) => row.discoveryEvidence?.length === 1)).toBe(true);
    expect(result.events).toMatchObject([
      {
        type: 'surface.charter-match-ambiguous',
        payload: {
          namedSystem: 'Looker',
          class: 'analytics',
          candidateSlugs: ['looker-finance-tile', 'looker-sales-tile'],
        },
      },
    ]);
  });

  it('records an explicit absence with its search terms', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId, 'Northstar CRM', 'crm');
    await harness.mutation(internal.surfaces.markAbsent, {
      surfaceId,
      searched: ['Northstar CRM', 'crm'],
      whereFound: [{ ref: 'systems/northstar-crm.md', quote: 'No approved surface.' }],
    });
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.query(api.surfaces.listForAgent, { agentId })).resolves.toMatchObject([
      {
        verdict: 'absent',
        reason: 'No approved surface found after searching: Northstar CRM, crm',
      },
    ]);
  });

  it('does not expose a stale connected browser row when the component is absent', async (): Promise<void> => {
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId, 'Looker', 'analytics');
    await harness.mutation(internal.surfaces.propose, {
      surfaceId,
      request: { target: { system: 'Looker' } },
      whereFound: [{ ref: 'looker.md', quote: 'Open the pipeline tile.' }],
      path: 'browser-driven',
      fallbackPath: 'escalate',
      endpoint: 'http://looker-tile:8080/',
      credentialLocation: 'No sign-in required',
      expiresInDays: 30,
    });
    await harness.mutation(internal.surfaces.setStatus, {
      surfaceId,
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
    });

    const owner = harness.withIdentity({ subject: 'owner' });
    for (const rows of [
      await owner.query(api.surfaces.listForAgent, { agentId }),
      await harness.query(internal.orientationData.surfacesForAgent, { agentId }),
    ]) {
      expect(rows).toMatchObject([
        {
          verdict: 'ungranted',
          credentialLanded: false,
          reason: expect.stringContaining(BROWSER_DRIVER_ABSENT),
        },
      ]);
    }
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'connected',
      credentialLanded: true,
    });
  });

  it('uses compare-and-set writes so an orientation retry cannot overwrite a decision', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await expect(
      harness.mutation(internal.surfaces.propose, {
        surfaceId,
        request: { target: { system: 'Linear' } },
        whereFound: [{ ref: 'linear.md', quote: 'Use Linear MCP.' }],
        path: 'mcp',
        fallbackPath: 'escalate',
        endpoint: 'https://mcp.linear.app/mcp',
        expiresInDays: 30,
      }),
    ).resolves.toBe(true);
    await expect(
      harness.mutation(internal.surfaces.propose, {
        surfaceId,
        request: { target: { system: 'stale' } },
        whereFound: [],
        path: 'escalate',
        fallbackPath: 'escalate',
        expiresInDays: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      harness.mutation(internal.surfaces.markAbsent, {
        surfaceId,
        searched: ['stale'],
        whereFound: [],
      }),
    ).resolves.toBe(false);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'proposed',
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
      request: { target: { system: 'Linear' } },
    });
    expect((await eventTypes(harness)).filter((type) => type === 'surface.proposed')).toHaveLength(
      1,
    );
  });
});

describe('orientation scheduling', (): void => {
  it('claims one pending job per declared surface and refuses other verdicts', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await expect(
      harness.mutation(internal.surfaces.scheduleOrientation, { surfaceId }),
    ).resolves.toBe(true);
    await expect(
      harness.mutation(internal.surfaces.scheduleOrientation, { surfaceId }),
    ).resolves.toBe(false);
    const jobs = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(jobs).toMatchObject([
      { name: 'orientationActions:orientOne', args: [{ surfaceId }], state: { kind: 'pending' } },
    ]);
    expect((await readSurface(harness, surfaceId)).orientationJobId).toBe(jobs[0]._id);

    await propose(harness, surfaceId);
    await expect(
      harness.mutation(internal.surfaces.scheduleOrientation, { surfaceId }),
    ).resolves.toBe(false);
  });
});

describe('orientation failure', (): void => {
  it('records a failure reason on a declared surface only', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await expect(
      harness.mutation(internal.surfaces.recordOrientationFailure, {
        surfaceId,
        reason: 'pages could not be read',
      }),
    ).resolves.toBe(true);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'declared',
      reason: 'orientation failed: pages could not be read',
    });
    expect(await eventTypes(harness)).toContain('surface.orientation-failed');

    await propose(harness, surfaceId);
    await expect(
      harness.mutation(internal.surfaces.recordOrientationFailure, {
        surfaceId,
        reason: 'stale',
      }),
    ).resolves.toBe(false);
    expect((await readSurface(harness, surfaceId)).reason).toBeUndefined();
  });
});

describe('surface probe generations', (): void => {
  it('demotes only through the approved ladder and records each bounded attempt', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId, 'Jira', 'kanban');
    await harness.mutation(internal.surfaces.propose, {
      surfaceId,
      request: { target: { system: 'Jira' } },
      whereFound: [{ ref: 'jira.md', quote: 'Use MCP, then the documented web UI.' }],
      path: 'mcp',
      fallbackPath: 'browser-driven',
      pathCandidates: [
        { path: 'mcp', endpoint: 'https://mcp.jira.example/mcp' },
        { path: 'browser-driven', endpoint: 'https://jira.example/issues' },
      ],
      endpoint: 'https://mcp.jira.example/mcp',
      credentialLocation: 'Jira automation credential',
      expiresInDays: 30,
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, {
        verdict: 'approved',
        managerApprovedAt: 10,
        itApprovedAt: 11,
        toolAllowlist: ['stale_tool'],
        toolArguments: [{ tool: 'stale_tool', arguments: [] }],
        providerIdentityId: 'stale-provider-user',
      });
    });
    const first = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!first) throw new Error('probe was not reserved');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, { fallbackPath: 'documented-api' });
    });
    await expect(
      harness.mutation(internal.surfaces.demoteAfterProbeFailure, {
        surfaceId,
        generation: first.generation,
        reason: 'must not choose an unnamed fallback',
        attemptedAt: 99,
      }),
    ).resolves.toBeNull();
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, { fallbackPath: 'browser-driven' });
    });

    const demoted = await harness.mutation(internal.surfaces.demoteAfterProbeFailure, {
      surfaceId,
      generation: first.generation,
      reason: 'MCP server returned HTTP 503',
      attemptedAt: 100,
    });

    expect(demoted).toMatchObject({
      generation: 2,
      surface: {
        verdict: 'approved',
        path: 'browser-driven',
        endpoint: 'https://jira.example/issues',
        fallbackPath: 'escalate',
      },
    });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      managerApprovedAt: 10,
      itApprovedAt: 11,
      path: 'browser-driven',
      endpoint: 'https://jira.example/issues',
      fallbackPath: 'escalate',
      probeGeneration: 2,
      probeAttempts: [
        {
          path: 'mcp',
          endpoint: 'https://mcp.jira.example/mcp',
          outcome: 'demoted',
          reason: 'MCP server returned HTTP 503',
          attemptedAt: 100,
        },
      ],
    });
    expect(await readSurface(harness, surfaceId)).not.toHaveProperty('toolAllowlist');
    expect(await readSurface(harness, surfaceId)).not.toHaveProperty('providerIdentityId');
    expect(await eventTypes(harness)).toContain('surface.probe-demoted');
    await expect(
      harness.mutation(internal.surfaces.demoteAfterProbeFailure, {
        surfaceId,
        generation: 2,
        reason: 'documented page did not answer',
        attemptedAt: 101,
      }),
    ).resolves.toBeNull();
    await harness.mutation(internal.surfaces.recordProbeFailure, {
      surfaceId,
      generation: 2,
      verdict: 'listed-dead',
      reason: 'documented page did not answer',
      attemptedAt: 101,
    });
    expect((await readSurface(harness, surfaceId)).probeAttempts).toEqual([
      {
        path: 'mcp',
        endpoint: 'https://mcp.jira.example/mcp',
        outcome: 'demoted',
        reason: 'MCP server returned HTTP 503',
        attemptedAt: 100,
      },
      {
        path: 'browser-driven',
        endpoint: 'https://jira.example/issues',
        outcome: 'listed-dead',
        reason: 'documented page did not answer',
        attemptedAt: 101,
      },
    ]);
  });

  it('keeps one blip on a working route from abandoning it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId, 'Jira', 'kanban');
    await harness.mutation(internal.surfaces.propose, {
      surfaceId,
      request: { target: { system: 'Jira' } },
      whereFound: [],
      path: 'mcp',
      fallbackPath: 'browser-driven',
      pathCandidates: [
        { path: 'mcp', endpoint: 'https://mcp.jira.example/mcp' },
        { path: 'browser-driven', endpoint: 'https://jira.example/issues' },
      ],
      endpoint: 'https://mcp.jira.example/mcp',
      expiresInDays: 30,
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, {
        verdict: 'connected',
        managerApprovedAt: 10,
        itApprovedAt: 11,
        credentialLanded: true,
        lastVerifiedAt: 50,
      });
    });
    const first = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!first) throw new Error('probe was not reserved');
    // The descent is one-way, so a route that demonstrably works is not given
    // up on its first bad minute.
    await expect(
      harness.mutation(internal.surfaces.demoteAfterProbeFailure, {
        surfaceId,
        generation: first.generation,
        reason: 'connect ETIMEDOUT',
        attemptedAt: 100,
      }),
    ).resolves.toBeNull();
    await harness.mutation(internal.surfaces.recordProbeFailure, {
      surfaceId,
      generation: first.generation,
      verdict: 'listed-dead',
      reason: 'connect ETIMEDOUT',
      attemptedAt: 100,
    });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'listed-dead',
      path: 'mcp',
      endpoint: 'https://mcp.jira.example/mcp',
    });
    // The next probe finds a row that is no longer connected, and descends.
    const second = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!second) throw new Error('re-probe was not reserved');
    await expect(
      harness.mutation(internal.surfaces.demoteAfterProbeFailure, {
        surfaceId,
        generation: second.generation,
        reason: 'connect ETIMEDOUT',
        attemptedAt: 200,
      }),
    ).resolves.toMatchObject({ surface: { path: 'browser-driven' } });
  });

  it('rejects ineligible rows and ignores results from an older probe', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await expect(harness.mutation(internal.surfaces.beginProbe, { surfaceId })).resolves.toBeNull();
    await propose(harness, surfaceId);
    await harness.mutation(internal.surfaces.setStatus, {
      surfaceId,
      verdict: 'approved',
    });
    const first = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    const second = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    expect(first).toMatchObject({ generation: 1, surface: { verdict: 'approved' } });
    expect(second).toMatchObject({ generation: 2, surface: { probeGeneration: 2 } });
    await expect(
      harness.mutation(internal.surfaces.recordProbeFailure, {
        surfaceId,
        generation: 1,
        verdict: 'listed-dead',
        reason: 'stale provider failure',
      }),
    ).resolves.toBe(false);
    await expect(
      harness.mutation(internal.surfaces.recordConnected, {
        surfaceId,
        generation: 1,
        toolAllowlist: ['list_issues'],
        toolArguments: [{ tool: 'list_issues', arguments: ['project'] }],
        verifiedAt: 100,
      }),
    ).resolves.toBe(false);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'approved',
      credentialLanded: false,
      probeGeneration: 2,
    });
    expect(await eventTypes(harness)).not.toContain('surface.probe-failed');
    expect(await eventTypes(harness)).not.toContain('surface.connected');
  });

  it('records the latest failure without retaining provider request material', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.mutation(internal.surfaces.setStatus, { surfaceId, verdict: 'approved' });
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await expect(
      harness.mutation(internal.surfaces.recordProbeFailure, {
        surfaceId,
        generation: probe.generation,
        verdict: 'listed-dead',
        reason: 'provider returned 401',
      }),
    ).resolves.toBe(true);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'listed-dead',
      credentialLanded: false,
      reason: 'provider returned 401',
    });
    const failure = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).find(
        (event): boolean => event.type === 'surface.probe-failed',
      ),
    );
    expect(failure?.payload).toEqual({
      surfaceId,
      verdict: 'listed-dead',
      reason: 'provider returned 401',
    });
  });

  it('persists only the latest successful generation and clears the last manager details it held', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.mutation(internal.surfaces.setStatus, { surfaceId, verdict: 'approved' });
    const first = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!first) throw new Error('probe was not reserved');
    await expect(
      harness.mutation(internal.surfaces.recordConnected, {
        surfaceId,
        generation: first.generation,
        toolAllowlist: ['list_issues'],
        toolArguments: [{ tool: 'list_issues', arguments: ['project', 'updatedAt'] }],
        managerDmChannelId: 'DMANAGER',
        managerUserId: 'UMANAGER',
        managerName: 'Brian',
        verifiedAt: 100,
      }),
    ).resolves.toBe(true);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: 100,
      managerDmChannelId: 'DMANAGER',
      managerUserId: 'UMANAGER',
      managerName: 'Brian',
    });
    const hourly = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!hourly) throw new Error('hourly probe was not reserved');
    await expect(
      harness.mutation(internal.surfaces.recordConnected, {
        surfaceId,
        generation: hourly.generation,
        toolAllowlist: ['list_issues'],
        toolArguments: [{ tool: 'list_issues', arguments: ['project', 'updatedAt'] }],
        verifiedAt: 200,
      }),
    ).resolves.toBe(true);
    const reprobed = await readSurface(harness, surfaceId);
    expect(reprobed).toMatchObject({
      verdict: 'connected',
      lastVerifiedAt: 200,
    });
    expect(reprobed.managerDmChannelId).toBeUndefined();
    expect(reprobed.managerUserId).toBeUndefined();
    expect(reprobed.managerName).toBeUndefined();
    const connectedEvents = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event): boolean => event.type === 'surface.connected',
      ),
    );
    expect(connectedEvents).toHaveLength(2);
    expect(connectedEvents.map((event) => event.payload)).toEqual([{ surfaceId }, { surfaceId }]);
    const grants = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (index) =>
            index.eq('agentId', agentId).eq('scope', 'linear:read'),
          )
          .collect(),
    );
    expect(grants).toHaveLength(1);
  });

  it('freezes the tool list the approving probe found: a later probe narrows it and never widens it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.mutation(internal.surfaces.setStatus, { surfaceId, verdict: 'approved' });
    const reprobe = async (tools: string[], verifiedAt: number): Promise<void> => {
      const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
      if (!probe) throw new Error('probe was not reserved');
      await harness.mutation(internal.surfaces.recordConnected, {
        surfaceId,
        generation: probe.generation,
        toolAllowlist: tools,
        toolArguments: tools.map((tool: string) => ({ tool, arguments: [`${tool}-argument`] })),
        verifiedAt,
      });
    };
    await reprobe(['list_issues', 'save_comment'], 100);
    await reprobe(['list_issues', 'save_comment', 'delete_issue'], 200);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      toolAllowlist: ['list_issues', 'save_comment'],
      toolArguments: [
        { tool: 'list_issues', arguments: ['list_issues-argument'] },
        { tool: 'save_comment', arguments: ['save_comment-argument'] },
      ],
    });
    await reprobe(['list_issues', 'delete_issue'], 300);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      toolAllowlist: ['list_issues'],
      toolArguments: [{ tool: 'list_issues', arguments: ['list_issues-argument'] }],
    });
    const connected = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect())
        .filter((event): boolean => event.type === 'surface.connected')
        .map((event) => event.payload),
    );
    expect(connected).toEqual([
      { surfaceId },
      { surfaceId, withheldTools: ['delete_issue'] },
      { surfaceId, withheldTools: ['delete_issue'] },
    ]);
  });

  it('schedules one intake poll of the surface the moment it first connects', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.mutation(internal.surfaces.setStatus, { surfaceId, verdict: 'approved' });
    const pendingPolls = async (): Promise<Array<Record<string, unknown>>> =>
      await harness.run(
        async (ctx) =>
          (await ctx.db.system.query('_scheduled_functions').collect()).filter(
            (job) => job.name === 'intakeActions:pollSurface',
          ) as unknown as Array<Record<string, unknown>>,
      );
    const connect = async (): Promise<void> => {
      const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
      if (!probe) throw new Error('probe was not reserved');
      await harness.mutation(internal.surfaces.recordConnected, {
        surfaceId,
        generation: probe.generation,
        toolAllowlist: ['list_issues'],
        toolArguments: [],
        verifiedAt: 100,
      });
    };

    await connect();
    const scheduled = await pendingPolls();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args).toEqual([{ surfaceId }]);

    // The hourly re-probe of a connected surface is not a new connection.
    await connect();
    expect(await pendingPolls()).toHaveLength(1);
  });

  it('re-admits an out-of-scope skip through the re-evaluation trigger when a surface connects', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.mutation(internal.surfaces.setStatus, { surfaceId, verdict: 'approved' });
    const itemId = await harness.run(
      async (ctx): Promise<Id<'workItems'>> =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-1',
          title: 'Audit note',
          contentSummary: 'Add the audit note.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'skipped',
          verdict: { decision: 'skip', reason: 'out-of-scope: no charter or current documented-system overlap' },
          skipReason: 'out-of-scope: no charter or current documented-system overlap',
        }),
    );
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation: probe.generation,
      toolAllowlist: ['list_issues'],
      toolArguments: [],
      verifiedAt: 100,
    });
    const row = await harness.run(async (ctx) => await ctx.db.get(itemId));
    expect(row).toMatchObject({
      state: 'discovered',
      reevaluation: { trigger: 'surface', key: `surface:${surfaceId}:100`, at: 100 },
    });
    expect(row?.skipReason).toBeUndefined();
    const requeued = await harness.run(
      async (ctx) => (await ctx.db.query('events').collect()).filter((event) => event.type === 'work.requeued'),
    );
    expect(requeued.map((event) => event.payload)).toEqual([
      {
        workItemId: itemId,
        trigger: 'surface',
        key: `surface:${surfaceId}:100`,
        previousState: 'skipped',
        surfaceId,
        slug: 'linear',
      },
    ]);
  });

  it('grants the read scope and requeues deferred work in the connecting write', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.mutation(internal.surfaces.setStatus, { surfaceId, verdict: 'approved' });
    const item = (
      state: Doc<'workItems'>['state'],
      externalId: string,
      verdict: unknown,
    ): Omit<Doc<'workItems'>, '_id' | '_creationTime'> => ({
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId,
      title: `Item ${externalId}`,
      contentSummary: 'Triage.',
      contentRefs: [],
      observedAt: 1,
      state,
      verdict,
      createdAt: 1,
    });
    const [onSurface, onGrant, elsewhere, skipped] = await harness.run(
      async (ctx): Promise<Id<'workItems'>[]> => [
        await ctx.db.insert(
          'workItems',
          item('deferred', 'REVOPS-1', {
            decision: 'defer',
            reason: 'awaiting-connection',
            missingSurface: 'linear',
          }),
        ),
        await ctx.db.insert(
          'workItems',
          item('deferred', 'REVOPS-2', {
            decision: 'defer',
            reason: 'awaiting-permission',
            missingPermissions: ['linear:read'],
          }),
        ),
        await ctx.db.insert(
          'workItems',
          item('deferred', 'REVOPS-3', {
            decision: 'defer',
            reason: 'awaiting-connection',
            missingSurface: 'northstar-crm',
          }),
        ),
        await ctx.db.insert(
          'workItems',
          item('skipped', 'REVOPS-4', { decision: 'skip', reason: 'low-value: 10' }),
        ),
      ],
    );
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation: probe.generation,
      toolAllowlist: ['list_issues'],
      toolArguments: [],
      verifiedAt: 100,
    });
    const states = await harness.run(
      async (ctx): Promise<Array<[string, unknown]>> =>
        await Promise.all(
          [onSurface, onGrant, elsewhere, skipped].map(async (id): Promise<[string, unknown]> => {
            const row = await ctx.db.get(id);
            return [row?.state ?? 'missing', row?.verdict ?? null];
          }),
        ),
    );
    expect(states).toEqual([
      ['discovered', null],
      ['discovered', null],
      [
        'deferred',
        { decision: 'defer', reason: 'awaiting-connection', missingSurface: 'northstar-crm' },
      ],
      ['skipped', { decision: 'skip', reason: 'low-value: 10' }],
    ]);
    const grants = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (index) => index.eq('agentId', agentId))
          .collect(),
    );
    expect(grants.map((grant): string => grant.scope)).toEqual(['linear:read']);
    expect(grants[0].source).toBe('surface');
    expect(
      (await harness.run(async (ctx) => await ctx.db.query('events').collect()))
        .filter((event) => event.type === 'permission.granted')
        .map((event) => event.payload),
    ).toEqual([{ scope: 'linear:read', source: 'surface' }]);
    expect((await eventTypes(harness)).filter((type) => type === 'work.requeued')).toHaveLength(2);
  });

  it('leaves work waiting on a distinct qualified product when the tile connects', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const [tileId, workItemId] = await harness.run(
      async (ctx): Promise<[Id<'surfaces'>, Id<'workItems'>]> => {
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-studio',
          displayName: 'Looker Studio',
          class: 'analytics',
          verdict: 'declared',
          whereFound: [],
          discoveryEvidence: [
            {
              kind: 'charter',
              ref: 'manager 1:1',
              quote: 'The board deck charts are built in Looker Studio.',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          createdAt: 1,
        });
        const surfaceId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'approved',
          endpoint: 'http://looker-tile:8080/',
          whereFound: [{ ref: 'systems/looker-pipeline-tile.md', quote: '# Looker pipeline tile' }],
          discoveryEvidence: [
            {
              kind: 'documentation',
              ref: 'systems/looker-pipeline-tile.md',
              quote: '# Looker pipeline tile',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          managerApprovedAt: 1,
          itApprovedAt: 1,
          createdAt: 1,
        });
        const itemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-9',
          title: 'Rebuild the board deck chart in Looker Studio',
          contentSummary: '',
          contentRefs: [],
          observedAt: 1,
          state: 'deferred',
          verdict: {
            decision: 'defer',
            reason: 'awaiting-connection',
            missingSurface: 'looker-studio',
          },
          createdAt: 1,
        });
        return [surfaceId, itemId];
      },
    );
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId: tileId });
    if (!probe) throw new Error('probe was not reserved');

    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId: tileId,
      generation: probe.generation,
      toolAllowlist: ['browser_navigate'],
      toolArguments: [],
      verifiedAt: 100,
    });

    const item = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(item).toMatchObject({
      state: 'deferred',
      verdict: { reason: 'awaiting-connection', missingSurface: 'looker-studio' },
    });
    expect(await eventTypes(harness)).not.toContain('work.requeued');
  });

  it('requeues work whose missing slug is a legacy alias of the connecting surface', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const [tileId, workItemId] = await harness.run(
      async (ctx): Promise<[Id<'surfaces'>, Id<'workItems'>]> => {
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker',
          displayName: 'Looker',
          class: 'analytics',
          verdict: 'declared',
          whereFound: [
            {
              ref: 'manager 1:1',
              quote: 'Pipeline numbers are on the Looker tile, web UI only.',
            },
          ],
          discoveryEvidence: [
            {
              kind: 'charter',
              ref: 'manager 1:1',
              quote: 'Pipeline numbers are on the Looker tile, web UI only.',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          createdAt: 1,
        });
        const surfaceId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'approved',
          endpoint: 'http://looker-tile:8080/',
          whereFound: [
            { ref: 'systems/looker-pipeline-tile.md', quote: '# Looker pipeline tile' },
          ],
          discoveryEvidence: [
            {
              kind: 'documentation',
              ref: 'systems/looker-pipeline-tile.md',
              quote: '# Looker pipeline tile',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          managerApprovedAt: 1,
          itApprovedAt: 1,
          createdAt: 1,
        });
        const itemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-7',
          title: 'Refresh the Looker pipeline tile',
          contentSummary: '',
          contentRefs: [],
          observedAt: 1,
          state: 'deferred',
          verdict: {
            decision: 'defer',
            reason: 'awaiting-connection',
            missingSurface: 'looker',
          },
          createdAt: 1,
        });
        return [surfaceId, itemId];
      },
    );
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId: tileId });
    if (!probe) throw new Error('probe was not reserved');

    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId: tileId,
      generation: probe.generation,
      toolAllowlist: ['browser_navigate'],
      toolArguments: [],
      verifiedAt: 100,
    });

    const result = await harness.run(async (ctx) => ({
      item: await ctx.db.get(workItemId),
      events: await ctx.db
        .query('events')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .collect(),
    }));
    expect(result.item).toMatchObject({ state: 'discovered' });
    expect(result.item).not.toHaveProperty('verdict');
    expect(result.events.find((event) => event.type === 'work.requeued')?.payload).toMatchObject({
      surfaceId: tileId,
      slug: 'looker-pipeline-tile',
      previousMissingSurface: 'looker',
    });
  });
});

describe('surface connection lifecycle metadata', (): void => {
  it('returns an approved failed surface to probing when IT lands a credential', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, {
        verdict: 'ungranted',
        managerApprovedAt: 10,
        itApprovedAt: 20,
        reason: 'credential missing',
      });
    });
    await harness.mutation(internal.surfaces.attachCredential, {
      surfaceId,
      credentialId: '10000credentials' as GenericId<'credentials'>,
      credentialKind: 'location',
      credentialLocation: 'entered by IT approver',
    });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'approved',
      credentialId: '10000credentials',
      credentialKind: 'location',
      credentialLocation: 'entered by IT approver',
      credentialLanded: false,
    });
    expect((await readSurface(harness, surfaceId)).reason).toBeUndefined();
  });

  it('demotes an expired connection and records a safe lifecycle event', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, {
        verdict: 'connected',
        credentialLanded: true,
        lastVerifiedAt: 90,
        expiresAt: 100,
      });
    });
    await harness.mutation(internal.surfaces.recordExpired, { surfaceId, now: 101 });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'approved',
      credentialLanded: false,
      reason: 'expired',
    });
    expect((await readSurface(harness, surfaceId)).lastVerifiedAt).toBeUndefined();
    const expired = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).find(
        (event): boolean => event.type === 'surface.expired',
      ),
    );
    expect(expired?.payload).toEqual({ surfaceId, expiresAt: 100 });
  });

  it('records waterfall skips and clears them after a successful poll', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await harness.mutation(internal.surfaces.recordIntake, {
      surfaceId,
      waterfallPosition: 2,
      skipReason: 'surface is ungranted',
    });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      waterfallPosition: 2,
      intakeSkipReason: 'surface is ungranted',
    });
    await harness.mutation(internal.surfaces.recordIntake, {
      surfaceId,
      waterfallPosition: 1,
      polledAt: 500,
    });
    const completed = await readSurface(harness, surfaceId);
    expect(completed).toMatchObject({ waterfallPosition: 1, lastPolledAt: 500 });
    expect(completed.intakeSkipReason).toBeUndefined();
    await harness.mutation(internal.surfaces.recordIntake, {
      surfaceId,
      waterfallPosition: 1,
      polledAt: 400,
    });
    expect((await readSurface(harness, surfaceId)).lastPolledAt).toBe(500);
  });
});

describe('surface approval state machine', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  it('refuses approval and rejection server-side in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api: liveApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    const owner = harness.withIdentity({ subject: 'owner' });

    await expect(
      owner.mutation(liveApi.surfaces.approve, { surfaceId, role: 'manager' }),
    ).rejects.toThrow('local real-mode feature');
    await expect(
      owner.mutation(liveApi.surfaces.reject, { surfaceId, reason: 'No.' }),
    ).rejects.toThrow('local real-mode feature');

    const surface = await readSurface(harness, surfaceId);
    expect(surface.verdict).toBe('proposed');
    expect(surface.managerApprovedAt).toBeUndefined();
    expect(surface.itApprovedAt).toBeUndefined();
    expect(await eventTypes(harness)).not.toContain('surface.approved');
    expect(
      await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()),
    ).toHaveLength(0);
  });

  it('requires both approvals and emits surface.approved exactly once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'manager' });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'proposed',
      managerApprovedAt: expect.any(Number),
    });
    expect(await eventTypes(harness)).not.toContain('surface.approved');
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'it' });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'approved',
      itApprovedAt: expect.any(Number),
    });
    expect((await eventTypes(harness)).filter((type) => type === 'surface.approved')).toHaveLength(
      1,
    );
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled).toMatchObject([
      {
        name: 'surfaceActions:probeInternal',
        args: [{ surfaceId }],
        state: { kind: 'pending' },
      },
    ]);
    await expect(owner.mutation(api.surfaces.approve, { surfaceId, role: 'it' })).rejects.toThrow(
      'Only a proposed surface can be approved; this one is approved.',
    );
  });

  it('refuses a browser-driven approval server-side when the component is absent', async (): Promise<void> => {
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId, 'Looker', 'analytics');
    await harness.mutation(internal.surfaces.propose, {
      surfaceId,
      request: { target: { system: 'Looker' } },
      whereFound: [{ ref: 'looker.md', quote: 'Open the pipeline tile.' }],
      path: 'browser-driven',
      fallbackPath: 'escalate',
      endpoint: 'http://looker-tile:8080/',
      credentialLocation: 'No sign-in required',
      expiresInDays: 30,
    });
    const owner = harness.withIdentity({ subject: 'owner' });

    await expect(
      owner.mutation(api.surfaces.approve, { surfaceId, role: 'manager' }),
    ).rejects.toThrow(BROWSER_DRIVER_ABSENT);
    expect(await readSurface(harness, surfaceId)).toMatchObject({ verdict: 'proposed' });
    expect((await readSurface(harness, surfaceId)).managerApprovedAt).toBeUndefined();
  });

  it('refuses to approve a surface that is not proposed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const declared = await seedDeclared(harness, agentId, 'Slack', 'chat');
    const absent = await seedDeclared(harness, agentId, 'Northstar CRM', 'crm');
    await harness.mutation(internal.surfaces.markAbsent, {
      surfaceId: absent,
      searched: ['Northstar CRM'],
      whereFound: [],
    });
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.surfaces.approve, { surfaceId: declared, role: 'manager' }),
    ).rejects.toThrow('this one is declared');
    await expect(
      owner.mutation(api.surfaces.approve, { surfaceId: absent, role: 'manager' }),
    ).rejects.toThrow('this one is absent');
    await expect(
      owner.mutation(api.surfaces.approve, { surfaceId: absent, role: 'it' }),
    ).rejects.toThrow('this one is absent');
    const row = await readSurface(harness, absent);
    expect(row.verdict).toBe('absent');
    expect(row.managerApprovedAt).toBeUndefined();
    expect(row.itApprovedAt).toBeUndefined();
    expect(await eventTypes(harness)).not.toContain('surface.approved');
  });

  it('refuses approval from a caller who does not own the agent', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    const other = harness.withIdentity({ subject: 'other-owner' });
    await expect(
      other.mutation(api.surfaces.approve, { surfaceId, role: 'manager' }),
    ).rejects.toThrow('forbidden');
    await expect(other.mutation(api.surfaces.reject, { surfaceId, reason: 'no' })).rejects.toThrow(
      'forbidden',
    );
  });

  it('clears stamps and connection details on rejection so a re-proposal starts clean', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    const owner = harness.withIdentity({ subject: 'owner' });

    await propose(harness, surfaceId);
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'manager' });
    await harness.mutation(internal.surfaces.attachCredential, {
      surfaceId,
      credentialId: '10000credentials' as GenericId<'credentials'>,
      credentialKind: 'value',
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, {
        managerDmChannelId: 'DMANAGER',
        managerUserId: 'UMANAGER',
        managerName: 'Brian',
      });
    });
    expect(await readSurface(harness, surfaceId)).toMatchObject({ credentialKind: 'value' });
    await owner.mutation(api.surfaces.reject, { surfaceId, reason: 'Wrong endpoint.' });
    const rejected = await readSurface(harness, surfaceId);
    expect(rejected).toMatchObject({ verdict: 'declared', reason: 'Wrong endpoint.' });
    expect(rejected.credentialId).toBeUndefined();
    expect(rejected.credentialKind).toBeUndefined();
    expect(rejected.managerApprovedAt).toBeUndefined();
    expect(rejected.itApprovedAt).toBeUndefined();
    expect(rejected.endpoint).toBeUndefined();
    expect(rejected.path).toBeUndefined();
    expect(rejected.request).toBeUndefined();
    expect(rejected.credentialLanded).toBe(false);
    expect(rejected.managerDmChannelId).toBeUndefined();
    expect(rejected.managerUserId).toBeUndefined();
    expect(rejected.managerName).toBeUndefined();

    await propose(harness, surfaceId);
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'it' });
    const halfApproved = await readSurface(harness, surfaceId);
    expect(halfApproved.verdict).toBe('proposed');
    expect(halfApproved.itApprovedAt).toEqual(expect.any(Number));
    expect(halfApproved.managerApprovedAt).toBeUndefined();
    expect(await eventTypes(harness)).not.toContain('surface.approved');

    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'manager' });
    expect((await readSurface(harness, surfaceId)).verdict).toBe('approved');
    expect((await eventTypes(harness)).filter((type) => type === 'surface.approved')).toHaveLength(
      1,
    );
  });

  it('keeps work parked on a rejected distinct product beside the connected tile', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const [studioId, workItemId] = await harness.run(
      async (ctx): Promise<[Id<'surfaces'>, Id<'workItems'>]> => {
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'connected',
          endpoint: 'http://looker-tile:8080/',
          whereFound: [{ ref: 'systems/looker-pipeline-tile.md', quote: '# Looker pipeline tile' }],
          discoveryEvidence: [
            {
              kind: 'documentation',
              ref: 'systems/looker-pipeline-tile.md',
              quote: '# Looker pipeline tile',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: true,
          lastVerifiedAt: Date.now(),
          createdAt: 1,
        });
        const surfaceId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-studio',
          displayName: 'Looker Studio',
          class: 'analytics',
          verdict: 'proposed',
          whereFound: [],
          discoveryEvidence: [
            {
              kind: 'charter',
              ref: 'manager 1:1',
              quote: 'The board deck charts are built in Looker Studio.',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          createdAt: 1,
        });
        const itemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-9',
          title: 'Rebuild the board deck chart in Looker Studio',
          contentSummary: '',
          contentRefs: [],
          observedAt: 1,
          state: 'deferred',
          verdict: {
            decision: 'defer',
            reason: 'awaiting-connection',
            missingSurface: 'looker-studio',
          },
          createdAt: 1,
        });
        return [surfaceId, itemId];
      },
    );

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.surfaces.reject, { surfaceId: studioId, reason: 'Not this quarter.' });

    const item = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(item).toMatchObject({
      state: 'deferred',
      verdict: { reason: 'awaiting-connection', missingSurface: 'looker-studio' },
    });
    expect(await eventTypes(harness)).not.toContain('work.requeued');
  });

  it('requeues work parked on a rejected duplicate when the documented surface exists', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const [duplicateId, workItemId] = await harness.run(
      async (ctx): Promise<[Id<'surfaces'>, Id<'workItems'>]> => {
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker-pipeline-tile',
          displayName: 'Looker pipeline tile',
          class: 'analytics',
          verdict: 'connected',
          endpoint: 'http://looker-tile:8080/',
          whereFound: [
            { ref: 'systems/looker-pipeline-tile.md', quote: '# Looker pipeline tile' },
          ],
          discoveryEvidence: [
            {
              kind: 'documentation',
              ref: 'systems/looker-pipeline-tile.md',
              quote: '# Looker pipeline tile',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: true,
          lastVerifiedAt: Date.now(),
          createdAt: 1,
        });
        const surfaceId = await ctx.db.insert('surfaces', {
          agentId,
          slug: 'looker',
          displayName: 'Looker',
          class: 'analytics',
          verdict: 'declared',
          whereFound: [
            {
              ref: 'manager 1:1',
              quote: 'Pipeline numbers are on the Looker tile, web UI only.',
            },
          ],
          discoveryEvidence: [
            {
              kind: 'charter',
              ref: 'manager 1:1',
              quote: 'Pipeline numbers are on the Looker tile, web UI only.',
              current: true,
              firstSeenAt: 1,
              lastSeenAt: 1,
            },
          ],
          credentialLanded: false,
          createdAt: 1,
        });
        const itemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-7',
          title: 'Refresh the Looker pipeline tile',
          contentSummary: '',
          contentRefs: [],
          observedAt: 1,
          state: 'deferred',
          verdict: {
            decision: 'defer',
            reason: 'awaiting-connection',
            missingSurface: 'looker',
          },
          createdAt: 1,
        });
        return [surfaceId, itemId];
      },
    );
    await harness.mutation(internal.surfaces.propose, {
      surfaceId: duplicateId,
      request: { target: { system: 'Looker' } },
      whereFound: [{ ref: 'looker.md', quote: 'Open the pipeline tile.' }],
      path: 'browser-driven',
      fallbackPath: 'escalate',
      endpoint: 'http://looker-tile:8080/',
      expiresInDays: 30,
    });

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.surfaces.reject, { surfaceId: duplicateId, reason: 'Duplicate surface.' });

    const item = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(item).toMatchObject({ state: 'discovered' });
    expect(item).not.toHaveProperty('verdict');
    // The server evaluates the requeued row; no page has to be open for it.
    const jobs = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(
      jobs
        .filter((job) => job.name === 'workActions:evaluateWorkItemInternal')
        .map((job) => job.args),
    ).toEqual([[{ workItemId }]]);
  });

  it('allows rejection of an approved surface and refuses it elsewhere', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.surfaces.reject, { surfaceId, reason: 'Nothing to reject.' }),
    ).rejects.toThrow('this one is declared');

    await propose(harness, surfaceId);
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'manager' });
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'it' });
    await harness.mutation(internal.surfaces.setStatus, {
      surfaceId,
      verdict: 'approved',
      credentialLanded: true,
      lastVerifiedAt: 5,
    });
    await owner.mutation(api.surfaces.reject, { surfaceId, reason: 'Revoked.' });
    const row = await readSurface(harness, surfaceId);
    expect(row).toMatchObject({ verdict: 'declared', reason: 'Revoked.', credentialLanded: false });
    expect(row.lastVerifiedAt).toBeUndefined();
    expect(row.managerApprovedAt).toBeUndefined();
    expect(row.itApprovedAt).toBeUndefined();
    expect(await eventTypes(harness)).toContain('surface.rejected');

    await harness.mutation(internal.surfaces.markAbsent, {
      surfaceId,
      searched: ['Linear'],
      whereFound: [],
    });
    await expect(
      owner.mutation(api.surfaces.reject, { surfaceId, reason: 'Nothing to reject.' }),
    ).rejects.toThrow('this one is absent');
  });
});

describe('owner-triggered orientation', (): void => {
  it('refuses reorient from a caller who does not own the agent', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    await expect(
      harness.withIdentity({ subject: 'other-owner' }).action(api.surfaces.reorient, { agentId }),
    ).rejects.toThrow('forbidden');
  });

  it('refuses reorient outside real mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    await seedDeclared(harness, agentId);
    await expect(
      harness.withIdentity({ subject: 'owner' }).action(api.surfaces.reorient, { agentId }),
    ).rejects.toThrow('Surface orientation is a local real-mode feature');
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.query(api.surfaces.listForAgent, { agentId })).resolves.toMatchObject([
      { verdict: 'declared' },
    ]);
  });
});

describe('the dedicated app on a surface row', (): void => {
  /** Seed one approved chat surface carrying a registered app. */
  async function seedProvisioned(
    harness: TestConvex<typeof schema>,
    options: { installed?: boolean; sharedCredential?: boolean } = {},
  ): Promise<{
    agentId: GenericId<'agents'>;
    secretId: GenericId<'credentials'>;
    sharedId?: GenericId<'credentials'>;
    surfaceId: GenericId<'surfaces'>;
  }> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'ops worker',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const secretId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'oauth',
        label: 'ops worker (Day0) client secret',
        ciphertext: 'c',
        iv: 'i',
        source: 'oauth',
        appId: 'A123',
        createdAt: 1,
      });
      const sharedId = options.sharedCredential
        ? await ctx.db.insert('credentials', {
            userId: 'owner',
            kind: 'value',
            label: 'Slack OAuth access',
            ciphertext: 'c',
            iv: 'i',
            source: 'entered',
            createdAt: 1,
          })
        : undefined;
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'approved',
        whereFound: [],
        path: 'documented-api',
        endpoint: 'https://slack.com/api/',
        managerApprovedAt: 2,
        itApprovedAt: 3,
        ...(sharedId ? { credentialId: sharedId, credentialKind: 'value' as const } : {}),
        provisioning: {
          appId: 'A123',
          appName: 'ops worker (Day0)',
          clientId: '111.222',
          clientSecretCredentialId: secretId,
          installUrl: 'https://slack.com/oauth/v2/authorize',
          redirectUrl: 'https://day0.example.test/api/oauth/slack',
          scopes: ['chat:write'],
          createdAt: 1,
          ...(options.installed
            ? { installedAt: 9 }
            : { stateNonce: 'the-nonce', stateExpiresAt: 1_000 }),
        },
        credentialLanded: false,
        createdAt: 1,
      });
      return { agentId, secretId, sharedId, surfaceId };
    });
  }

  it('claims the install state exactly once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedProvisioned(harness);
    const first = await harness.mutation(internal.surfaces.claimInstallState, {
      surfaceId,
      nonce: 'the-nonce',
      now: 500,
    });
    expect(first).toMatchObject({ ok: true, clientId: '111.222', slug: 'slack' });
    await expect(
      harness.mutation(internal.surfaces.claimInstallState, {
        surfaceId,
        nonce: 'the-nonce',
        now: 500,
      }),
    ).resolves.toEqual({ ok: false, reason: 'used' });
  });

  it('refuses a nonce that is not the one on the row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedProvisioned(harness);
    await expect(
      harness.mutation(internal.surfaces.claimInstallState, {
        surfaceId,
        nonce: 'another-nonce',
        now: 500,
      }),
    ).resolves.toEqual({ ok: false, reason: 'used' });
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.provisioning?.stateNonce).toBe('the-nonce');
  });

  it('refuses a claim after the link has expired', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedProvisioned(harness);
    await expect(
      harness.mutation(internal.surfaces.claimInstallState, {
        surfaceId,
        nonce: 'the-nonce',
        now: 1_000,
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a claim on a surface with no app awaiting an install', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedProvisioned(harness, { installed: true });
    await expect(
      harness.mutation(internal.surfaces.claimInstallState, {
        surfaceId,
        nonce: 'the-nonce',
        now: 500,
      }),
    ).resolves.toEqual({ ok: false, reason: 'used' });
  });

  it('retires the shared token the dedicated identity replaces', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sharedId, surfaceId } = await seedProvisioned(harness, { sharedCredential: true });
    const botId = await harness.run(
      async (ctx): Promise<GenericId<'credentials'>> =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'oauth',
          label: 'Slack bot token',
          ciphertext: 'c',
          iv: 'i',
          source: 'oauth',
          createdAt: 2,
        }),
    );
    await expect(
      harness.mutation(internal.surfaces.recordInstalledApp, {
        surfaceId,
        credentialId: botId,
        now: 10,
      }),
    ).resolves.toEqual({ retiredCredentialId: sharedId });
    const after = await harness.run(async (ctx) => ({
      shared: sharedId ? await ctx.db.get(sharedId) : null,
      surface: await ctx.db.get(surfaceId),
    }));
    expect(after.surface).toMatchObject({ credentialId: botId, credentialKind: 'oauth' });
    expect(after.shared?.revokedAt).toBe(10);
  });

  it('retires nothing when the surface carried no credential', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedProvisioned(harness);
    const botId = await harness.run(
      async (ctx): Promise<GenericId<'credentials'>> =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'oauth',
          label: 'Slack bot token',
          ciphertext: 'c',
          iv: 'i',
          source: 'oauth',
          createdAt: 2,
        }),
    );
    await expect(
      harness.mutation(internal.surfaces.recordInstalledApp, {
        surfaceId,
        credentialId: botId,
        now: 10,
      }),
    ).resolves.toEqual({ retiredCredentialId: undefined });
  });

  it('refuses to replace a dedicated token with a second install', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedProvisioned(harness);
    const first = await harness.run(
      async (ctx): Promise<GenericId<'credentials'>> =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'oauth',
          label: 'Slack bot token',
          ciphertext: 'c',
          iv: 'i',
          source: 'oauth',
          createdAt: 2,
        }),
    );
    await harness.mutation(internal.surfaces.recordInstalledApp, {
      surfaceId,
      credentialId: first,
      now: 10,
    });
    const second = await harness.run(
      async (ctx): Promise<GenericId<'credentials'>> =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'oauth',
          label: 'Slack bot token',
          ciphertext: 'c',
          iv: 'i',
          source: 'oauth',
          createdAt: 3,
        }),
    );
    await expect(
      harness.mutation(internal.surfaces.recordInstalledApp, {
        surfaceId,
        credentialId: second,
        now: 11,
      }),
    ).rejects.toThrow('already has a dedicated identity');
    const after = await harness.run(async (ctx) => ({
      first: await ctx.db.get(first),
      surface: await ctx.db.get(surfaceId),
    }));
    expect(after.first?.revokedAt).toBeUndefined();
    expect(after.surface?.credentialId).toBe(first);
  });

  it('forgets the app when the connection is rejected', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedProvisioned(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, { verdict: 'proposed', channelsNotJoined: ['#revops'] });
    });
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.surfaces.reject, { surfaceId, reason: 'Rejected by the operator.' });
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.provisioning).toBeUndefined();
    expect(surface?.channelsNotJoined).toBeUndefined();
    expect(surface?.verdict).toBe('declared');
  });
});

describe('a connected surface and its last skip reason', (): void => {
  it('clears the reason the poll recorded while it was not yet connected', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await harness.run(async (ctx): Promise<GenericId<'surfaces'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'skip reason',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker-pipeline-tile',
        displayName: 'Looker pipeline tile',
        class: 'analytics',
        verdict: 'approved',
        whereFound: [],
        path: 'browser-driven',
        endpoint: 'http://looker-tile:8080/',
        managerApprovedAt: 2,
        itApprovedAt: 3,
        intakeSkipReason: 'surface is proposed; awaiting connection',
        credentialLanded: false,
        probeGeneration: 1,
        createdAt: 1,
      });
    });
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation: 1,
      toolAllowlist: ['browser_navigate'],
      toolArguments: [],
      verifiedAt: 10,
    });
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.verdict).toBe('connected');
    expect(surface?.intakeSkipReason).toBeUndefined();
  });
});

describe('access expiry (Q5)', (): void => {
  const DAY = 24 * 60 * 60 * 1_000;
  const PROPOSED_AT = Date.UTC(2026, 8, 1);
  const APPROVED_AT = PROPOSED_AT + 10 * DAY;

  beforeEach((): void => {
    useSurfaceMode('real');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PROPOSED_AT);
  });

  /**
   * Propose, then approve as both roles ten days later.
   *
   * Args:
   *   harness: Convex test harness.
   *   request: The proposal's request, carrying its access length or none.
   *
   * Returns:
   *   The approved surface id.
   */
  async function approvedSurface(
    harness: TestConvex<typeof schema>,
    request: Record<string, unknown> = { target: { system: 'Linear' }, expiresInDays: 30 },
  ): Promise<Id<'surfaces'>> {
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await harness.mutation(internal.surfaces.propose, {
      surfaceId,
      request,
      whereFound: [{ ref: 'runbook.md', quote: 'Use Linear MCP.' }],
      path: 'mcp',
      fallbackPath: 'escalate',
      endpoint: 'https://mcp.linear.app/mcp',
      expiresInDays: typeof request.expiresInDays === 'number' ? request.expiresInDays : 90,
    });
    vi.setSystemTime(APPROVED_AT);
    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'manager' });
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'it' });
    return surfaceId;
  }

  /**
   * The payloads of one event type, in insertion order.
   *
   * Args:
   *   harness: Convex test harness.
   *   type: Event type.
   *
   * Returns:
   *   The payloads.
   */
  async function payloads(harness: TestConvex<typeof schema>, type: string): Promise<unknown[]> {
    return await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect())
        .filter((event): boolean => event.type === type)
        .map((event): unknown => event.payload),
    );
  }

  it('leaves the clock stopped at proposal and starts it at approval', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    expect((await readSurface(harness, surfaceId)).expiresAt).toBeUndefined();

    const approved = await approvedSurface(harness);
    expect((await readSurface(harness, approved)).expiresAt).toBe(APPROVED_AT + 30 * DAY);
  });

  it("uses Q5's 90-day default when the proposal names no length", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness, { target: { system: 'Linear' } });
    expect((await readSurface(harness, surfaceId)).expiresAt).toBe(APPROVED_AT + 90 * DAY);
  });

  it('caps a proposed length at a year', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness, {
      target: { system: 'Linear' },
      expiresInDays: 3650,
    });
    expect((await readSurface(harness, surfaceId)).expiresAt).toBe(APPROVED_AT + 365 * DAY);
  });

  it('keeps the end date through every probe that connects', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness);
    for (const verifiedAt of [APPROVED_AT + DAY, APPROVED_AT + 20 * DAY]) {
      const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
      if (!probe) throw new Error('probe was not reserved');
      await harness.mutation(internal.surfaces.recordConnected, {
        surfaceId,
        generation: probe.generation,
        toolAllowlist: ['list_issues'],
        toolArguments: [],
        verifiedAt,
      });
    }
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'connected',
      expiresAt: APPROVED_AT + 30 * DAY,
    });
  });

  it('refuses to probe an approval whose access has ended', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness);
    vi.setSystemTime(APPROVED_AT + 31 * DAY);
    await expect(harness.mutation(internal.surfaces.beginProbe, { surfaceId })).resolves.toBeNull();
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'approved',
      reason: 'expired',
    });
  });

  it('refuses every probe of an ended access, not only the first, until the manager renews it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness);
    const endedAt = APPROVED_AT + 31 * DAY;
    vi.setSystemTime(endedAt);
    await harness.mutation(internal.surfaces.recordExpired, { surfaceId, now: endedAt });

    // A credential landed afterwards schedules a probe; the probe must not reconnect.
    await expect(harness.mutation(internal.surfaces.beginProbe, { surfaceId })).resolves.toBeNull();
    expect(await payloads(harness, 'surface.expired')).toHaveLength(1);

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.surfaces.setAccessDays, { surfaceId, days: 30 });
    await expect(
      harness.mutation(internal.surfaces.beginProbe, { surfaceId }),
    ).resolves.toMatchObject({ generation: expect.any(Number) });
  });

  it('lets the manager set the length, which restarts the clock and renews an ended access', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness);
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation: probe.generation,
      toolAllowlist: ['list_issues'],
      toolArguments: [],
      verifiedAt: APPROVED_AT + DAY,
    });
    const endedAt = APPROVED_AT + 31 * DAY;
    await harness.mutation(internal.surfaces.recordExpired, { surfaceId, now: endedAt });
    const renewedAt = endedAt + DAY;
    vi.setSystemTime(renewedAt);

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.surfaces.setAccessDays, { surfaceId, days: 60 });

    const surface = await readSurface(harness, surfaceId);
    expect(surface).toMatchObject({ verdict: 'approved', expiresAt: renewedAt + 60 * DAY });
    expect(surface.reason).toBeUndefined();
    expect(await payloads(harness, 'surface.access-set')).toEqual([
      { surfaceId, by: 'approval', days: 30, expiresAt: APPROVED_AT + 30 * DAY },
      { surfaceId, by: 'manager', days: 60, expiresAt: renewedAt + 60 * DAY, renewed: true },
    ]);
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(
      scheduled.filter(
        (job) => job.name === 'surfaceActions:probeInternal' && job.scheduledTime === renewedAt,
      ),
    ).toHaveLength(1);
  });

  it('keeps the frozen tool list through an expiry, a renewal and the probe the renewal schedules', async (): Promise<void> => {
    // The renewal schedules a real probe; the timers stay still so only this test's probes run.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(PROPOSED_AT);
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness);
    const connect = async (tools: string[], verifiedAt: number): Promise<void> => {
      const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
      if (!probe) throw new Error('probe was not reserved');
      await harness.mutation(internal.surfaces.recordConnected, {
        surfaceId,
        generation: probe.generation,
        toolAllowlist: tools,
        toolArguments: [],
        verifiedAt,
      });
    };
    await connect(['list_issues', 'save_comment'], APPROVED_AT + DAY);
    const endedAt = APPROVED_AT + 31 * DAY;
    vi.setSystemTime(endedAt);
    await harness.mutation(internal.surfaces.recordExpired, { surfaceId, now: endedAt });
    const renewedAt = endedAt + DAY;
    vi.setSystemTime(renewedAt);
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.surfaces.setAccessDays, { surfaceId, days: 90 });

    await connect(['list_issues', 'save_comment', 'delete_issue'], renewedAt);

    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'connected',
      toolAllowlist: ['list_issues', 'save_comment'],
    });
    expect((await payloads(harness, 'surface.connected')).at(-1)).toEqual({
      surfaceId,
      withheldTools: ['delete_issue'],
    });
  });

  it('sets the length on a live connection without probing it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness);
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation: probe.generation,
      toolAllowlist: ['list_issues'],
      toolArguments: [],
      verifiedAt: APPROVED_AT + DAY,
    });
    const setAt = APPROVED_AT + 5 * DAY;
    vi.setSystemTime(setAt);
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.surfaces.setAccessDays, { surfaceId, days: 7 });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'connected',
      expiresAt: setAt + 7 * DAY,
    });
    expect((await payloads(harness, 'surface.access-set')).at(-1)).toEqual({
      surfaceId,
      by: 'manager',
      days: 7,
      expiresAt: setAt + 7 * DAY,
      renewed: false,
    });
  });

  it('refuses a length before approval, outside a day to a year, or from another owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const proposed = await seedDeclared(harness, agentId);
    await propose(harness, proposed);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.surfaces.setAccessDays, { surfaceId: proposed, days: 30 }),
    ).rejects.toThrow('Access length is set once the card is approved; this one is proposed.');

    const approved = await approvedSurface(harness);
    for (const days of [0, 366, 1.5]) {
      await expect(
        owner.mutation(api.surfaces.setAccessDays, { surfaceId: approved, days }),
      ).rejects.toThrow('Access length must be a whole number of days from 1 to 365.');
    }
    await expect(
      harness
        .withIdentity({ subject: 'intruder' })
        .mutation(api.surfaces.setAccessDays, { surfaceId: approved, days: 30 }),
    ).rejects.toThrow('forbidden');
    expect((await readSurface(harness, approved)).expiresAt).toBe(APPROVED_AT + 30 * DAY);
    expect(await payloads(harness, 'surface.access-set')).toEqual([
      { surfaceId: approved, by: 'approval', days: 30, expiresAt: APPROVED_AT + 30 * DAY },
    ]);
  });

  it('writes one notice a week before the end date, and none earlier', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness);
    const expiresAt = APPROVED_AT + 30 * DAY;

    await expect(
      harness.mutation(internal.surfaces.recordExpiryNotice, {
        surfaceId,
        now: expiresAt - 7 * DAY - 1,
      }),
    ).resolves.toBe(false);
    for (const now of [expiresAt - 7 * DAY, expiresAt - 6 * DAY]) {
      await harness.mutation(internal.surfaces.recordExpiryNotice, { surfaceId, now });
    }
    expect(await payloads(harness, 'surface.expiring')).toEqual([{ surfaceId, expiresAt }]);
  });

  it('notices a new end date after the manager moves it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await approvedSurface(harness);
    const first = APPROVED_AT + 30 * DAY;
    await harness.mutation(internal.surfaces.recordExpiryNotice, { surfaceId, now: first - DAY });
    vi.setSystemTime(first - DAY);
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.surfaces.setAccessDays, { surfaceId, days: 3 });
    const second = first - DAY + 3 * DAY;
    await harness.mutation(internal.surfaces.recordExpiryNotice, { surfaceId, now: second - DAY });
    expect(await payloads(harness, 'surface.expiring')).toEqual([
      { surfaceId, expiresAt: first },
      { surfaceId, expiresAt: second },
    ]);
  });

  it('restarts, once, every approved clock the proposal started, as an upgrade migration', async (): Promise<void> => {
    // The page schedules a probe for a card it restarts; the timers stay still so none runs.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(PROPOSED_AT);
    const harness = convexTest(schema, allConvexModules());
    const current = await approvedSurface(harness);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(current, { verdict: 'connected', credentialLanded: true });
    });
    const agentId = await seedAgent(harness);
    const legacy = async (
      fields: Partial<Doc<'surfaces'>> & Pick<Doc<'surfaces'>, 'slug' | 'verdict'>,
    ): Promise<Id<'surfaces'>> =>
      await harness.run(
        async (ctx): Promise<Id<'surfaces'>> =>
          await ctx.db.insert('surfaces', {
            agentId,
            displayName: fields.slug,
            class: 'kanban',
            whereFound: [],
            request: { expiresInDays: 30 },
            managerApprovedAt: PROPOSED_AT + DAY,
            itApprovedAt: PROPOSED_AT + DAY,
            credentialLanded: fields.verdict === 'connected',
            expiresAt: PROPOSED_AT + 30 * DAY,
            createdAt: 1,
            ...fields,
          }),
      );
    const connected = await legacy({ slug: 'linear', verdict: 'connected' });
    const approved = await legacy({ slug: 'notion', verdict: 'approved' });
    const ungranted = await legacy({ slug: 'looker', verdict: 'ungranted' });
    // Ended by the code before this release, whose event names no end date: it stays ended.
    const ended = await legacy({ slug: 'jira', verdict: 'approved', reason: 'expired' });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('events', {
        agentId,
        type: 'surface.expired',
        payload: { surfaceId: ended },
        createdAt: PROPOSED_AT + 10 * DAY,
      });
    });
    const declared = await seedDeclared(harness, agentId, 'Slack', 'chat');
    // Ended by this release's sweep on the proposal clock after the push, before the page ran.
    const swept = await legacy({
      slug: 'github',
      verdict: 'connected',
      expiresAt: PROPOSED_AT + 19 * DAY,
    });
    await harness.mutation(internal.surfaces.recordExpired, {
      surfaceId: swept,
      now: PROPOSED_AT + 19 * DAY,
    });
    const upgradedAt = PROPOSED_AT + 20 * DAY;
    vi.setSystemTime(upgradedAt);

    await expect(
      harness.mutation(internal.migrations.runMigrationPage, { name: 'surfaces-access-clock' }),
    ).resolves.toMatchObject({ name: 'surfaces-access-clock', changed: 4 });
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'surfaces-access-clock')).toMatchObject({
      changed: 4,
      completedAt: upgradedAt,
    });
    vi.setSystemTime(upgradedAt + DAY);
    await expect(
      harness.mutation(internal.migrations.runMigrationPage, { name: 'surfaces-access-clock' }),
    ).resolves.toMatchObject({ finishedEarlier: true, changed: 4 });

    const restarted = await readSurface(harness, swept);
    expect(restarted).toMatchObject({ verdict: 'approved', expiresAt: upgradedAt + 90 * DAY });
    expect(restarted.reason).toBeUndefined();
    const probes = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    const probed = probes
      .filter((job) => job.name === 'surfaceActions:probeInternal')
      .map((job) => (job.args[0] as { surfaceId: unknown }).surfaceId);
    expect(probed.filter((surfaceId) => surfaceId === swept)).toHaveLength(1);
    expect(probed).not.toContain(ended);
    expect((await readSurface(harness, ended)).reason).toBe('expired');

    for (const surfaceId of [connected, approved, ungranted]) {
      expect((await readSurface(harness, surfaceId)).expiresAt).toBe(upgradedAt + 90 * DAY);
    }
    expect((await readSurface(harness, ended)).expiresAt).toBe(PROPOSED_AT + 30 * DAY);
    expect((await readSurface(harness, declared)).expiresAt).toBeUndefined();
    expect((await readSurface(harness, current)).expiresAt).toBe(APPROVED_AT + 30 * DAY);
    expect(
      (await payloads(harness, 'surface.access-set')).filter(
        (payload) => (payload as { by?: unknown }).by === 'upgrade',
      ),
    ).toEqual([
      ...[connected, approved, ungranted].map((surfaceId) => ({
        surfaceId,
        by: 'upgrade',
        days: 90,
        from: PROPOSED_AT + 30 * DAY,
        expiresAt: upgradedAt + 90 * DAY,
      })),
      {
        surfaceId: swept,
        by: 'upgrade',
        days: 90,
        from: PROPOSED_AT + 19 * DAY,
        expiresAt: upgradedAt + 90 * DAY,
        renewed: true,
      },
    ]);
  });
});

describe('the read grant on reconnect (Q7)', (): void => {
  /**
   * Take one probe of a surface to `connected`.
   *
   * Args:
   *   harness: Convex test harness.
   *   surfaceId: An approved or failed surface.
   *   verifiedAt: When the probe succeeded.
   */
  async function connect(
    harness: TestConvex<typeof schema>,
    surfaceId: Id<'surfaces'>,
    verifiedAt: number,
  ): Promise<void> {
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation: probe.generation,
      toolAllowlist: ['list_issues'],
      toolArguments: [],
      verifiedAt,
    });
  }

  /**
   * Fail one probe of a surface to `listed-dead`, as a provider blip does.
   *
   * Args:
   *   harness: Convex test harness.
   *   surfaceId: A connected surface.
   */
  async function blip(
    harness: TestConvex<typeof schema>,
    surfaceId: Id<'surfaces'>,
  ): Promise<void> {
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await harness.mutation(internal.surfaces.recordProbeFailure, {
      surfaceId,
      generation: probe.generation,
      verdict: 'listed-dead',
      reason: 'provider returned 502',
    });
  }

  /**
   * Whether the agent holds an active grant of one scope.
   *
   * Args:
   *   harness: Convex test harness.
   *   agentId: The agent.
   *   scope: The scope.
   *
   * Returns:
   *   True while a grant of the scope is not revoked.
   */
  async function holds(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
    scope: string,
  ): Promise<boolean> {
    return await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (index) => index.eq('agentId', agentId).eq('scope', scope))
          .collect()
      ).some((grant): boolean => grant.revokedAt === undefined),
    );
  }

  it('never restores a read scope the manager revoked after approval when a blip reconnects', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, { verdict: 'approved', managerApprovedAt: 1, itApprovedAt: 1 });
    });
    await connect(harness, surfaceId, 100);
    expect(await holds(harness, agentId, 'linear:read')).toBe(true);

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.agents.revokeScope, { agentId, scope: 'linear:read' });
    await blip(harness, surfaceId);
    await connect(harness, surfaceId, 200);

    expect((await readSurface(harness, surfaceId)).verdict).toBe('connected');
    expect(await holds(harness, agentId, 'linear:read')).toBe(false);
    expect(
      (await eventTypes(harness)).filter((type) => type === 'permission.granted'),
    ).toHaveLength(1);
  });

  it('grants the read scope again when the card is approved after the revocation', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, { verdict: 'approved', managerApprovedAt: 1, itApprovedAt: 1 });
    });
    await connect(harness, surfaceId, 100);
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.agents.revokeScope, { agentId, scope: 'linear:read' });
    const reapprovedAt = Date.now() + 1_000;
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, {
        verdict: 'approved',
        managerApprovedAt: reapprovedAt,
        itApprovedAt: reapprovedAt,
      });
    });

    await connect(harness, surfaceId, reapprovedAt + 1);

    expect(await holds(harness, agentId, 'linear:read')).toBe(true);
  });
});

describe('a replaceable manager on the surface row', (): void => {
  const LEFT_WORKSPACE =
    'the manager email left@day0.local is not a member of this Slack workspace (users_not_found).';

  /**
   * Seed an approved Slack surface whose ladder has a lower rung.
   *
   * Args:
   *   harness: Convex test harness.
   *   verdict: The verdict the last probe left.
   *
   * Returns:
   *   The surface id.
   */
  async function seedSlackWithLadder(
    harness: TestConvex<typeof schema>,
    verdict: 'ungranted' | 'listed-dead',
  ): Promise<Id<'surfaces'>> {
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId, 'Slack', 'chat');
    await harness.mutation(internal.surfaces.propose, {
      surfaceId,
      request: { target: { system: 'Slack' } },
      whereFound: [],
      path: 'documented-api',
      fallbackPath: 'browser-driven',
      pathCandidates: [
        { path: 'documented-api', endpoint: 'https://slack.com/api' },
        { path: 'browser-driven', endpoint: 'https://app.slack.com' },
      ],
      endpoint: 'https://slack.com/api',
      expiresInDays: 30,
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(surfaceId, { verdict, managerApprovedAt: 10, itApprovedAt: 11 });
    });
    return surfaceId;
  }

  it('keeps the working route when the probe failed on the manager lookup', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedSlackWithLadder(harness, 'ungranted');
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await expect(
      harness.mutation(internal.surfaces.demoteAfterProbeFailure, {
        surfaceId,
        generation: probe.generation,
        reason: LEFT_WORKSPACE,
        attemptedAt: 100,
      }),
    ).resolves.toBeNull();
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      path: 'documented-api',
      endpoint: 'https://slack.com/api',
    });
  });

  it('still descends the ladder for a failure of the route itself', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedSlackWithLadder(harness, 'listed-dead');
    const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!probe) throw new Error('probe was not reserved');
    await expect(
      harness.mutation(internal.surfaces.demoteAfterProbeFailure, {
        surfaceId,
        generation: probe.generation,
        reason: 'connect ETIMEDOUT',
        attemptedAt: 100,
      }),
    ).resolves.toMatchObject({ surface: { path: 'browser-driven' } });
  });

  it('records manager.changed when a re-probe resolves a different Slack user, once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId, 'Slack', 'chat');
    await harness.mutation(internal.surfaces.setStatus, { surfaceId, verdict: 'approved' });
    const connect = async (managerUserId: string, verifiedAt: number): Promise<void> => {
      const probe = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
      if (!probe) throw new Error('probe was not reserved');
      await harness.mutation(internal.surfaces.recordConnected, {
        surfaceId,
        generation: probe.generation,
        toolAllowlist: ['chat.postMessage'],
        toolArguments: [],
        managerDmChannelId: `D${managerUserId}`,
        managerUserId,
        managerName: managerUserId,
        verifiedAt,
      });
    };
    await connect('UFIRST', 100);
    await connect('UFIRST', 200);
    await connect('USECOND', 300);
    await connect('USECOND', 400);
    const changes = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect())
        .filter((event): boolean => event.type === 'manager.changed')
        .map((event) => ({ payload: event.payload, createdAt: event.createdAt })),
    );
    expect(changes).toEqual([
      {
        payload: {
          surfaceId,
          via: 'probe',
          previousManagerUserId: 'UFIRST',
          managerUserId: 'USECOND',
        },
        createdAt: 300,
      },
    ]);
  });
});

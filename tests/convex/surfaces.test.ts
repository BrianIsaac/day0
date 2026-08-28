import { convexTest, type TestConvex } from 'convex-test';
import type { GenericId } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { surfaceSlug } from '../../convex/surfaces';
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

  it('persists only the latest successful generation and renews expiry only when asked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await propose(harness, surfaceId);
    await harness.mutation(internal.surfaces.setStatus, { surfaceId, verdict: 'approved' });
    const first = await harness.mutation(internal.surfaces.beginProbe, { surfaceId });
    if (!first) throw new Error('probe was not reserved');
    const renewedExpiry = 9_000_000_000_000;
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
        expiresAt: renewedExpiry,
      }),
    ).resolves.toBe(true);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: 100,
      expiresAt: renewedExpiry,
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
      expiresAt: renewedExpiry,
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
    expect((await eventTypes(harness)).filter((type) => type === 'work.requeued')).toHaveLength(2);
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
    expect(expired?.payload).toEqual({ surfaceId });
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

import { convexTest, type TestConvex } from 'convex-test';
import type { GenericId } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { surfaceSlug } from '../../convex/surfaces';
import { convexModules } from './modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
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

  it('seeds once and exposes rows only to the owner', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
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

  it('records an explicit absence with its search terms', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
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

  it('uses compare-and-set writes so an orientation retry cannot overwrite a decision', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
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

describe('surface probe generations', (): void => {
  it('rejects ineligible rows and ignores results from an older probe', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    await expect(
      harness.mutation(internal.surfaces.beginProbe, { surfaceId }),
    ).resolves.toBeNull();
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
    const harness = convexTest(schema, convexModules);
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
    const failure = await harness.run(
      async (ctx) =>
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
    const harness = convexTest(schema, convexModules);
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
        verifiedAt: 100,
        expiresAt: renewedExpiry,
      }),
    ).resolves.toBe(true);
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: 100,
      expiresAt: renewedExpiry,
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
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'connected',
      lastVerifiedAt: 200,
      expiresAt: renewedExpiry,
    });
    const connectedEvents = await harness.run(
      async (ctx) =>
        (await ctx.db.query('events').collect()).filter(
          (event): boolean => event.type === 'surface.connected',
        ),
    );
    expect(connectedEvents).toHaveLength(2);
    expect(connectedEvents.map((event) => event.payload)).toEqual([
      { surfaceId },
      { surfaceId },
    ]);
  });
});

describe('surface connection lifecycle metadata', (): void => {
  it('returns an approved failed surface to probing when IT lands a credential', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
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
      credentialLocation: 'entered by IT approver',
    });
    expect(await readSurface(harness, surfaceId)).toMatchObject({
      verdict: 'approved',
      credentialId: '10000credentials',
      credentialLocation: 'entered by IT approver',
      credentialLanded: false,
    });
    expect((await readSurface(harness, surfaceId)).reason).toBeUndefined();
  });

  it('demotes an expired connection and records a safe lifecycle event', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
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
    const expired = await harness.run(
      async (ctx) =>
        (await ctx.db.query('events').collect()).find(
          (event): boolean => event.type === 'surface.expired',
        ),
    );
    expect(expired?.payload).toEqual({ surfaceId });
  });

  it('records waterfall skips and clears them after a successful poll', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
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
  it('requires both approvals and emits surface.approved exactly once', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
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

  it('refuses to approve a surface that is not proposed', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
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
    const harness = convexTest(schema, convexModules);
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
    const harness = convexTest(schema, convexModules);
    const agentId = await seedAgent(harness);
    const surfaceId = await seedDeclared(harness, agentId);
    const owner = harness.withIdentity({ subject: 'owner' });

    await propose(harness, surfaceId);
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'manager' });
    await owner.mutation(api.surfaces.reject, { surfaceId, reason: 'Wrong endpoint.' });
    const rejected = await readSurface(harness, surfaceId);
    expect(rejected).toMatchObject({ verdict: 'declared', reason: 'Wrong endpoint.' });
    expect(rejected.managerApprovedAt).toBeUndefined();
    expect(rejected.itApprovedAt).toBeUndefined();
    expect(rejected.endpoint).toBeUndefined();
    expect(rejected.path).toBeUndefined();
    expect(rejected.request).toBeUndefined();
    expect(rejected.credentialLanded).toBe(false);

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
    const harness = convexTest(schema, convexModules);
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
    const harness = convexTest(schema, convexModules);
    const agentId = await seedAgent(harness);
    await expect(
      harness.withIdentity({ subject: 'other-owner' }).action(api.surfaces.reorient, { agentId }),
    ).rejects.toThrow('forbidden');
  });

  it('refuses reorient outside real mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, convexModules);
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

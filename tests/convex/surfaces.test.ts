import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { surfaceSlug } from '../../convex/surfaces';
import { convexModules } from './modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
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
    credentialRef: 'LINEAR_API_KEY',
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

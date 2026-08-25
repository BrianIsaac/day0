import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { surfaceSlug } from '../../convex/surfaces';
import { convexModules } from './modules';

/**
 * Seed an owned agent for surface mutation tests.
 *
 * Args:
 *   harness: Convex test harness.
 *
 * Returns:
 *   The new agent id.
 */
async function seedAgent(harness: ReturnType<typeof convexTest>): Promise<Id<'agents'>> {
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

describe('surface persistence', (): void => {
  it('creates stable slugs from manager-named systems', (): void => {
    expect(surfaceSlug('Northstar CRM')).toBe('northstar-crm');
    expect(surfaceSlug(' Linear / REVOPS ')).toBe('linear-revops');
  });

  it('seeds once and exposes rows only to the owner', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    const agentId = await seedAgent(harness);
    const namedSystems = [
      { name: 'Linear', class: 'kanban', whereMentioned: 'Formal work is in Linear.' },
    ];
    await harness.mutation(internal.surfaces.seedFromCharter, { agentId, namedSystems });
    await harness.mutation(internal.surfaces.seedFromCharter, { agentId, namedSystems });
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.query(api.surfaces.listForAgent, { agentId })).resolves.toHaveLength(1);
    await expect(
      harness
        .withIdentity({ subject: 'other-owner' })
        .query(api.surfaces.listForAgent, { agentId }),
    ).rejects.toThrow('forbidden');
  });

  it('persists a proposal and requires both approvals', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    const agentId = await seedAgent(harness);
    await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [
        { name: 'Linear', class: 'kanban', whereMentioned: 'Formal work is in Linear.' },
      ],
    });
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .unique();
      if (!row) throw new Error('surface was not seeded');
      return row._id;
    });
    await harness.mutation(internal.surfaces.propose, {
      surfaceId,
      request: { target: { system: 'Linear' } },
      whereFound: [{ ref: 'runbook.md', quote: 'Use Linear MCP.' }],
      path: 'mcp',
      fallbackPath: 'escalate',
      endpoint: 'https://mcp.linear.app/mcp',
      credentialRef: 'LINEAR_API_KEY',
    });

    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'manager' });
    await expect(owner.query(api.surfaces.listForAgent, { agentId })).resolves.toMatchObject([
      { verdict: 'proposed', managerApprovedAt: expect.any(Number) },
    ]);
    await owner.mutation(api.surfaces.approve, { surfaceId, role: 'it' });
    await expect(owner.query(api.surfaces.listForAgent, { agentId })).resolves.toMatchObject([
      { verdict: 'approved', itApprovedAt: expect.any(Number) },
    ]);
    const eventTypes = await harness.run(
      async (ctx): Promise<string[]> =>
        (await ctx.db.query('events').collect()).map((event): string => event.type),
    );
    expect(eventTypes).toEqual(
      expect.arrayContaining(['surface.proposed', 'surface.oriented', 'surface.approved']),
    );
  });

  it('records an explicit absence with its search terms', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    const agentId = await seedAgent(harness);
    await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [
        { name: 'Northstar CRM', class: 'crm', whereMentioned: 'Account context is in CRM.' },
      ],
    });
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (index) => index.eq('agentId', agentId))
        .unique();
      if (!row) throw new Error('surface was not seeded');
      return row._id;
    });
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

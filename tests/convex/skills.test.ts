/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

afterEach((): void => {
  restoreSurfaceMode();
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

async function seedAgentAndWork(
  harness: Harness,
  sourceSystem: string,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem,
      externalId: 'REVOPS-1',
      title: 'Add the close-summary audit note',
      contentSummary: 'Synthetic.',
      contentRefs: [],
      state: 'needs-skill',
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

async function seedSurface(
  harness: Harness,
  agentId: Id<'agents'>,
  verdict: Doc<'surfaces'>['verdict'],
  liveness: { credentialLanded: boolean; lastVerifiedAt?: number },
): Promise<void> {
  await harness.run(async (ctx) => {
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict,
      whereFound: [],
      endpoint: 'https://mcp.linear.app/mcp',
      createdAt: 1,
      ...liveness,
    });
  });
}

async function propose(harness: Harness, agentId: Id<'agents'>, workItemId: Id<'workItems'>): Promise<Id<'skills'>> {
  return await harness.mutation(internal.skills.propose, {
    agentId,
    workItemId,
    name: 'update-linear-ticket',
    description: 'Comment on and close a Linear ticket.',
    rationale: 'No skill handles linear work yet.',
    requiredScopes: ['boss:message', 'linear:read', 'linear:write'],
  });
}

describe('skills that target a surface', (): void => {
  it('names the source surface and its read and write scopes when the work came from one', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'proposed', { credentialLanded: false });
    const skillId = await propose(harness, agentId, workItemId);
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.targetSurface).toBe('linear');
    expect(skill?.requiredScopes).toEqual(['boss:message', 'linear:read', 'linear:write']);
  });

  it('adds the surface scopes even when the proposer only asked for the boss scope', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'connected', { credentialLanded: true, lastVerifiedAt: Date.now() });
    const skillId = await harness.mutation(internal.skills.propose, {
      agentId,
      workItemId,
      name: 'x',
      description: 'y',
      rationale: 'z',
      requiredScopes: ['boss:message'],
    });
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.requiredScopes).toEqual(['boss:message', 'linear:read', 'linear:write']);
  });

  it('leaves a mock-era skill without a target surface', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'tickets');
    const skillId = await propose(harness, agentId, workItemId);
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.targetSurface).toBeUndefined();
    expect(skill?.requiredScopes).toEqual(['boss:message', 'linear:read', 'linear:write']);
    await expect(harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId })).resolves.toEqual({ ok: true });
  });

  it('refuses approval while the target surface is not connected', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'approved', { credentialLanded: false });
    const skillId = await propose(harness, agentId, workItemId);
    await expect(harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId })).rejects.toThrow(
      'cannot approve "update-linear-ticket": surface linear is ungranted; connect it on the Surfaces tab before approving this skill',
    );
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.state).toBe('proposed');
    const grants = await harness.run(async (ctx) => await ctx.db.query('permissionGrants').collect());
    expect(grants).toEqual([]);
  });

  it('refuses approval when the target surface has gone stale', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'connected', { credentialLanded: true, lastVerifiedAt: Date.now() - 7 * 60 * 60 * 1000 });
    const skillId = await propose(harness, agentId, workItemId);
    await expect(harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId })).rejects.toThrow('surface linear is listed-dead');
  });

  it('approves and grants the surface scopes once the surface is connected', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'connected', { credentialLanded: true, lastVerifiedAt: Date.now() });
    const skillId = await propose(harness, agentId, workItemId);
    await expect(harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId })).resolves.toEqual({ ok: true });
    const grants = await harness.run(async (ctx) => await ctx.db.query('permissionGrants').collect());
    expect(grants.map((grant) => grant.scope).sort()).toEqual(['boss:message', 'linear:read', 'linear:write']);
  });
});

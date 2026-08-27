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

describe('rejecting a proposed skill', (): void => {
  it('cancels the work item it was proposed for and records why', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const skillId = await propose(harness, agentId, workItemId);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.skills.reject, { skillId });
    const [skill, work] = await harness.run(async (ctx) => [await ctx.db.get(skillId), await ctx.db.get(workItemId)]);
    expect(skill?.state).toBe('rejected');
    expect(work).toMatchObject({
      state: 'cancelled',
      skipReason: 'skill proposal "update-linear-ticket" rejected by the manager',
    });
    await expect(harness.withIdentity({ subject: 'owner' }).mutation(api.skills.reject, { skillId })).resolves.toEqual({ ok: true });
  });

  it('does not cancel source work that moved on before the proposal was rejected', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const skillId = await propose(harness, agentId, workItemId);
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'completed',
        output: { applied: [{ tool: 'mcp.call', ok: true, idempotencyKey: 'already:landed:0' }] },
      });
    });

    await harness.withIdentity(OWNER).mutation(api.skills.reject, { skillId });

    expect((await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.state).toBe('completed');
  });

  it('does not cancel work that is now waiting for a different proposal', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const staleSkillId = await propose(harness, agentId, workItemId);
    const currentSkillId = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('skills', {
        agentId,
        name: 'current-proposal',
        description: 'Current proposal.',
        body: '',
        sourceType: 'agent-authored',
        state: 'proposed',
        proposedFor: workItemId,
        createdAt: 2,
      });
      await ctx.db.patch(workItemId, { proposedSkillId: id });
      return id;
    });

    await harness.withIdentity(OWNER).mutation(api.skills.reject, { skillId: staleSkillId });

    expect(await harness.run(async (ctx) => await ctx.db.get(workItemId))).toMatchObject({
      state: 'needs-skill',
      proposedSkillId: currentSkillId,
    });
  });
});

describe('skills that target a surface', (): void => {
  it('refuses to create a proposal against another agent\'s work', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const first = await seedAgentAndWork(harness, 'linear');
    const second = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'second@day0.local',
        name: 'Second',
        userId: 'second-owner',
        state: 'active',
        createdAt: 1,
      });
      return agentId;
    });
    await expect(propose(harness, second, first.workItemId)).rejects.toThrow(
      'skill and work item belong to different agents',
    );
    expect(await harness.run(async (ctx) => await ctx.db.query('skills').collect())).toEqual([]);
  });

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

  it('targets a different system literally named by cross-surface work', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'connected', {
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
    });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(workItemId, { title: 'Refresh the Looker pipeline tile' });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker',
        class: 'analytics',
        verdict: 'connected',
        whereFound: [],
        path: 'browser-driven',
        endpoint: 'http://looker-tile:8080/',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        createdAt: 1,
      });
    });

    const skillId = await propose(harness, agentId, workItemId);
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.targetSurface).toBe('looker');
    expect(skill?.requiredScopes).toEqual([
      'boss:message',
      'linear:read',
      'looker:read',
      'looker:write',
    ]);
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

  it('targets an unlisted real source so approval cannot bypass connection', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'northstar');
    const skillId = await propose(harness, agentId, workItemId);
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.targetSurface).toBe('northstar');
    expect(skill?.requiredScopes).toContain('northstar:write');
    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).rejects.toThrow(
      'cannot approve "update-linear-ticket": surface northstar is not listed for this agent',
    );
  });

  it('fails loudly when duplicate surface slugs make the target ambiguous', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'proposed', { credentialLanded: false });
    await seedSurface(harness, agentId, 'approved', { credentialLanded: false });
    await expect(propose(harness, agentId, workItemId)).rejects.toThrow(
      'more than one surface is listed with slug linear',
    );
  });

  it('grows the required scopes when the same proposal is requested again', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'connected', {
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
    });
    const first = await harness.mutation(internal.skills.propose, {
      agentId,
      workItemId,
      name: 'x',
      description: 'y',
      rationale: 'z',
      requiredScopes: ['boss:message'],
    });
    const second = await harness.mutation(internal.skills.propose, {
      agentId,
      workItemId,
      name: 'x',
      description: 'y',
      rationale: 'z',
      requiredScopes: ['audit:write'],
    });
    expect(second).toBe(first);
    const skill = await harness.run(async (ctx) => await ctx.db.get(first));
    expect(skill?.requiredScopes).toEqual([
      'boss:message',
      'linear:read',
      'linear:write',
      'audit:write',
    ]);
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

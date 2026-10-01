/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { PROPOSAL_AFTER_HANDOVER } from '../../convex/skills';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

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
const OWNER = managerIdentity();

async function seedAgentAndWork(
  harness: Harness,
  sourceSystem: string,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
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

async function propose(
  harness: Harness,
  agentId: Id<'agents'>,
  workItemId: Id<'workItems'>,
): Promise<Id<'skills'>> {
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
    await harness.withIdentity(managerIdentity()).mutation(api.skills.reject, { skillId });
    const [skill, work] = await harness.run(async (ctx) => [
      await ctx.db.get(skillId),
      await ctx.db.get(workItemId),
    ]);
    expect(skill?.state).toBe('rejected');
    expect(work).toMatchObject({
      state: 'cancelled',
      skipReason: 'skill proposal "update-linear-ticket" rejected by the manager',
    });
    const cancelled = (
      await harness.run(async (ctx) => await ctx.db.query('events').collect())
    ).filter((event) => event.type === 'work.cancelled');
    expect(cancelled.map((event) => event.payload)).toEqual([
      {
        workItemId,
        skillId,
        reason: 'skill proposal "update-linear-ticket" rejected by the manager',
      },
    ]);
    await expect(
      harness.withIdentity(managerIdentity()).mutation(api.skills.reject, { skillId }),
    ).resolves.toEqual({ ok: true });
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

    expect((await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.state).toBe(
      'completed',
    );
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

describe('retiring a registered skill that predates shapes', (): void => {
  async function seedRegistered(
    harness: Harness,
    agentId: Id<'agents'>,
    row: Partial<Doc<'skills'>> & Pick<Doc<'skills'>, 'name'>,
  ): Promise<Id<'skills'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId,
          description: 'Registered.',
          body: 'The sole approved value for this skill is 74% for REVOPS-7.',
          sourceType: 'agent-authored',
          state: 'registered',
          createdAt: 1,
          registeredAt: 1,
          ...row,
        }),
    );
  }

  it('moves the per-ticket row out of the registry, keeps it, and records why', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedAgentAndWork(harness, 'linear');
    const legacy = await seedRegistered(harness, agentId, { name: 'linear-action-revops-7' });

    await expect(
      harness.mutation(internal.skills.retireUnshaped, { skillId: legacy }),
    ).resolves.toEqual({
      retired: true,
    });
    const row = await harness.run(async (ctx) => await ctx.db.get(legacy));
    expect(row).toMatchObject({ state: 'rejected', name: 'linear-action-revops-7' });
    expect(row?.body).toContain('74%');
    await expect(harness.query(internal.skills.registeredInternal, { agentId })).resolves.toEqual(
      [],
    );
    const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events.find((event) => event.type === 'skill.retired')?.payload).toMatchObject({
      skillId: legacy,
      name: 'linear-action-revops-7',
    });
    await expect(
      harness.mutation(internal.skills.retireUnshaped, { skillId: legacy }),
    ).resolves.toEqual({
      retired: false,
      reason: 'already retired',
    });
  });

  it('refuses a shaped skill, a builtin skill and a row that is not registered', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedAgentAndWork(harness, 'linear');
    const shaped = await seedRegistered(harness, agentId, {
      name: 'kanban-comment-and-close',
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
    });
    const builtin = await seedRegistered(harness, agentId, {
      name: 'see-docs',
      sourceType: 'builtin',
    });
    const proposed = await seedRegistered(harness, agentId, {
      name: 'slack-action-c0b',
      state: 'proposed',
    });

    await expect(
      harness.mutation(internal.skills.retireUnshaped, { skillId: shaped }),
    ).rejects.toThrow('is the reusable procedure for kanban/comment-and-close');
    await expect(
      harness.mutation(internal.skills.retireUnshaped, { skillId: builtin }),
    ).rejects.toThrow('a builtin skill is installed, not authored');
    await expect(
      harness.mutation(internal.skills.retireUnshaped, { skillId: proposed }),
    ).rejects.toThrow('skill state is proposed; only a registered skill is retired');
    const states = await harness.run(async (ctx) =>
      (await ctx.db.query('skills').collect()).map((row) => [row.name, row.state]),
    );
    expect(states).toEqual([
      ['kanban-comment-and-close', 'registered'],
      ['see-docs', 'registered'],
      ['slack-action-c0b', 'proposed'],
    ]);
  });
});

describe('revising a registered authored skill', (): void => {
  it('opens a revision beside the registered skill and leaves its source work where it is', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const skillId = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('skills', {
        agentId,
        name: 'bad-browser-contract',
        description: 'Refresh a browser tile.',
        body: 'uses the wrong selector',
        sourceType: 'agent-authored',
        state: 'registered',
        proposedFor: workItemId,
        registeredAt: 2,
        sandboxId: 'sandbox-1',
        verificationLog: 'shape passed',
        createdAt: 1,
      });
      await ctx.db.patch(workItemId, { state: 'discovered', proposedSkillId: id });
      return id;
    });

    const opened = await harness
      .withIdentity(OWNER)
      .mutation(api.skills.requestRevision, { skillId });

    const [skill, revision, work, events] = await harness.run(async (ctx) => [
      await ctx.db.get(skillId),
      await ctx.db.get(opened.revisionId),
      await ctx.db.get(workItemId),
      await ctx.db.query('events').collect(),
    ]);
    // The registered row runs on, unchanged, until the revision registers in its place.
    expect(skill).toMatchObject({
      state: 'registered',
      body: 'uses the wrong selector',
      registeredAt: 2,
      sandboxId: 'sandbox-1',
      verificationLog: 'shape passed',
    });
    expect(revision).toMatchObject({
      state: 'approved',
      name: 'bad-browser-contract',
      body: '',
      revisionOf: skillId,
      proposedFor: workItemId,
    });
    expect(work?.state).toBe('discovered');
    expect(events.at(-1)).toMatchObject({
      type: 'skill.revision-requested',
      payload: { skillId, name: 'bad-browser-contract', revisionId: opened.revisionId },
    });
  });

  it('opens a revision after an execution has claimed the skill, keeping the run’s history', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const skillId = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('skills', {
        agentId,
        name: 'already-used',
        description: 'Already used.',
        body: 'valid',
        sourceType: 'agent-authored',
        state: 'registered',
        proposedFor: workItemId,
        createdAt: 1,
      });
      await ctx.db.patch(workItemId, { skillId: id, state: 'completed' });
      return id;
    });

    const { revisionId } = await harness
      .withIdentity(OWNER)
      .mutation(api.skills.requestRevision, { skillId });

    const [skill, revision, work] = await harness.run(async (ctx) => [
      await ctx.db.get(skillId),
      await ctx.db.get(revisionId),
      await ctx.db.get(workItemId),
    ]);
    expect(skill).toMatchObject({ state: 'registered', body: 'valid' });
    expect(revision).toMatchObject({ state: 'approved', revisionOf: skillId });
    expect(work).toMatchObject({ state: 'completed', skillId });
  });
});

describe('a revision whatever the source work is doing', (): void => {
  /**
   * Seed a registered authored skill whose source work is in a given state.
   *
   * Args:
   *   harness: Convex test harness.
   *   state: The source work's state.
   *
   * Returns:
   *   The skill and its source work.
   */
  async function registeredWithSource(
    harness: ReturnType<typeof convexTest>,
    state: Doc<'workItems'>['state'],
  ): Promise<{ skillId: Id<'skills'>; workItemId: Id<'workItems'> }> {
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const skillId = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment',
        description: 'Comment on a ticket.',
        body: 'Comment with the figures.',
        sourceType: 'agent-authored',
        state: 'registered',
        proposedFor: workItemId,
        registeredAt: 2,
        createdAt: 1,
      });
      await ctx.db.patch(workItemId, { state, proposedSkillId: id });
      return id;
    });
    return { skillId, workItemId };
  }

  // History is kept: the current row runs on whatever its source work is doing, so the window
  // the in-place revision needed is gone.
  it.each([
    'deferred',
    'claimed',
    'plan-pending',
    'plan-approved',
    'executing',
    'completed',
  ] as const)(
    'opens a revision while the source work is %s and leaves that work where it is',
    async (state): Promise<void> => {
      useSurfaceMode('real');
      const harness = convexTest(schema, allConvexModules());
      const { skillId, workItemId } = await registeredWithSource(harness, state);

      const { revisionId } = await harness
        .withIdentity(OWNER)
        .mutation(api.skills.requestRevision, { skillId });

      const [skill, revision, work] = await harness.run(async (ctx) => [
        await ctx.db.get(skillId),
        await ctx.db.get(revisionId),
        await ctx.db.get(workItemId),
      ]);
      expect(skill).toMatchObject({ state: 'registered', body: 'Comment with the figures.' });
      expect(revision).toMatchObject({ state: 'approved', revisionOf: skillId, body: '' });
      expect(work?.state).toBe(state);
    },
  );
});

describe('skills that target a surface', (): void => {
  it("refuses to create a proposal against another agent's work", async (): Promise<void> => {
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
    await seedSurface(harness, agentId, 'connected', {
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
    });
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

  it('stores the surface class and operation the proposal was shaped by', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'ticket');
    const skillId = await harness.mutation(internal.skills.propose, {
      agentId,
      workItemId,
      name: 'kanban-comment-and-close',
      description: 'Ticket comment-and-close on a kanban surface.',
      rationale: 'No registered skill covers ticket comment-and-close on a kanban surface.',
      requiredScopes: ['boss:message', 'ticket:read', 'ticket:write'],
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
    });
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill).toMatchObject({ surfaceClass: 'kanban', operation: 'comment-and-close' });
  });

  it('leaves a mock-era skill without a target surface', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'tickets');
    const skillId = await propose(harness, agentId, workItemId);
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.targetSurface).toBeUndefined();
    expect(skill?.requiredScopes).toEqual(['boss:message', 'linear:read', 'linear:write']);
    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).resolves.toEqual({ ok: true });
  });

  it('refuses a second approval, naming the skill and the state it is in', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'tickets');
    const skillId = await propose(harness, agentId, workItemId);
    await harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId });
    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).rejects.toThrow('cannot approve "update-linear-ticket": it is approved, not proposed');
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
    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).rejects.toThrow(
      'cannot approve "update-linear-ticket": surface linear is ungranted; connect it on the Surfaces tab before approving this skill',
    );
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.state).toBe('proposed');
    const grants = await harness.run(
      async (ctx) => await ctx.db.query('permissionGrants').collect(),
    );
    expect(grants).toEqual([]);
  });

  it('refuses approval when the target surface has gone stale', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'connected', {
      credentialLanded: true,
      lastVerifiedAt: Date.now() - 7 * 60 * 60 * 1000,
    });
    const skillId = await propose(harness, agentId, workItemId);
    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).rejects.toThrow('surface linear is listed-dead');
  });

  it('refuses approval when a connected browser surface has lost its component', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'looker');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'looker',
        displayName: 'Looker',
        class: 'analytics',
        verdict: 'connected',
        whereFound: [],
        path: 'browser-driven',
        endpoint: 'http://looker-tile:8080/',
        toolAllowlist: ['browser_navigate'],
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        createdAt: 1,
      });
    });
    const skillId = await propose(harness, agentId, workItemId);

    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).rejects.toThrow('surface looker is ungranted');
    expect((await harness.run(async (ctx) => await ctx.db.get(skillId)))?.state).toBe('proposed');
    expect(
      await harness.run(async (ctx) => await ctx.db.query('permissionGrants').collect()),
    ).toEqual([]);
  });

  it('approves and grants the surface scopes once the surface is connected', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await seedSurface(harness, agentId, 'connected', {
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
    });
    const skillId = await propose(harness, agentId, workItemId);
    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).resolves.toEqual({ ok: true });
    const grants = await harness.run(
      async (ctx) => await ctx.db.query('permissionGrants').collect(),
    );
    expect(grants.map((grant) => grant.scope).sort()).toEqual([
      'boss:message',
      'linear:read',
      'linear:write',
    ]);
    expect(grants.every((grant) => grant.source === 'skill')).toBe(true);
    const grantEvents = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'permission.granted',
      ),
    );
    expect(grantEvents.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        { scope: 'boss:message', source: 'skill' },
        { scope: 'linear:read', source: 'skill' },
        { scope: 'linear:write', source: 'skill' },
      ]),
    );
  });
});

describe('registration and the library (10-K)', (): void => {
  /** A shaped, approved skill of an owned employee. */
  async function approvedSkill(harness: Harness): Promise<Id<'skills'>> {
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'tickets');
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId,
          name: 'kanban-comment-and-close',
          description: 'Ticket comment-and-close.',
          body: '',
          sourceType: 'agent-authored',
          state: 'approved',
          proposedFor: workItemId,
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          createdAt: 1,
        }),
    );
  }

  it('registration keeps the passing smoke test', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const claimed = await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    if (!claimed.claimed) throw new Error(claimed.reason);

    await harness.mutation(internal.skills.completeRegistration, {
      skillId,
      runId: claimed.runId,
      body: '# Comment and close',
      verificationLog: 'ok: true',
      smokeTest: 'CASES = []\ndef run(inputs): return {"actions": []}',
    });

    const row = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(row?.state).toBe('registered');
    // Kept on the version, not on the row: `pendingSmokeTest` means a check not yet run.
    expect(row?.pendingSmokeTest).toBeUndefined();
    const version = await harness.run(async (ctx) => await ctx.db.get(row!.versionId!));
    expect(version?.smokeTest).toBe('CASES = []\ndef run(inputs): return {"actions": []}');
  });

  it('claimAuthoringRun counts attempts', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const attempts = async (): Promise<number | undefined> =>
      (await harness.run(async (ctx) => await ctx.db.get(skillId)))?.authoringAttempts;

    const first = await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    if (!first.claimed) throw new Error(first.reason);
    expect(await attempts()).toBe(1);
    // The first attempt fails; Retry is the second.
    await harness.mutation(internal.skills.failAuthoringRun, {
      skillId,
      runId: first.runId,
      rowReason: 'the static gate refused the draft',
      reason: 'the static gate refused the draft',
      eventType: 'skill.author-failed',
    });
    const second = await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    if (!second.claimed) throw new Error(second.reason);
    expect(await attempts()).toBe(2);
    // A provider outage defers the second attempt; its own retry carries it on, uncounted.
    await harness.mutation(internal.skills.deferAuthoringRun, {
      skillId,
      runId: second.runId,
      reason: 'the provider timed out',
    });
    const resumed = await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    expect(resumed.claimed).toBe(true);
    expect(await attempts()).toBe(2);
    // A second caller while the run holds the skill is refused and counts nothing.
    expect((await harness.mutation(internal.skills.claimAuthoringRun, { skillId })).claimed).toBe(
      false,
    );
    expect(await attempts()).toBe(2);
  });

  it('refuses to author a retired or a superseded row, saying which', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    for (const state of ['retired', 'superseded'] as const) {
      await harness.run(async (ctx) => await ctx.db.patch(skillId, { state }));
      expect(await harness.mutation(internal.skills.claimAuthoringRun, { skillId })).toEqual({
        claimed: false,
        reason: `this skill was ${state === 'retired' ? 'retired' : 'superseded by a revision'}`,
      });
    }
  });
});

describe('skills.reject and the work waiting for the skill (the wave 10 review, M9)', (): void => {
  it('releases the claim a cancelled item holds on its provider item', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'tickets');
    const skillId = await propose(harness, agentId, workItemId);
    const claim = await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { state: 'needs-skill', proposedSkillId: skillId });
      return await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:LIN-5',
        agentId,
        workItemId,
        claimedAt: 1,
      });
    });

    await harness.withIdentity(OWNER).mutation(api.skills.reject, { skillId });

    const [item, released] = await harness.run(async (ctx) => [
      await ctx.db.get(workItemId),
      await ctx.db.get(claim),
    ]);
    expect(item?.state).toBe('cancelled');
    expect(released?.releasedAt).toBeTypeOf('number');
  });
});

describe('skills.approve while a handover waits for its runs (U3-m3)', (): void => {
  /** A request of the employee's in `state`, naming the colleague. */
  async function seedTransfer(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
    state: 'asked' | 'accepting',
  ): Promise<void> {
    await harness.run(async (ctx) => {
      await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Maya',
        fromOwnerKey: 'owner',
        fromAddress: MANAGER_ADDRESS,
        toAddress: 'colleague@day0.local',
        state,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        ...(state === 'accepting'
          ? { decidedAt: Date.now(), toOwnerKey: 'colleague', settleBy: Date.now() + 900_000 }
          : {}),
      });
    });
  }

  it('refuses the old manager’s approval once the new one has accepted, and leaves the skill proposed', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'tickets');
    const skillId = await propose(harness, agentId, workItemId);
    await seedTransfer(harness, agentId, 'accepting');

    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).rejects.toMatchObject({
      data: expect.stringContaining('handover to colleague@day0.local was already accepted'),
    });

    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.state).toBe('proposed');
    const grants = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(grants.filter((grant) => grant.source === 'skill')).toEqual([]);
  });

  it('refuses the old manager’s request for a revision once the new one has accepted (the wave 10 review, M1)', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedAgentAndWork(harness, 'tickets');
    const skillId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId,
          name: 'ticket-comment-and-close',
          description: 'Close a ticket.',
          body: '# Close',
          sourceType: 'agent-authored',
          state: 'registered',
          registeredAt: 2,
          createdAt: 1,
        }),
    );
    await seedTransfer(harness, agentId, 'accepting');

    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.requestRevision, { skillId }),
    ).rejects.toMatchObject({
      data: expect.stringContaining('handover to colleague@day0.local was already accepted'),
    });
    const rows = await harness.run(async (ctx) => await ctx.db.query('skills').collect());
    expect(rows.filter((row) => row.agentId === agentId)).toHaveLength(1);
  });

  it('lets the old manager approve while the handover is only asked', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'tickets');
    const skillId = await propose(harness, agentId, workItemId);
    await seedTransfer(harness, agentId, 'asked');

    await expect(
      harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId }),
    ).resolves.toEqual({ ok: true });
  });
});

describe('skills.propose from an evaluation a handover overtook (U3-m2)', (): void => {
  /** The proposal the evaluation makes, as the owner it read the employee under. */
  const proposal = (agentId: Id<'agents'>, workItemId: Id<'workItems'>, startedUnder: string) => ({
    agentId,
    workItemId,
    name: 'update-linear-ticket',
    description: 'Comment on and close a Linear ticket.',
    rationale: 'No skill handles linear work yet.',
    requiredScopes: ['boss:message', 'linear:read', 'linear:write'],
    startedUnder,
  });

  it('proposes the skill while the employee is still the owner the evaluation read it under', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');

    const skillId = await harness.mutation(
      internal.skills.propose,
      proposal(agentId, workItemId, 'owner'),
    );

    expect((await harness.run(async (ctx) => await ctx.db.get(skillId)))?.state).toBe('proposed');
  });

  it('proposes nothing once the employee was handed to another owner', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { userId: 'colleague' });
    });

    await expect(
      harness.mutation(internal.skills.propose, proposal(agentId, workItemId, 'owner')),
    ).rejects.toThrow(PROPOSAL_AFTER_HANDOVER);
    expect(await harness.run(async (ctx) => await ctx.db.query('skills').collect())).toEqual([]);
  });
});

describe('proposing a name a retired or superseded row holds (10-A)', (): void => {
  for (const state of ['retired', 'superseded'] as const) {
    it(`a ${state} row does not block a later proposal of its name`, async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
      const old = await harness.run(
        async (ctx) =>
          await ctx.db.insert('skills', {
            agentId,
            name: 'update-linear-ticket',
            description: 'Comment on and close a Linear ticket.',
            body: '# Comment and close',
            sourceType: 'agent-authored',
            state,
            createdAt: 1,
            registeredAt: 1,
          }),
      );

      const proposed = await propose(harness, agentId, workItemId);

      expect(proposed).not.toBe(old);
      const row = await harness.run(async (ctx) => await ctx.db.get(proposed));
      expect(row).toMatchObject({ state: 'proposed', proposedFor: workItemId });
      expect((await harness.run(async (ctx) => await ctx.db.get(old)))?.state).toBe(state);
    });
  }
});

describe('the third failed attempt (10-C)', (): void => {
  it('the third failed attempt withdraws Retry: the authoring claim refuses it, and a stored verification still may run', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const failed = async (attempts: number): Promise<Id<'skills'>> =>
      await harness.run(
        async (ctx) =>
          await ctx.db.insert('skills', {
            agentId,
            name: `kanban-comment-and-close-${attempts}`,
            description: 'Comment and close.',
            body: '',
            sourceType: 'agent-authored',
            state: 'failed',
            proposedFor: workItemId,
            authoringAttempts: attempts,
            createdAt: 1,
          }),
      );
    const spent = await failed(3);
    const second = await failed(2);

    await expect(
      harness.mutation(internal.skills.claimAuthoringRun, { skillId: spent }),
    ).resolves.toEqual({
      claimed: false,
      reason: 'all 3 attempts at this skill failed; give it up instead',
    });
    const retried = await harness.mutation(internal.skills.claimAuthoringRun, {
      skillId: second,
    });
    expect(retried.claimed).toBe(true);
    expect((await harness.run(async (ctx) => await ctx.db.get(second)))?.authoringAttempts).toBe(3);
    const stored = await harness.mutation(internal.skills.claimAuthoringRun, {
      skillId: spent,
      purpose: 'verify-stored',
    });
    expect(stored.claimed).toBe(true);
  });
});

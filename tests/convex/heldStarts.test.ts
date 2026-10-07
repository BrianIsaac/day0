/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { approvedSkill } from './fakes/skill-work';
import { managerIdentity } from './fakes/manager-identity';
import { CRONS_PAUSED_FLAG } from '../../src/lib/crons-pause';
import { EMPLOYEE_PAUSED_REASON } from '../../src/work/pause';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

type Harness = TestConvex<typeof schema>;

const OWNER = managerIdentity();

/*
 * What a pause holds besides the work loop (the wave 12 review's D-8, recommendation (b); wave 13
 * item 6): a skill's authoring and a system's orientation are held at the same gate as every step
 * (`stepMayRun`'s rule), each hold recorded, and both go on at the resume or the sweep after it.
 */

async function pause(harness: Harness, agentId: Id<'agents'>): Promise<void> {
  await harness.run(async (ctx) => await ctx.db.patch(agentId, { pausedAt: 5, pausedBy: 'owner' }));
}

async function agentOf(harness: Harness, skillId: Id<'skills'>): Promise<Id<'agents'>> {
  const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (!skill) throw new Error('no skill');
  return skill.agentId;
}

async function eventsOf(harness: Harness, type: string): Promise<unknown[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect()))
    .filter((event) => event.type === type)
    .map((event) => event.payload);
}

async function scheduled(harness: Harness, name: string): Promise<unknown[]> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .filter((job) => job.state.kind === 'pending' && job.name === name)
    .map((job) => job.args[0]);
}

async function declaredSurface(harness: Harness, agentId: Id<'agents'>): Promise<Id<'surfaces'>> {
  return await harness.run(async (ctx) => {
    await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: { namedSystems: [{ name: 'Linear', class: 'kanban' }] },
    });
    return await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'declared',
      whereFound: [],
      credentialLanded: false,
      createdAt: 1,
    });
  });
}

describe("a paused employee's skill authoring (D-8 (b))", (): void => {
  it('is held at its claim with the reason the Skills card shows, recorded, and takes no claim', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    await pause(harness, await agentOf(harness, skillId));

    expect(await harness.mutation(internal.skills.claimAuthoringRun, { skillId })).toEqual({
      claimed: false,
      reason: 'held while Priya is paused: writing it starts when you resume Priya',
      held: true,
    });
    const row = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(row).toMatchObject({ state: 'approved' });
    expect(row?.authoringRunId).toBeUndefined();
    expect(row?.authoringAttempts).toBeUndefined();
    expect(await eventsOf(harness, 'skill.authoring-held')).toEqual([
      { skillId, name: 'kanban-comment-and-close', reason: EMPLOYEE_PAUSED_REASON },
    ]);
  });

  it('starts once the manager resumes the employee, and the sweep after does not start it again', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    await pause(harness, agentId);
    await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    // A second press while paused holds it again: one start at the resume all the same.
    await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    expect(await scheduled(harness, 'skillActions:authorAndRegisterSkillInternal')).toEqual([]);

    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });

    expect(await scheduled(harness, 'skillActions:authorAndRegisterSkillInternal')).toEqual([
      { skillId },
    ]);
    expect(await eventsOf(harness, 'skill.authoring-resumed')).toEqual([
      { skillId, name: 'kanban-comment-and-close' },
    ]);
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduled(harness, 'skillActions:authorAndRegisterSkillInternal')).toHaveLength(1);
  });

  it("is held while the deployment's scheduled work is paused, and the sweep starts it once that work runs", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv(CRONS_PAUSED_FLAG, 'upgrading');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);

    expect(await harness.mutation(internal.skills.claimAuthoringRun, { skillId })).toEqual({
      claimed: false,
      reason:
        "held while this deployment's scheduled work is paused: writing it starts once that work runs again",
      held: true,
    });
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduled(harness, 'skillActions:authorAndRegisterSkillInternal')).toEqual([]);

    vi.stubEnv(CRONS_PAUSED_FLAG, '');
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduled(harness, 'skillActions:authorAndRegisterSkillInternal')).toEqual([
      { skillId },
    ]);
  });

  it("answers the manager's press with the hold, so the Skills card can say it is held", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    await pause(harness, await agentOf(harness, skillId));

    expect(
      await harness.action(internal.skillActions.authorAndRegisterSkillInternal, { skillId }),
    ).toEqual({
      ok: false,
      reason: 'held while Priya is paused: writing it starts when you resume Priya',
      held: true,
    });
  });

  it('is spent by a later claim of the skill, so a resume never starts an authoring nobody asked for since (the second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    await pause(harness, agentId);
    await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    // A stored version's check (not held) claims the skill while paused, and then fails it.
    const check = await harness.mutation(internal.skills.claimAuthoringRun, {
      skillId,
      purpose: 'verify-stored',
    });
    if (!check.claimed) throw new Error(check.reason);
    await harness.mutation(internal.skills.failAuthoringRun, {
      skillId,
      runId: check.runId,
      rowReason: 'the stored skill failed its check',
      reason: 'the stored skill failed its check',
      eventType: 'skill.author-failed',
    });

    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });

    expect(await scheduled(harness, 'skillActions:authorAndRegisterSkillInternal')).toEqual([]);
  });

  it('does not count the held claim as a takeover of a lapsed run (the second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    const first = await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    if (!first.claimed) throw new Error(first.reason);
    // The run died holding the skill; its lease lapses while the employee is paused.
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    await pause(harness, agentId);
    await harness.mutation(internal.skills.claimAuthoringRun, { skillId });

    expect(await eventsOf(harness, 'skill.authoring-superseded')).toEqual([]);
    expect(await eventsOf(harness, 'skill.authoring-held')).toHaveLength(1);
  });

  it('holds nothing in mock mode, where a pause is refused and the page drives every step', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    await pause(harness, await agentOf(harness, skillId));

    expect((await harness.mutation(internal.skills.claimAuthoringRun, { skillId })).claimed).toBe(
      true,
    );
    expect(await eventsOf(harness, 'skill.authoring-held')).toEqual([]);
  });

  it('starts nothing at the resume for a held skill the manager has since rejected', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    await pause(harness, agentId);
    await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    await harness.run(async (ctx) => await ctx.db.patch(skillId, { state: 'rejected' }));

    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });

    expect(await scheduled(harness, 'skillActions:authorAndRegisterSkillInternal')).toEqual([]);
    expect(await eventsOf(harness, 'skill.authoring-resumed')).toEqual([]);
  });
});

describe('a held start the resume does not take up (W13-R46)', (): void => {
  it('spends the hold of a skill it does not start, saying why, so a later resume never starts it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    await pause(harness, agentId);
    await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
    await harness.run(async (ctx) => await ctx.db.patch(skillId, { state: 'rejected' }));
    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });

    expect(await eventsOf(harness, 'skill.authoring-hold-spent')).toEqual([
      { skillId, name: expect.any(String), why: 'decided' },
    ]);

    // The skill is approved again and the employee paused and resumed: the spent hold stays spent.
    await harness.run(async (ctx) => await ctx.db.patch(skillId, { state: 'approved' }));
    await pause(harness, agentId);
    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });
    expect(await scheduled(harness, 'skillActions:authorAndRegisterSkillInternal')).toEqual([]);
    expect(await eventsOf(harness, 'skill.authoring-hold-spent')).toHaveLength(1);
  });

  it('spends the hold of a system no longer waiting to be found, saying why', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    const surfaceId = await declaredSurface(harness, agentId);
    await pause(harness, agentId);
    await harness.action(internal.orientationActions.orientOne, { surfaceId });
    await harness.run(
      async (ctx) => await ctx.db.patch(surfaceId, { verdict: 'absent', reason: 'not documented' }),
    );
    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });

    expect(await eventsOf(harness, 'surface.orientation-hold-spent')).toEqual([
      { surfaceId, why: 'settled' },
    ]);
  });
});

describe("a paused employee's orientation (D-8 (b))", (): void => {
  it('is held before it reads anything, the card saying why, and recorded with how it was asked for', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    const surfaceId = await declaredSurface(harness, agentId);
    await pause(harness, agentId);

    expect(
      await harness.action(internal.orientationActions.orientOne, { surfaceId, requested: true }),
    ).toEqual({ outcome: 'held', surfaceId });
    expect(await harness.run(async (ctx) => await ctx.db.get(surfaceId))).toMatchObject({
      verdict: 'declared',
      reason: 'Orientation held while Priya is paused: it starts when you resume Priya.',
    });
    expect(await eventsOf(harness, 'surface.orientation-held')).toEqual([
      { surfaceId, reason: EMPLOYEE_PAUSED_REASON, requested: true },
    ]);
    expect(await eventsOf(harness, 'surface.orientation-failed')).toEqual([]);
  });

  it('goes on at the resume as it was asked for, its held line cleared, and only once', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    const surfaceId = await declaredSurface(harness, agentId);
    await pause(harness, agentId);
    await harness.action(internal.orientationActions.orientOne, { surfaceId });

    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });

    expect(await scheduled(harness, 'orientationActions:orientOne')).toEqual([
      { surfaceId, requested: false },
    ]);
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.reason).toBeUndefined();
    expect(await eventsOf(harness, 'surface.orientation-resumed')).toEqual([{ surfaceId }]);
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduled(harness, 'orientationActions:orientOne')).toHaveLength(1);
  });

  it("keeps the manager's request for a system's card across a later plain hold of it (the second pass)", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    const surfaceId = await declaredSurface(harness, agentId);
    await pause(harness, agentId);
    await harness.action(internal.orientationActions.orientOne, { surfaceId, requested: true });
    await harness.action(internal.orientationActions.orientOne, { surfaceId });

    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });

    expect(await scheduled(harness, 'orientationActions:orientOne')).toEqual([
      { surfaceId, requested: true },
    ]);
    // The resumed job is the surface's job in flight, so a re-run then places no second one.
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.orientationJobId).toBeDefined();
    const job = await harness.run(
      async (ctx) => await ctx.db.system.get(surface!.orientationJobId!),
    );
    expect(job?.name).toBe('orientationActions:orientOne');
  });

  it('leaves a held surface that is no longer declared at the resume', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    const agentId = await agentOf(harness, skillId);
    const surfaceId = await declaredSurface(harness, agentId);
    await pause(harness, agentId);
    await harness.action(internal.orientationActions.orientOne, { surfaceId });
    await harness.run(
      async (ctx) => await ctx.db.patch(surfaceId, { verdict: 'absent', reason: 'not documented' }),
    );

    await harness.withIdentity(OWNER).mutation(api.agents.resume, { agentId });

    expect(await scheduled(harness, 'orientationActions:orientOne')).toEqual([]);
    expect(await harness.run(async (ctx) => await ctx.db.get(surfaceId))).toMatchObject({
      reason: 'not documented',
    });
  });
});

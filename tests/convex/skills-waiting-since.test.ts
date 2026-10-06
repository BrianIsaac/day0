/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { proposeLinearSkill, seedAgentAndWork } from './fakes/skill-work';
import { managerIdentity } from './fakes/manager-identity';

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
 * `skills.waitingSince` (13-K's field, declared at 0.16.0; wave 13 item 7): stamped at each
 * transition of a skill into a state that waits on the manager (`SKILL_WAITS_ON_MANAGER_STATES`),
 * so the inbox dates a skill's wait from when it began, not from when the skill was proposed.
 */

async function waitingSince(harness: Harness, skillId: Id<'skills'>): Promise<number | undefined> {
  return (await harness.run(async (ctx) => await ctx.db.get(skillId)))?.waitingSince;
}

async function at(when: number): Promise<void> {
  vi.setSystemTime(when);
}

async function claim(harness: Harness, skillId: Id<'skills'>): Promise<Id<'events'>> {
  const claimed = await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
  if (!claimed.claimed) throw new Error(claimed.reason);
  return claimed.runId;
}

describe("a skill's wait on the manager (skills.waitingSince)", (): void => {
  it('is stamped at the proposal, the approval, each claim, a deferral and a failure', async (): Promise<void> => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');

    await at(Date.UTC(2026, 9, 6, 9, 0));
    const skillId = await proposeLinearSkill(harness, agentId, workItemId);
    expect(await waitingSince(harness, skillId)).toBe(Date.UTC(2026, 9, 6, 9, 0));

    await at(Date.UTC(2026, 9, 6, 9, 5));
    await harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId });
    expect(await waitingSince(harness, skillId)).toBe(Date.UTC(2026, 9, 6, 9, 5));

    await at(Date.UTC(2026, 9, 6, 9, 6));
    const first = await claim(harness, skillId);
    expect(await waitingSince(harness, skillId)).toBe(Date.UTC(2026, 9, 6, 9, 6));

    await at(Date.UTC(2026, 9, 6, 9, 8));
    await harness.mutation(internal.skills.deferAuthoringRun, {
      skillId,
      runId: first,
      reason: 'the provider timed out',
    });
    expect(await waitingSince(harness, skillId)).toBe(Date.UTC(2026, 9, 6, 9, 8));

    await at(Date.UTC(2026, 9, 6, 9, 13));
    const second = await claim(harness, skillId);
    await at(Date.UTC(2026, 9, 6, 9, 15));
    await harness.mutation(internal.skills.failAuthoringRun, {
      skillId,
      runId: second,
      rowReason: 'the static gate refused the draft',
      reason: 'the static gate refused the draft',
      eventType: 'skill.author-failed',
    });
    expect(await waitingSince(harness, skillId)).toBe(Date.UTC(2026, 9, 6, 9, 15));
  });

  it('is stamped when a run parks a body no sandbox checked, and at a revision opened', async (): Promise<void> => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const skillId = await proposeLinearSkill(harness, agentId, workItemId);
    await harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId });
    const runId = await claim(harness, skillId);

    await at(Date.UTC(2026, 9, 6, 10, 0));
    await harness.mutation(internal.skills.parkUnverified, {
      skillId,
      runId,
      sandboxId: 'sandbox-1',
      body: '# Comment and close',
      smokeTest: 'echo ok',
      verificationLog: 'no sandbox ran',
      reason: 'no sandbox ran',
    });
    expect(await waitingSince(harness, skillId)).toBe(Date.UTC(2026, 9, 6, 10, 0));

    const registered = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId,
          name: 'kanban-comment-and-close',
          description: 'Ticket comment-and-close.',
          body: '# Comment and close',
          sourceType: 'agent-authored',
          state: 'registered',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          createdAt: 1,
        }),
    );
    await at(Date.UTC(2026, 9, 6, 11, 0));
    const { revisionId } = await harness
      .withIdentity(OWNER)
      .mutation(api.skillControls.askForRevision, { skillId: registered });
    expect(await waitingSince(harness, revisionId)).toBe(Date.UTC(2026, 9, 6, 11, 0));
  });

  it('dates the inbox entry from the stamp, and a skill stamped before none from its proposal', async (): Promise<void> => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    await at(Date.UTC(2026, 9, 6, 12, 0));
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seedAgentAndWork(harness, 'linear');
    const skillId = await proposeLinearSkill(harness, agentId, workItemId);
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { proposedSkillId: skillId });
      await ctx.db.patch(skillId, {
        state: 'failed',
        createdAt: 3_000,
        waitingSince: Date.UTC(2026, 9, 6, 11, 30),
      });
    });
    const entry = async (): Promise<unknown> =>
      (await harness.withIdentity(OWNER).query(api.work.needsYou, {})).entries.find(
        (row: { kind: string }) => row.kind === 'skill',
      );

    expect(await entry()).toMatchObject({ waitingSince: Date.UTC(2026, 9, 6, 11, 30) });
    await harness.run(async (ctx) => await ctx.db.patch(skillId, { waitingSince: undefined }));
    expect(await entry()).toMatchObject({ waitingSince: 3_000 });
  });
});

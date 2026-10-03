/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { approvedSkill, seedAgentAndWork } from './fakes/skill-work';

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

/*
 * The authoring claim (`convex/skillAuthoringClaim.ts`, behind `skills.claimAuthoringRun`): the
 * attempts it counts and the rows it refuses. Moved from `tests/convex/skills.test.ts` unchanged (the wave 11 review's m16).
 */

describe('claiming an authoring run (10-K)', (): void => {
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

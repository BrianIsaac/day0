/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { PROPOSAL_AFTER_HANDOVER } from '../../convex/skillProposal';
import { proposeLinearSkill as propose, seedAgentAndWork } from './fakes/skill-work';

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
 * A skill's proposal (`convex/skillProposal.ts`, behind `skills.propose`): the owner fence and
 * the names retired rows hold. Moved from `tests/convex/skills.test.ts` unchanged (the wave 11 review's m16).
 */

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

/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { approvedSkill } from './fakes/skill-work';

/** Every call the authoring run made to the model. */
const modelCalls: string[] = [];

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (call: { agent: { name: string } }): Promise<never> => {
    modelCalls.push(call.agent.name);
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

afterEach((): void => {
  modelCalls.length = 0;
  restoreSurfaceMode();
});

/*
 * One authoring run (`convex/skillAuthoringRun.ts`, split from `skillActions` by 11-FI; the wave
 * 11 review's m16): the run starts from its claim, so a skill it may not hold is refused before
 * anything is read or asked. The run through its gates and the sandbox is
 * `tests/convex/skill-authoring.test.ts`.
 */

describe('an authoring run', (): void => {
  it('refuses a skill its claim refuses, asking the model nothing and writing nothing', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const skillId = await approvedSkill(harness);
    await harness.run(async (ctx) => await ctx.db.patch(skillId, { state: 'retired' }));
    const before = await harness.run(async (ctx) => await ctx.db.query('events').collect());

    const result = await harness.action(internal.skillActions.authorAndRegisterSkillInternal, {
      skillId,
    });

    expect(result).toEqual({ ok: false, reason: 'this skill was retired' });
    expect(modelCalls).toEqual([]);
    expect(await harness.run(async (ctx) => await ctx.db.query('events').collect())).toEqual(
      before,
    );
    expect((await harness.run(async (ctx) => await ctx.db.get(skillId)))?.state).toBe('retired');
  });
});

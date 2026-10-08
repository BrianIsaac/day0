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
/** The user prompt of each of those calls. */
const modelPrompts: string[] = [];

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (call: { agent: { name: string }; user: string }): Promise<never> => {
    modelCalls.push(call.agent.name);
    modelPrompts.push(call.user);
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

afterEach((): void => {
  modelCalls.length = 0;
  modelPrompts.length = 0;
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

  it('reads the documentation a window at a time, so a corpus past one read still reaches the prompt (F2 D5)', async (): Promise<void> => {
    useSurfaceMode('mock');
    // The deployment's own read limit: 16 MiB a query.
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const skillId = await approvedSkill(harness);
    const sourceId = await harness.run(async (ctx) => {
      await ctx.db.patch(skillId, { targetSurface: 'linear' });
      return await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Company folder',
        kind: 'folder',
        locator: 'company',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
    });
    // Thirty pages of about 600 KB, 18 MB in all, the runbook for the target near the end; one
    // write each, as a sync stores them.
    for (let index = 0; index < 30; index += 1) {
      const runbook = index === 27;
      await harness.run(async (ctx) => {
        await ctx.db.insert('docPages', {
          sourceId,
          ref: `page-${String(index).padStart(2, '0')}.md`,
          title: runbook ? 'How to close a Linear ticket' : `Handbook page ${index}`,
          markdown: `# ${runbook ? 'Close the ticket in Linear with a summary comment.' : 'Notes'}\n\n${'x'.repeat(600 * 1024)}`,
          updatedAt: 1,
        });
      });
    }

    await harness.action(internal.skillActions.authorAndRegisterSkillInternal, { skillId });

    expect(modelPrompts).toHaveLength(1);
    expect(modelPrompts[0]).toContain('### How to close a Linear ticket');
  }, 60_000);
});

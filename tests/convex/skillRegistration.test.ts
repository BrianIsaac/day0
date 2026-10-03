/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { approvedSkill } from './fakes/skill-work';

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
 * The registration of an authored skill (`convex/skillRegistration.ts`, behind
 * `skills.completeRegistration`). Moved from `tests/convex/skills.test.ts` unchanged (the wave 11 review's m16).
 */

describe('registering an authored skill (10-K)', (): void => {
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
});

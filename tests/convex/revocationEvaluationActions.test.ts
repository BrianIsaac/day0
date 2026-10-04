import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { goneRowOf, guardRefusal } from './fakes/anonymous-caller';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
  restoreSurfaceMode();
});

describe('the anonymous-caller guard before the first read (12-G)', (): void => {
  it.each(['mock', 'real'] as const)(
    'refuses a caller with no identity before it says the mode, the bed or whether the item exists (%s)',
    async (mode): Promise<void> => {
      useSurfaceMode(mode);
      vi.stubEnv('DAY0_EVALUATION_BED', 'revocation');
      const { api } = await import('../../convex/_generated/api');
      const harness = convexTest(schema, allConvexModules());
      const refusal = await guardRefusal();
      const workItemId = await goneRowOf(harness, 'workItems');
      await expect(
        harness.action(api.revocationEvaluationActions.runTrialAction, {
          workItemId,
          checkpoint: 'none',
        }),
      ).rejects.toMatchObject(refusal);
      await expect(
        harness.action(api.revocationEvaluationActions.setupSurfaceCards, {
          agentId: await goneRowOf(harness, 'agents'),
        }),
      ).rejects.toMatchObject(refusal);
    },
  );
});

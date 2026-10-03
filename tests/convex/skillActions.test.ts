/** @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import * as skillActions from '../../convex/skillActions';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

/*
 * The registered entry points of skill authoring (`convex/skillActions.ts`). The run itself is
 * tested beside `convex/skillAuthoringRun.ts` and through these entries in
 * `tests/convex/skill-authoring.test.ts`.
 */

describe('the skill authoring entry points', (): void => {
  it("registers the dashboard's run publicly and a deferred run's retry internally, and re-exports nothing (the review's m16)", (): void => {
    expect(Object.keys(skillActions).sort()).toEqual([
      'authorAndRegisterSkill',
      'authorAndRegisterSkillInternal',
    ]);
    expect(skillActions.authorAndRegisterSkill.isPublic).toBe(true);
    expect(skillActions.authorAndRegisterSkillInternal.isInternal).toBe(true);
  });
});

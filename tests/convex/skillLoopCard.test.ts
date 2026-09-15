/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

const OWNER = { subject: 'owner' };

afterEach((): void => {
  restoreSurfaceMode();
});

/**
 * The 12 Sep R6 capture: mock deploy granted no `slack:read`, so the slot-2
 * Slack action item, the one written to carry the skill loop, always deferred
 * on permission, and the loop fired from the out-of-scope card instead. The
 * grant is now made at deploy; this drives the same card from the real deploy
 * mutation to the proposal and pins the proposal to that card.
 */
describe('the skill loop fires from the mock action item', (): void => {
  it('proposes the chat skill for a freshly deployed agent\'s Slack ask, pinned to that item', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(OWNER);
    const agentId = await owner.mutation(api.agents.deploy, { bossEmail: 'boss@day0.local', name: 'Priya' });
    const workItemId = await harness.run(async (ctx) => {
      await ctx.db.insert('charters', {
        agentId,
        version: 'v1',
        approved: true,
        approvedAt: 1,
        createdAt: 1,
        body: {
          proposedFunction: 'Revenue operations analyst',
          proposedBoundaries: {
            willDo: ['Answer revenue operations questions in Slack and keep the standup summary current.'],
            willNotDo: ['Public brand replies.'],
            escalationTriggers: [],
          },
          approvalChain: { boss: 'boss@day0.local' },
        },
      });
      return await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'event-stream',
        sourceSystem: 'slack',
        externalId: 'slack-revops-asks-1',
        title: 'Question in #revops-asks about the standup summary',
        contentSummary: 'Which revenue operations coverage figure are we quoting in the Friday standup summary this week? Please reply in the thread.',
        contentRefs: ['slack://revops-asks/1'],
        priority: 'P1',
        requesterLabel: 'Sales lead',
        state: 'discovered',
        observedAt: Date.now(),
        createdAt: Date.now(),
      });
    });

    await expect(owner.action(api.workActions.evaluateWorkItem, { workItemId })).resolves.toEqual({
      decision: 'needs-skill',
    });

    const item = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(item?.state).toBe('needs-skill');
    expect(item?.verdict).toMatchObject({ decision: 'needs-skill', suggestedSkillName: 'chat-thread-reply' });
    const proposed = (await harness.run(async (ctx) => await ctx.db.query('skills').collect())).filter(
      (skill) => skill.state === 'proposed',
    );
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      name: 'chat-thread-reply',
      surfaceClass: 'chat',
      operation: 'thread-reply',
      proposedFor: workItemId,
    });
    expect(item?.proposedSkillId).toBe(proposed[0]!._id);
  });
});

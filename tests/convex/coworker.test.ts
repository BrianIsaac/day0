import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

type Harness = ReturnType<typeof convexTest>;

/**
 * Seed one mock-office employee.
 *
 * Args:
 *   harness: Convex test harness.
 *
 * Returns:
 *   The employee's id.
 */
async function seedAgent(harness: Harness): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'coworker test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      }),
  );
}

/**
 * Every mock Slack message the employee's office holds.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: The employee.
 *
 * Returns:
 *   The messages, oldest first.
 */
async function officeMessages(
  harness: Harness,
  agentId: Id<'agents'>,
): Promise<Doc<'mockSlackMessages'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('mockSlackMessages')
        .filter((q) => q.eq(q.field('agentId'), agentId))
        .collect(),
  );
}

/** Words that ask Day0 to act on a reply, which nothing in real mode reads. */
const ASKS_FOR_ACTION =
  /\b(hold|please|make sure|add|pin|send|forward|before|push back|sign-off|caveat|tweak)\b/i;

describe('coworker replies in the mock office', (): void => {
  it.each(['dm-manager', 'dm-priya', 'dm-aman', 'revops-asks', 'revops'])(
    'acknowledges a message on %s without asking Day0 for anything',
    async (channelSlug): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const agentId = await seedAgent(harness);
      for (const originalBody of [
        'Weekly pipeline summary is posted.',
        'Close-date column refreshed.',
        'x',
      ]) {
        await harness.mutation(internal.coworker.replyToAgentMessage, {
          agentId,
          channelSlug,
          originalBody,
        });
      }
      const replies = await officeMessages(harness, agentId);
      expect(replies).toHaveLength(3);
      for (const reply of replies) {
        expect(reply.channelSlug).toBe(channelSlug);
        expect(reply.body).not.toMatch(ASKS_FOR_ACTION);
        expect(reply.body).not.toContain(' - ');
      }
    },
  );

  it('gives the same reply to the same message every time', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    for (let turn = 0; turn < 6; turn += 1) {
      await harness.mutation(internal.coworker.replyToAgentMessage, {
        agentId,
        channelSlug: 'dm-priya',
        originalBody: 'Weekly pipeline summary is posted.',
      });
    }
    const bodies = new Set((await officeMessages(harness, agentId)).map((reply) => reply.body));
    expect(bodies.size).toBe(1);
  });

  it('writes no reply in the manager’s name on a channel with no colleague', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    await harness.mutation(internal.coworker.replyToAgentMessage, {
      agentId,
      channelSlug: 'finance-close',
      originalBody: 'Close checklist updated.',
    });
    expect(await officeMessages(harness, agentId)).toEqual([]);
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(events).toEqual([]);
  });

  it('keeps the reply in the thread it answers and records who replied', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedAgent(harness);
    await harness.mutation(internal.coworker.replyToAgentMessage, {
      agentId,
      channelSlug: 'revops-asks',
      threadKey: 'ask-1',
      originalBody: 'Posted the refreshed figures.',
    });
    const [reply] = await officeMessages(harness, agentId);
    expect(reply).toMatchObject({ threadKey: 'ask-1', sender: 'Priya', senderKind: 'requester' });
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) =>
            q.eq('agentId', agentId).eq('type', 'coworker.replied'),
          )
          .collect(),
    );
    expect(events.map((event) => event.payload)).toEqual([
      { channelSlug: 'revops-asks', responder: 'Priya' },
    ]);
  });
});

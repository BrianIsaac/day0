/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
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

afterEach((): void => {
  restoreSurfaceMode();
});

const OWNER = { subject: 'owner' };

describe('the posture control', (): void => {
  it('lets the owner set a posture once per change, with an event, and refuses a stranger', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', { bossEmail: 'boss@day0.local', name: 'Priya', userId: 'owner', state: 'active', createdAt: 1 }),
    );
    await expect(
      harness.withIdentity({ subject: 'intruder' }).mutation(api.posture.setPosture, { agentId, posture: 'trusted' }),
    ).rejects.toThrow('forbidden');
    await expect(harness.withIdentity(OWNER).mutation(api.posture.setPosture, { agentId, posture: 'cold-start' })).resolves.toEqual({
      ok: true,
      posture: 'cold-start',
      changed: false,
    });
    await expect(harness.withIdentity(OWNER).mutation(api.posture.setPosture, { agentId, posture: 'trusted' })).resolves.toEqual({
      ok: true,
      posture: 'trusted',
      changed: true,
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(agentId)))?.posture).toBe('trusted');
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ['agent.posture-changed', { from: 'cold-start', to: 'trusted', reason: 'set by the manager' }],
    ]);
  });
});

describe('the backfill for rows that predate the ladder', (): void => {
  it('replays the supervised-run rule over old gate events and moves a working agent past cold start', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const seeded = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', { bossEmail: 'boss@day0.local', name: 'ops worker', userId: 'owner', state: 'active', createdAt: 1 });
      const idle = await ctx.db.insert('agents', { bossEmail: 'idle@day0.local', name: 'idle', userId: 'owner', state: 'active', createdAt: 1 });
      const skillId = await ctx.db.insert('skills', {
        agentId,
        name: 'linear-action-revops-5',
        description: 'd',
        body: 'b',
        sourceType: 'agent-authored',
        state: 'registered',
        createdAt: 1,
        registeredAt: 1,
      });
      const counted = await ctx.db.insert('skills', {
        agentId,
        name: 'already-counted',
        description: 'd',
        body: 'b',
        sourceType: 'agent-authored',
        state: 'registered',
        supervisedRunsCompleted: 1,
        createdAt: 1,
        registeredAt: 1,
      });
      const item = async (externalId: string, state: 'completed' | 'failed'): Promise<Id<'workItems'>> =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId,
          title: externalId,
          contentSummary: '',
          contentRefs: [],
          state,
          skillId,
          observedAt: 1,
          createdAt: 1,
        });
      const first = await item('REVOPS-5', 'completed');
      const second = await item('C0BSF04TZ19:1787746453.202809', 'completed');
      const third = await item('REVOPS-9', 'failed');
      const events: Array<[string, Record<string, unknown>, number]> = [
        ['work.actions-pending', { workItemId: first, runId: 'r1', actionCount: 3, heldIndexes: [] }, 1],
        ['work.actions-approved', { workItemId: first, runId: 'r1', approvedIndexes: [0, 1, 2], heldIndexes: [] }, 2],
        ['work.completed', { workItemId: first }, 3],
        ['work.actions-pending', { workItemId: second, runId: 'r2', actionCount: 1, heldIndexes: [] }, 4],
        ['work.actions-approved', { workItemId: second, runId: 'r2', approvedIndexes: [0], heldIndexes: [] }, 5],
        ['work.completed', { workItemId: second }, 6],
        // A rejected run of a work item that belongs to another skill does not count against this one.
        ['work.actions-rejected', { workItemId: 'kx7other', reason: 'rejected by the manager' }, 7],
      ];
      for (const [type, payload, createdAt] of events) {
        await ctx.db.insert('events', { agentId, type, payload, createdAt });
      }
      return { agentId, idle, skillId, counted, third };
    });
    const result = await harness.mutation(internal.posture.backfill, {});
    expect(result).toEqual({
      skills: [{ skillId: seeded.skillId, name: 'linear-action-revops-5', supervisedRunsCompleted: 2, trusted: true }],
      agents: [{ agentId: seeded.agentId, name: 'ops worker', posture: 'supervised' }],
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.skillId)))?.supervisedRunsCompleted).toBe(2);
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.counted)))?.supervisedRunsCompleted).toBe(1);
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.agentId)))?.posture).toBe('supervised');
    expect((await harness.run(async (ctx) => await ctx.db.get(seeded.idle)))?.posture).toBeUndefined();
    const postureEvents = await harness.run(
      async (ctx) =>
        (await ctx.db.query('events').withIndex('by_agent', (q) => q.eq('agentId', seeded.agentId)).collect()).filter(
          (event) => event.type === 'agent.posture-changed',
        ),
    );
    expect(postureEvents).toHaveLength(1);
    expect(postureEvents[0].payload).toMatchObject({ from: 'cold-start', to: 'supervised', reason: 'backfill: a work item had already completed' });
    // Idempotent: nothing is counted or moved twice.
    await expect(harness.mutation(internal.posture.backfill, {})).resolves.toEqual({ skills: [], agents: [] });
  });
});

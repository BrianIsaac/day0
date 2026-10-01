import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { appendEvent, eventsOfType } from '../../convex/eventLog';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

describe('eventsOfType', (): void => {
  it("reads one agent's events of one type, bounded by creation when asked", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agent = async (name: string): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name,
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
      const [agentId, otherId] = [await agent('Priya'), await agent('Aman')];
      const flip = async (on: Id<'agents'>, to: boolean): Promise<Id<'events'>> =>
        await appendEvent(ctx, {
          agentId: on,
          type: 'agent.autonomy-changed',
          payload: { from: !to, to, reason: 'the manager flipped it' },
          createdAt: 1,
        });
      const first = await flip(agentId, true);
      await flip(otherId, true);
      await appendEvent(ctx, {
        agentId,
        type: 'agent.notifications-changed',
        payload: { from: 'per-run', to: 'digest', reason: 'the manager chose a digest' },
        createdAt: 1,
      });
      const second = await flip(agentId, false);
      const firstRow = (await ctx.db.get(first))!;
      return {
        all: (await eventsOfType(ctx, agentId, 'agent.autonomy-changed').collect()).map(
          (row) => row._id,
        ),
        after: (
          await eventsOfType(ctx, agentId, 'agent.autonomy-changed', {
            after: firstRow._creationTime,
          }).collect()
        ).map((row) => row._id),
        from: (
          await eventsOfType(ctx, agentId, 'agent.autonomy-changed', {
            from: firstRow._creationTime,
          }).collect()
        ).map((row) => row._id),
        first,
        second,
      };
    });
    expect(read.all).toEqual([read.first, read.second]);
    expect(read.after).toEqual([read.second]);
    expect(read.from).toEqual([read.first, read.second]);
  });
});

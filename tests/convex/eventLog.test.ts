import { convexTest, type TestConvex } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
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

describe('eventLog.log: an action that started under one owner (U3-m2)', (): void => {
  /** Seed Maya, now owned by `userId`. */
  async function seedEmployee(
    harness: TestConvex<typeof schema>,
    userId: string,
  ): Promise<Id<'agents'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Maya',
          userId,
          state: 'active',
          createdAt: 1,
        }),
    );
  }

  /** The employee's events of the type the tests log. */
  async function loggedOf(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
  ): Promise<number> {
    return await harness.run(
      async (ctx) => (await eventsOfType(ctx, agentId, 'work.model-call').collect()).length,
    );
  }

  const MODEL_CALL = {
    type: 'work.model-call' as const,
    payload: { stage: 'draft', model: 'openai/mock' },
  };

  it('appends the event while the employee is still the owner the action started under', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, 'owner');

    await harness.mutation(internal.eventLog.log, {
      agentId,
      ...MODEL_CALL,
      startedUnder: 'owner',
    });

    expect(await loggedOf(harness, agentId)).toBe(1);
  });

  it('appends nothing once the employee was handed to another owner since the action started', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, 'colleague');

    await harness.mutation(internal.eventLog.log, {
      agentId,
      ...MODEL_CALL,
      startedUnder: 'owner',
    });

    expect(await loggedOf(harness, agentId)).toBe(0);
  });

  it('appends as before for a caller that names no owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, 'colleague');

    await harness.mutation(internal.eventLog.log, { agentId, ...MODEL_CALL });

    expect(await loggedOf(harness, agentId)).toBe(1);
  });
});

describe("eventLog.log: the types an employee's ledger takes", (): void => {
  /** `eventLog.log` reached by name, as nothing typed through `logEvent` reaches it. */
  const logByName = makeFunctionReference<'mutation', Record<string, unknown>, null>(
    'eventLog:log',
  );

  it("refuses an organisation connection's ledger type called by name", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Maya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );

    await expect(
      harness.mutation(logByName, {
        agentId,
        type: 'organisation.connection-landed',
        payload: {
          organisationConnectionId: 'c',
          system: 'slack',
          displayName: 'Slack',
          via: 'setup-cli',
        },
      }),
    ).rejects.toThrow(/Validator error/);
    const written = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    expect(written).toHaveLength(0);
  });
});

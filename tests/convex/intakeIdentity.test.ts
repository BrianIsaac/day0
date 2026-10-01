import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

async function seedSurface(
  harness: TestConvex<typeof schema>,
  generation: number,
  providerBotId?: string,
): Promise<Id<'surfaces'>> {
  return await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'identity test',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const [surfaceId] = await ctx.runMutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [{ name: 'Slack', class: 'chat', whereMentioned: 'Requests arrive in Slack.' }],
    });
    await ctx.db.patch(surfaceId!, { probeGeneration: generation, providerBotId });
    return surfaceId!;
  });
}

describe('recordBotIdentity', (): void => {
  it('stores the bot id the probe of the current generation read, and clears it when the probe read none', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedSurface(harness, 3, 'B_OLD');
    expect(
      await harness.mutation(internal.intakeIdentity.recordBotIdentity, {
        surfaceId,
        generation: 3,
        providerBotId: 'B_NEW',
      }),
    ).toBe(true);
    expect((await harness.run(async (ctx) => await ctx.db.get(surfaceId)))?.providerBotId).toBe(
      'B_NEW',
    );
    expect(
      await harness.mutation(internal.intakeIdentity.recordBotIdentity, {
        surfaceId,
        generation: 3,
      }),
    ).toBe(true);
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(surfaceId)))?.providerBotId,
    ).toBeUndefined();
  });

  it('ignores a probe a newer generation has superseded, leaving the row as it is', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await seedSurface(harness, 4, 'B_CURRENT');
    expect(
      await harness.mutation(internal.intakeIdentity.recordBotIdentity, {
        surfaceId,
        generation: 3,
        providerBotId: 'B_STALE',
      }),
    ).toBe(false);
    expect((await harness.run(async (ctx) => await ctx.db.get(surfaceId)))?.providerBotId).toBe(
      'B_CURRENT',
    );
  });
});

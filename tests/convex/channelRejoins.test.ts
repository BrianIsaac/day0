/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { latestRejoins } from '../../convex/channelRejoins';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

/*
 * The latest re-join a Slack renewal made for a card (`surface.channels-rejoined`, AS10), read for
 * the card from the employee's own record (11-AC's item 5): the channels the bot re-joined itself,
 * and those that need a person in them to add it.
 */

interface Seeded {
  readonly agentId: Id<'agents'>;
  readonly slack: Id<'surfaces'>;
  readonly linear: Id<'surfaces'>;
}

async function seed(harness: TestConvex<typeof schema>): Promise<Seeded> {
  return await harness.run(async (ctx): Promise<Seeded> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Leo',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const card = {
      agentId,
      verdict: 'connected' as const,
      whereFound: [],
      credentialLanded: true,
      createdAt: 1,
    };
    const slack = await ctx.db.insert('surfaces', {
      ...card,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
    });
    const linear = await ctx.db.insert('surfaces', {
      ...card,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
    });
    for (const [at, joined, needsPerson] of [
      [10, ['#revops'], ['#revops-leads', '#finance']],
      [20, ['#revops'], ['#revops-leads']],
    ] as const) {
      await ctx.db.insert('events', {
        agentId,
        type: 'surface.channels-rejoined',
        payload: { surfaceId: slack, joined: [...joined], needsPerson: [...needsPerson] },
        createdAt: at,
      });
    }
    return { agentId, slack, linear };
  });
}

describe("a card's latest re-join after a Slack renewal (11-AC's item 5)", (): void => {
  it('reads the newest re-join of each card from its own record, and none for a card without one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, slack, linear } = await seed(harness);

    // A harness hands back Convex values only, so the map comes back as an object.
    const rejoins = await harness.run(async (ctx) =>
      Object.fromEntries(await latestRejoins(ctx, agentId)),
    );

    expect(rejoins[slack]).toEqual({
      joined: ['#revops'],
      needsPerson: ['#revops-leads'],
      at: 20,
    });
    expect(Object.keys(rejoins)).not.toContain(linear);
  });

  it('lists it on the card the manager reads', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, slack } = await seed(harness);

    const cards = await harness
      .withIdentity(managerIdentity())
      .query(api.surfaces.listForAgent, { agentId });

    expect(cards.find((card) => card._id === slack)?.lastRejoin).toEqual({
      joined: ['#revops'],
      needsPerson: ['#revops-leads'],
      at: 20,
    });
    expect(cards.find((card) => card.slug === 'linear')?.lastRejoin).toBeUndefined();
  });
});

/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import { itemPersonIds } from '../../convex/itemPeople';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { seedEmployee, seedPerson, type GraphHarness } from './fakes/people-graph';

/**
 * Whom a work item's requester and owner are in the owner's graph now (wave 13, 13-J): the stored
 * resolutions read back as the confirmed people they still name, the people a person-scoped working
 * agreement applies through.
 */

async function seedItem(
  harness: GraphHarness,
  agentId: Id<'agents'>,
  fields: Record<string, unknown> = {},
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'LOG-7',
        title: 'Grant Linear access to the new joiner',
        contentSummary: 'Please add Mo to the team.',
        contentRefs: ['ticket://LOG-7'],
        state: 'claimed',
        observedAt: 1,
        createdAt: 1,
        requesterLabel: 'lee.tan',
        ...fields,
      } as never),
  );
}

describe('itemPersonIds', (): void => {
  it('answers the confirmed people the requester and the owner resolve to, once each', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const lee = await seedPerson(harness, 'Lee Tan');
    const dana = await seedPerson(harness, 'Dana Okafor');
    const dismissed = await seedPerson(harness, 'Dee Dismissed', { status: 'dismissed' } as never);
    const both = await seedItem(harness, agentId, {
      requesterPerson: { kind: 'person', personId: lee },
      ownerPerson: { kind: 'person', personId: dana },
    });
    const same = await seedItem(harness, agentId, {
      requesterPerson: { kind: 'person', personId: lee },
      ownerPerson: { kind: 'person', personId: lee },
    });
    const gone = await seedItem(harness, agentId, {
      requesterPerson: { kind: 'person', personId: dismissed },
      ownerPerson: { kind: 'ambiguous', candidates: 2 },
    });
    const answers = await harness.run(async (ctx) => {
      const agent = (await ctx.db.get(agentId))!;
      return await Promise.all(
        [both, same, gone].map(
          async (id) => await itemPersonIds(ctx, (await ctx.db.get(id))!, agent),
        ),
      );
    });
    expect(answers).toEqual([[lee, dana], [lee], []]);
  });
});

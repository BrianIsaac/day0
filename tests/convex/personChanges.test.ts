/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { NO_PROPOSED_CHANGE, PROPOSED_ADDRESS_HELD } from '../../src/people/words';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';
import { graphRows, seedEmployee, seedPerson, type GraphHarness } from './fakes/people-graph';

/*
 * A source's proposed change to a confirmed person, taken or dismissed on the person's card
 * (W13-R3, 14-I's `people.proposedChange`).
 */

const CHANGE: NonNullable<Doc<'people'>['proposedChange']> = {
  title: 'Finance lead',
  team: 'Finance',
  primaryEmail: 'ana.tan@acme.test',
  source: 'documentation',
  evidence: { quote: 'Ana Tan, Finance lead, ana.tan@acme.test', where: 'Team page', at: 5 },
  proposedAt: 10,
};

/** Ana, confirmed with an address and a title, and a change a page proposed for her. */
async function seedAna(
  harness: GraphHarness,
  fields: Partial<Doc<'people'>> = {},
): Promise<Id<'people'>> {
  return await seedPerson(harness, 'Ana Tan', {
    primaryEmail: 'ana@acme.test',
    title: 'Controller',
    proposedChange: CHANGE,
    ...fields,
  });
}

/** The lookups the scheduler holds. */
async function lookups(harness: GraphHarness): Promise<unknown[]> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .filter((job) => job.name === 'peopleLookupActions:lookUpAddresses')
    .map((job) => job.args);
}

describe('personChanges', (): void => {
  it('takes the proposed change onto the person, clears it, and looks a new address up', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await seedAna(harness);
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.personChanges.take, { personId, agentId });
    const [person] = (await graphRows(harness)).people;
    expect(person).toMatchObject({
      title: 'Finance lead',
      team: 'Finance',
      primaryEmail: 'ana.tan@acme.test',
    });
    expect(person?.proposedChange).toBeUndefined();
    expect(await lookups(harness)).toEqual([[{ personIds: [personId] }]]);
  });

  it('dismisses the proposed change and keeps the confirmed values', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await seedAna(harness);
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.personChanges.dismiss, { personId, agentId });
    const [person] = (await graphRows(harness)).people;
    expect(person).toMatchObject({ title: 'Controller', primaryEmail: 'ana@acme.test' });
    expect(person?.proposedChange).toBeUndefined();
    expect(person?.team).toBeUndefined();
  });

  it('refuses a take or a dismiss when nothing is proposed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await seedAna(harness, { proposedChange: undefined });
    const owner = harness.withIdentity(managerIdentity());
    await expect(owner.mutation(api.personChanges.take, { personId, agentId })).rejects.toThrow(
      NO_PROPOSED_CHANGE,
    );
    await expect(owner.mutation(api.personChanges.dismiss, { personId, agentId })).rejects.toThrow(
      NO_PROPOSED_CHANGE,
    );
  });

  it('refuses to take an address another of the owner’s people holds, and changes nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await seedAna(harness);
    await seedPerson(harness, 'A. Tan', { primaryEmail: 'ana.tan@acme.test' });
    await expect(
      harness
        .withIdentity(managerIdentity())
        .mutation(api.personChanges.take, { personId, agentId }),
    ).rejects.toThrow(PROPOSED_ADDRESS_HELD);
    const ana = (await graphRows(harness)).people.find((row) => row._id === personId);
    expect(ana).toMatchObject({ primaryEmail: 'ana@acme.test', proposedChange: CHANGE });
  });

  it("answers another owner's person as one that does not exist", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await seedAna(harness);
    await expect(
      harness
        .withIdentity(managerIdentity('other'))
        .mutation(api.personChanges.take, { personId, agentId }),
    ).rejects.toThrow();
    expect((await graphRows(harness)).people[0]?.proposedChange).toEqual(CHANGE);
  });
});

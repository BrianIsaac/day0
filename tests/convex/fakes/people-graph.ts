import type { TestConvex } from 'convex-test';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { personNameKey } from '../../../src/people/vocabulary';
import { MANAGER_ADDRESS } from './manager-identity';

/*
 * The people graph as a test seeds it (wave 13, 13-P): an owner's employees, people, identities
 * and edges written straight into the tables, so a reader's test states the graph it reads.
 */

/** The convex-test harness over the schema. */
export type GraphHarness = TestConvex<typeof schema>;

/** An employee of an owner, managed under the fixture's address unless the test says otherwise. */
export async function seedEmployee(
  harness: GraphHarness,
  fields: Partial<Doc<'agents'>> = {},
): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
        ...fields,
      }),
  );
}

/** A person of an owner's graph, confirmed unless the test says otherwise. */
export async function seedPerson(
  harness: GraphHarness,
  displayName: string,
  fields: Partial<Doc<'people'>> = {},
): Promise<Id<'people'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('people', {
        userId: 'owner',
        displayName,
        nameKey: personNameKey(displayName),
        status: 'active',
        source: 'manager',
        evidence: [],
        confirmedAt: 1,
        createdAt: 1,
        updatedAt: 1,
        ...fields,
      }),
  );
}

/** An identity of a person, under the person's own owner scope. */
export async function seedIdentity(
  harness: GraphHarness,
  personId: Id<'people'>,
  fields: Pick<Doc<'personIdentities'>, 'provider' | 'externalId'> &
    Partial<Doc<'personIdentities'>>,
): Promise<Id<'personIdentities'>> {
  return await harness.run(async (ctx) => {
    const person = await ctx.db.get(personId);
    return await ctx.db.insert('personIdentities', {
      userId: person?.userId ?? 'owner',
      personId,
      source: 'provider-lookup',
      verifiedAt: 1,
      createdAt: 1,
      ...(fields.displayName === undefined
        ? {}
        : { displayNameKey: personNameKey(fields.displayName) }),
      ...fields,
    });
  });
}

/** An edge of an owner's graph, confirmed and in force from 1 unless the test says otherwise. */
export async function seedEdge(
  harness: GraphHarness,
  toPersonId: Id<'people'>,
  fields: Pick<Doc<'relationships'>, 'type'> & Partial<Doc<'relationships'>>,
): Promise<Id<'relationships'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('relationships', {
        userId: 'owner',
        toPersonId,
        effectiveFrom: 1,
        status: 'active',
        source: 'manager',
        confirmedAt: 1,
        createdAt: 1,
        ...fields,
      }),
  );
}

/** Every row of an owner's graph. */
export async function graphRows(
  harness: GraphHarness,
  userId = 'owner',
): Promise<{
  people: Doc<'people'>[];
  identities: Doc<'personIdentities'>[];
  edges: Doc<'relationships'>[];
}> {
  return await harness.run(async (ctx) => ({
    people: await ctx.db
      .query('people')
      .withIndex('by_user_status', (q) => q.eq('userId', userId))
      .collect(),
    identities: await ctx.db
      .query('personIdentities')
      .withIndex('by_user_provider_external', (q) => q.eq('userId', userId))
      .collect(),
    edges: await ctx.db
      .query('relationships')
      .withIndex('by_user_type', (q) => q.eq('userId', userId))
      .collect(),
  }));
}

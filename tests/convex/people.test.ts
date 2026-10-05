/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { graphRows, seedEdge, seedEmployee, seedIdentity, seedPerson } from './fakes/people-graph';
import { proposePersonInTransaction, type ProposedPerson } from '../../convex/peopleProposals';
import { PERSON_NOT_YOURS } from '../../src/people/vocabulary';
import {
  CONFIRM_BEFORE_RELATING,
  NOT_OFFERED_AS_SAME,
  NOTHING_WAITING,
  OWNER_IS_THE_MANAGER,
  RELATIONSHIP_ENDED,
  SAY_WHETHER_SAME_FIRST,
} from '../../src/people/words';

/**
 * The owner's own person (wave 13, 13-K; the wave file's section 5.1): written at the owner's
 * sign-in from the verified address, with the address as an identity and one Slack identity per
 * distinct Slack user the owner's connected chat cards looked up by that address. It is the people
 * graph's backfill for every owner from before the graph and its writer from then on.
 */

type Harness = TestConvex<typeof schema>;

afterEach((): void => {
  restoreSurfaceMode();
});

/** An employee of an owner, managed under the address its owner deployed it with. */
async function employee(
  harness: Harness,
  options: { readonly userId?: string; readonly bossEmail?: string; readonly name?: string } = {},
): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: options.bossEmail ?? MANAGER_ADDRESS,
        name: options.name ?? 'Priya',
        userId: options.userId ?? 'owner',
        state: 'active',
        createdAt: 1,
      }),
  );
}

/** A chat card of an employee, connected unless a test says otherwise, with its looked-up manager. */
async function chatCard(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'surfaces'>> = {},
): Promise<Id<'surfaces'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        providerWorkspaceId: 'T0123',
        managerUserId: 'U0BOSS',
        managerName: 'Rowan',
        managerDmChannelId: 'D0123',
        lastVerifiedAt: 50,
        createdAt: 1,
        ...fields,
      }),
  );
}

/** Every person and identity of an owner scope, as the graph holds them. */
async function graphOf(
  harness: Harness,
  userId = 'owner',
): Promise<{ people: Doc<'people'>[]; identities: Doc<'personIdentities'>[] }> {
  return await harness.run(async (ctx) => ({
    people: await ctx.db
      .query('people')
      .withIndex('by_user_status', (q) => q.eq('userId', userId))
      .collect(),
    identities: await ctx.db
      .query('personIdentities')
      .withIndex('by_user_provider_external', (q) => q.eq('userId', userId))
      .collect(),
  }));
}

describe('people.ensureOwner', (): void => {
  it("writes the owner's own person from the verified address, with the address and each Slack user the owner's connected chat cards looked up", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness);
    const mateo = await employee(harness, { name: 'Mateo' });
    await chatCard(harness, priya);
    // The same Slack user through a second employee's card is one identity, not two.
    await chatCard(harness, mateo, { slug: 'slack-mateo' });
    await chatCard(harness, mateo, {
      slug: 'slack-other-workspace',
      providerWorkspaceId: 'T0999',
      managerUserId: 'U0BOSS2',
      managerName: 'Rowan H',
    });
    // A card not connected names nobody the probe proved.
    await chatCard(harness, mateo, {
      slug: 'slack-proposed',
      verdict: 'proposed',
      managerUserId: 'U0STALE',
    });
    const owner = harness.withIdentity({ ...managerIdentity(), name: 'Rowan Hale' });
    const written = await owner.mutation(api.people.ensureOwner, {});
    const graph = await graphOf(harness);
    expect(graph.people).toHaveLength(1);
    expect(graph.people[0]).toMatchObject({
      _id: written.personId,
      displayName: 'Rowan Hale',
      nameKey: 'rowan hale',
      primaryEmail: MANAGER_ADDRESS,
      isOwner: true,
      status: 'active',
      source: 'owner',
      evidence: [],
    });
    expect(
      graph.identities
        .map((row) => [row.provider, row.providerWorkspaceId, row.externalId, row.source])
        .sort(),
    ).toEqual([
      ['email', undefined, MANAGER_ADDRESS, 'owner'],
      ['slack', 'T0123', 'U0BOSS', 'provider-lookup'],
      ['slack', 'T0999', 'U0BOSS2', 'provider-lookup'],
    ]);
    expect(graph.identities.every((row) => row.personId === written.personId)).toBe(true);
    expect(graph.identities.find((row) => row.externalId === 'U0BOSS')).toMatchObject({
      displayName: 'Rowan',
      displayNameKey: 'rowan',
      verifiedAt: 50,
    });
    expect(written.identitiesAdded).toBe(3);
  });

  it('keeps one Slack user id in two workspaces as two identities, since an id is unique only in its workspace (the second pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness);
    await chatCard(harness, priya);
    await chatCard(harness, priya, { slug: 'slack-other', providerWorkspaceId: 'T0999' });
    const written = await harness
      .withIdentity(managerIdentity())
      .mutation(api.people.ensureOwner, {});
    const slack = (await graphOf(harness)).identities.filter((row) => row.provider === 'slack');
    expect(slack.map((row) => row.providerWorkspaceId).sort()).toEqual(['T0123', 'T0999']);
    expect(written.identitiesAdded).toBe(3);
  });

  it('is safe to run twice: the second sign-in writes nothing and answers the same person', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    await chatCard(harness, await employee(harness));
    const owner = harness.withIdentity(managerIdentity());
    const first = await owner.mutation(api.people.ensureOwner, {});
    const before = await graphOf(harness);
    const second = await owner.mutation(api.people.ensureOwner, {});
    expect(second).toEqual({ personId: first.personId, identitiesAdded: 0 });
    expect(await graphOf(harness)).toEqual(before);
  });

  it('takes a Slack user only from an employee managed under the owner’s own address, never one that names another', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    // An employee deployed before wave 9 may still name an address its owner typed: the probe
    // looked that address up, so its Slack user is whoever that address is, not the owner.
    const typed = await employee(harness, { bossEmail: 'someone.else@example.com' });
    await chatCard(harness, typed, { managerUserId: 'U0ELSE' });
    const written = await harness
      .withIdentity(managerIdentity())
      .mutation(api.people.ensureOwner, {});
    const graph = await graphOf(harness);
    expect(graph.identities.map((row) => row.externalId)).toEqual([MANAGER_ADDRESS]);
    expect(written.identitiesAdded).toBe(1);
  });

  it("makes a person already holding the owner's address the owner's own row, never a second person", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const proposed = await harness.run(
      async (ctx) =>
        await ctx.db.insert('people', {
          userId: 'owner',
          displayName: 'R. Hale',
          nameKey: 'r hale',
          primaryEmail: MANAGER_ADDRESS,
          status: 'unverified',
          source: 'documentation',
          evidence: [{ quote: 'Rowan approves refunds', where: 'Approvals', at: 3 }],
          createdAt: 3,
          updatedAt: 3,
        }),
    );
    const written = await harness
      .withIdentity(managerIdentity())
      .mutation(api.people.ensureOwner, {});
    const graph = await graphOf(harness);
    expect(written.personId).toBe(proposed);
    expect(graph.people).toHaveLength(1);
    expect(graph.people[0]).toMatchObject({
      displayName: 'R. Hale',
      isOwner: true,
      status: 'active',
      evidence: [{ quote: 'Rowan approves refunds', where: 'Approvals', at: 3 }],
    });
  });

  it("writes nothing for another owner's employees, in mock mode, or for a caller whose address is not verified", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    await chatCard(harness, await employee(harness, { userId: 'stranger' }));
    const owner = await harness
      .withIdentity(managerIdentity())
      .mutation(api.people.ensureOwner, {});
    expect(owner.identitiesAdded).toBe(1);
    expect((await graphOf(harness, 'stranger')).people).toEqual([]);

    const unverified = await harness
      .withIdentity(managerIdentity('other', { emailVerified: false }))
      .mutation(api.people.ensureOwner, {});
    expect(unverified).toEqual({ personId: null, identitiesAdded: 0 });
    expect((await graphOf(harness, 'other')).people).toEqual([]);

    restoreSurfaceMode();
    useSurfaceMode('mock');
    const mock = convexTest(schema, allConvexModules());
    await chatCard(mock, await employee(mock));
    const hosted = await mock.withIdentity(managerIdentity()).mutation(api.people.ensureOwner, {});
    expect(hosted).toEqual({ personId: null, identitiesAdded: 0 });
    expect((await graphOf(mock)).people).toEqual([]);
  });

  it('refuses an anonymous caller before it reads or writes anything', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    await chatCard(harness, await employee(harness));
    const { notAuthenticatedMessage } = await import('../../convex/devAuth');
    await expect(harness.mutation(api.people.ensureOwner, {})).rejects.toMatchObject({
      data: notAuthenticatedMessage(),
    });
    expect((await graphOf(harness)).people).toEqual([]);
  });
});

/** A proposal from Priya's one-to-one naming Priya Shah as a collaborator, proposed at 10. */
async function proposePriya(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<ProposedPerson> = {},
): Promise<Id<'people'>> {
  const outcome = await harness.run(
    async (ctx) =>
      await proposePersonInTransaction(
        ctx,
        'owner',
        {
          name: 'Priya Shah',
          identities: [],
          evidence: [
            { quote: 'Priya Shah for segment and pipeline.', where: 'the one-to-one', at: 5 },
          ],
          edges: [{ type: 'collaborator', fromAgentId: agentId, scope: 'segment and pipeline' }],
          ...fields,
        },
        { source: 'one-to-one' },
        10,
      ),
  );
  return outcome.personId;
}

describe('people graph card', (): void => {
  it('a proposal never becomes active without Confirm, and Confirm makes the person and its edge facts', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await proposePriya(harness, agentId);
    const owner = harness.withIdentity(managerIdentity());

    expect(await owner.query(api.people.collaboratorsOf, { agentId })).toEqual([]);
    const before = await owner.query(api.people.forEmployee, { agentId });
    expect(before.confirmed).toEqual([]);
    expect(before.proposals).toMatchObject([
      {
        personId,
        name: 'Priya Shah',
        status: 'unverified',
        evidence: [{ quote: 'Priya Shah for segment and pipeline.', where: 'the one-to-one' }],
        waiting: [{ type: 'collaborator', scope: 'segment and pipeline' }],
      },
    ]);

    expect(await owner.mutation(api.people.confirm, { personId, agentId })).toEqual({
      edgesConfirmed: 1,
    });
    const { people, edges } = await graphRows(harness);
    expect(people[0]).toMatchObject({ status: 'active' });
    expect(people[0]?.confirmedAt).toBeTypeOf('number');
    expect(edges[0]).toMatchObject({ status: 'active' });
    expect(edges[0]?.confirmedAt).toBeTypeOf('number');
    expect(await owner.query(api.people.collaboratorsOf, { agentId })).toMatchObject([
      { personId, displayName: 'Priya Shah', type: 'collaborator', scope: 'segment and pipeline' },
    ]);
    const after = await owner.query(api.people.forEmployee, { agentId });
    expect(after.proposals).toEqual([]);
    expect(after.confirmed).toMatchObject([{ personId, edges: [{ fromEmployee: true }] }]);
  });

  it('refuses Confirm on a person with nothing waiting, so a second press changes nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await proposePriya(harness, agentId);
    const owner = harness.withIdentity(managerIdentity());
    await owner.mutation(api.people.confirm, { personId, agentId });
    await expect(owner.mutation(api.people.confirm, { personId, agentId })).rejects.toMatchObject({
      data: NOTHING_WAITING,
    });
  });

  it('dismisses a proposal and keeps it, its edge retired without ever having held', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await proposePriya(harness, agentId);
    const owner = harness.withIdentity(managerIdentity());
    expect(await owner.mutation(api.people.dismiss, { personId, agentId })).toEqual({
      edgesRetired: 1,
    });
    const { people, edges } = await graphRows(harness);
    expect(people[0]).toMatchObject({ status: 'dismissed' });
    expect(edges[0]).toMatchObject({ status: 'retired' });
    expect(edges[0]?.effectiveUntil).toBeUndefined();
    expect((await owner.query(api.people.forEmployee, { agentId })).proposals).toEqual([]);
  });

  it('a name-only match is offered as possibly the same, never merged, and merged only by Same person', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const known = await seedPerson(harness, 'Priya Shah');
    await seedEdge(harness, known, { type: 'collaborator', fromAgentId: agentId });
    const offered = await proposePriya(harness, agentId, {
      edges: [{ type: 'escalation-contact', fromAgentId: agentId, scope: 'pipeline' }],
    });
    const owner = harness.withIdentity(managerIdentity());

    const view = await owner.query(api.people.forEmployee, { agentId });
    expect(view.proposals).toMatchObject([
      { personId: offered, possiblySameAs: { personId: known, name: 'Priya Shah' } },
    ]);
    await expect(
      owner.mutation(api.people.confirm, { personId: offered, agentId }),
    ).rejects.toMatchObject({ data: SAY_WHETHER_SAME_FIRST });
    expect((await graphRows(harness)).people).toHaveLength(2);

    expect(await owner.mutation(api.people.samePerson, { personId: offered, agentId })).toEqual({
      personId: known,
    });
    const { people, edges } = await graphRows(harness);
    expect(people).toHaveLength(1);
    expect(people[0]?.evidence).toMatchObject([{ quote: 'Priya Shah for segment and pipeline.' }]);
    expect(edges.find((edge) => edge.type === 'escalation-contact')).toMatchObject({
      toPersonId: known,
      status: 'proposed',
    });
  });

  it('keeps a name-only match apart on Different, for Confirm or Dismiss of its own', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const known = await seedPerson(harness, 'Priya Shah');
    const offered = await proposePriya(harness, agentId);
    const owner = harness.withIdentity(managerIdentity());
    await owner.mutation(api.people.notTheSame, { personId: offered, agentId });
    await expect(
      owner.mutation(api.people.samePerson, { personId: offered, agentId }),
    ).rejects.toMatchObject({ data: NOT_OFFERED_AS_SAME });
    await owner.mutation(api.people.confirm, { personId: offered, agentId });
    const { people } = await graphRows(harness);
    expect(people.map((person) => person._id).sort()).toEqual([known, offered].sort());
    expect(people.every((person) => person.status === 'active')).toBe(true);
  });

  it('drops a lookup match on A different person and keeps the proposal waiting', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await proposePriya(harness, agentId);
    const identityId = await seedIdentity(harness, personId, {
      provider: 'slack',
      externalId: 'U0SARA',
      displayName: 'sara',
    });
    const owner = harness.withIdentity(managerIdentity());
    expect((await owner.query(api.people.forEmployee, { agentId })).proposals).toMatchObject([
      { personId, match: { identityId, handle: 'sara' } },
    ]);
    await owner.mutation(api.people.notThisMatch, { personId, identityId, agentId });
    const view = await owner.query(api.people.forEmployee, { agentId });
    expect(view.proposals).toMatchObject([{ personId, status: 'unverified' }]);
    expect(view.proposals[0]?.match).toBeUndefined();
    expect((await graphRows(harness)).identities).toEqual([]);
  });

  it("shows on an employee's tab only the proposals that concern it or everyone", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priyaId = await seedEmployee(harness);
    const mateoId = await seedEmployee(harness, { name: 'Mateo' });
    await proposePriya(harness, priyaId);
    await seedPerson(harness, 'Dana Okafor', { status: 'unverified', confirmedAt: undefined });
    const owner = harness.withIdentity(managerIdentity());
    const mateo = await owner.query(api.people.forEmployee, { agentId: mateoId });
    expect(mateo.proposals.map((row) => row.name)).toEqual(['Dana Okafor']);
    const priya = await owner.query(api.people.forEmployee, { agentId: priyaId });
    expect(priya.proposals.map((row) => row.name)).toEqual(['Dana Okafor', 'Priya Shah']);
  });

  it('supersedes an edited edge and ends a retired one, each answering for the dates it held', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await seedPerson(harness, 'Priya Shah');
    const owner = harness.withIdentity(managerIdentity());
    const first = await owner.mutation(api.people.addRelationship, {
      personId,
      agentId,
      type: 'collaborator',
      scope: ' pipeline ',
    });
    const second = await owner.mutation(api.people.editRelationship, {
      relationshipId: first,
      agentId,
      type: 'escalation-contact',
      scope: 'pipeline',
    });
    await owner.mutation(api.people.retireRelationship, { relationshipId: second, agentId });
    const { edges } = await graphRows(harness);
    const old = edges.find((edge) => edge._id === first);
    const replaced = edges.find((edge) => edge._id === second);
    expect(old).toMatchObject({ status: 'superseded', scope: 'pipeline', type: 'collaborator' });
    expect(replaced).toMatchObject({ status: 'retired', supersedes: first });
    expect(replaced?.effectiveUntil).toBeTypeOf('number');
    await expect(
      owner.mutation(api.people.retireRelationship, { relationshipId: second, agentId }),
    ).rejects.toMatchObject({ data: RELATIONSHIP_ENDED });
  });

  it('refuses an edge to a person the manager has not confirmed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const personId = await proposePriya(harness, agentId);
    await expect(
      harness.withIdentity(managerIdentity()).mutation(api.people.addRelationship, {
        personId,
        agentId,
        type: 'collaborator',
      }),
    ).rejects.toMatchObject({ data: CONFIRM_BEFORE_RELATING });
  });

  it("answers another owner's person as one that does not exist, and the owner's own row is never a proposal", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const theirs = await seedPerson(harness, 'Priya Shah', {
      userId: 'stranger',
      status: 'unverified',
    });
    const own = await seedPerson(harness, 'Rowan Hale', { isOwner: true });
    const owner = harness.withIdentity(managerIdentity());
    await expect(
      owner.mutation(api.people.confirm, { personId: theirs, agentId }),
    ).rejects.toMatchObject({ data: PERSON_NOT_YOURS });
    await expect(owner.query(api.people.identityOf, { personId: theirs })).rejects.toMatchObject({
      data: PERSON_NOT_YOURS,
    });
    await expect(
      owner.mutation(api.people.dismiss, { personId: own, agentId }),
    ).rejects.toMatchObject({
      data: OWNER_IS_THE_MANAGER,
    });
  });
});

describe('people graph readers: the audit six queries', (): void => {
  it('answers the current escalation contact: the employee own, else the owner-wide one, else the manager', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const rowan = await seedPerson(harness, 'Rowan Hale', { isOwner: true });
    const dana = await seedPerson(harness, 'Dana Okafor');
    const lee = await seedPerson(harness, 'Lee Tan');
    const own = await seedEdge(harness, dana, { type: 'escalation-contact', fromAgentId: agentId });
    await seedEdge(harness, lee, { type: 'escalation-contact', scope: 'ledger access' });
    const owner = harness.withIdentity(managerIdentity());

    expect(await owner.query(api.people.escalationContactFor, { agentId })).toMatchObject({
      kind: 'person',
      via: 'employee',
      personId: dana,
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(own, { status: 'retired', effectiveUntil: 2 });
    });
    expect(await owner.query(api.people.escalationContactFor, { agentId })).toMatchObject({
      kind: 'person',
      via: 'owner',
      personId: lee,
    });
    expect(
      await owner.query(api.people.escalationContactFor, { agentId, covering: 'Linear access' }),
    ).toEqual({ kind: 'manager', personId: rowan });
  });

  it('answers the manager with no person for an owner who has no row of their own yet', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    expect(
      await harness
        .withIdentity(managerIdentity())
        .query(api.people.escalationContactFor, { agentId }),
    ).toEqual({ kind: 'manager', personId: null });
  });

  it('answers the approver for a scope from the owner-wide approval edges in force', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const dana = await seedPerson(harness, 'Dana Okafor', { title: 'Finance systems owner' });
    await seedEdge(harness, dana, { type: 'approval-authority', scope: 'NetLedger access' });
    const proposed = await seedPerson(harness, 'Lee Tan');
    await seedEdge(harness, proposed, {
      type: 'approval-authority',
      scope: 'NetLedger access',
      status: 'proposed',
      confirmedAt: undefined,
    });
    expect(
      await harness
        .withIdentity(managerIdentity())
        .query(api.people.approverFor, { covering: 'netledger' }),
    ).toEqual([
      {
        personId: dana,
        displayName: 'Dana Okafor',
        title: 'Finance systems owner',
        scope: 'NetLedger access',
        since: 1,
      },
    ]);
  });

  it('answers the approver on a past date from the edge that held then, not the one that replaced it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const dana = await seedPerson(harness, 'Dana Okafor');
    const lee = await seedPerson(harness, 'Lee Tan');
    const old = await seedEdge(harness, dana, {
      type: 'approval-authority',
      scope: 'NetLedger access',
      effectiveFrom: 100,
      effectiveUntil: 200,
      status: 'superseded',
    });
    await seedEdge(harness, lee, {
      type: 'approval-authority',
      scope: 'NetLedger access',
      effectiveFrom: 200,
      supersedes: old,
    });
    const owner = harness.withIdentity(managerIdentity());
    const at = async (moment: number): Promise<string[]> =>
      (await owner.query(api.people.approverFor, { covering: 'NetLedger', at: moment })).map(
        (answer) => answer.displayName,
      );
    expect(await at(50)).toEqual([]);
    expect(await at(150)).toEqual(['Dana Okafor']);
    expect(await at(250)).toEqual(['Lee Tan']);
  });

  it('answers ambiguous for a Linear display name matching two identities, and never picks one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const one = await seedPerson(harness, 'Sam Lee');
    const two = await seedPerson(harness, 'Samuel Lee');
    await seedIdentity(harness, one, {
      provider: 'linear',
      externalId: 'lin-1',
      displayName: 'Sam Lee',
    });
    await seedIdentity(harness, two, {
      provider: 'linear',
      externalId: 'lin-2',
      displayName: 'sam lee',
    });
    const owner = harness.withIdentity(managerIdentity());
    expect(
      await owner.query(api.people.personFor, { provider: 'linear', displayName: 'Sam Lee' }),
    ).toEqual({ kind: 'ambiguous', candidates: 2 });
    expect(
      await owner.query(api.people.personFor, {
        provider: 'linear',
        externalId: 'lin-2',
        displayName: 'Sam Lee',
      }),
    ).toEqual({ kind: 'person', personId: two });
  });

  it('answers unknown for a Slack id no lookup recorded, and for one recorded only on a proposal', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const proposal = await seedPerson(harness, 'Sara Lim', { status: 'unverified' });
    await seedIdentity(harness, proposal, { provider: 'slack', externalId: 'U0SARA' });
    const owner = harness.withIdentity(managerIdentity());
    expect(
      await owner.query(api.people.personFor, { provider: 'slack', externalId: 'U0NOBODY' }),
    ).toEqual({ kind: 'unknown' });
    expect(
      await owner.query(api.people.personFor, { provider: 'slack', externalId: 'U0SARA' }),
    ).toEqual({ kind: 'unknown' });
    expect(
      await owner.query(api.people.personFor, { provider: 'slack', displayName: 'Sara Lim' }),
    ).toEqual({ kind: 'unknown' });
  });

  it("answers the collaborators of an employee in force, and none of another owner's edges from it", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const priya = await seedPerson(harness, 'Priya Shah', { team: 'Revenue operations' });
    const aman = await seedPerson(harness, 'Aman Rao');
    const gone = await seedPerson(harness, 'Old Friend');
    const stranger = await seedPerson(harness, 'Their Person', { userId: 'stranger' });
    await seedEdge(harness, priya, {
      type: 'collaborator',
      fromAgentId: agentId,
      scope: 'pipeline',
    });
    await seedEdge(harness, aman, { type: 'adjacent-role', fromAgentId: agentId });
    await seedEdge(harness, gone, {
      type: 'collaborator',
      fromAgentId: agentId,
      status: 'retired',
      effectiveUntil: 2,
    });
    await seedEdge(harness, stranger, {
      type: 'collaborator',
      fromAgentId: agentId,
      userId: 'stranger',
    });
    expect(
      await harness.withIdentity(managerIdentity()).query(api.people.collaboratorsOf, { agentId }),
    ).toEqual([
      { personId: aman, displayName: 'Aman Rao', type: 'adjacent-role' },
      {
        personId: priya,
        displayName: 'Priya Shah',
        team: 'Revenue operations',
        type: 'collaborator',
        scope: 'pipeline',
      },
    ]);
  });

  it("reads a person's identities under the owner scope only", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await seedPerson(harness, 'Priya Shah');
    await seedIdentity(harness, priya, {
      provider: 'slack',
      externalId: 'U0PRIYA',
      providerWorkspaceId: 'T1',
      displayName: 'priya',
    });
    await seedIdentity(harness, priya, {
      provider: 'linear',
      externalId: 'lin-9',
      userId: 'stranger',
    });
    expect(
      await harness
        .withIdentity(managerIdentity())
        .query(api.people.identityOf, { personId: priya }),
    ).toMatchObject([
      {
        provider: 'slack',
        externalId: 'U0PRIYA',
        workspaceId: 'T1',
        displayName: 'priya',
        verified: true,
      },
    ]);
  });
});

describe('people.resolveItemPeople: intake writes whom the strings are, beside them', (): void => {
  /** A listed Linear item of an employee, with the strings intake read. */
  async function listedItem(harness: Harness, agentId: Id<'agents'>): Promise<Id<'workItems'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'FIN-1',
          title: 'Post the close note',
          contentSummary: 'Post the close note.',
          contentRefs: [],
          requesterLabel: 'Rowan Hale',
          requester: 'Rowan Hale',
          owner: 'Dana Okafor',
          state: 'discovered',
          observedAt: 1,
          createdAt: 1,
        }),
    );
  }

  it('resolves the owner by a recorded Linear id and keeps both strings as intake read them', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const itemId = await listedItem(harness, agentId);
    const dana = await seedPerson(harness, 'Dana Okafor');
    await seedIdentity(harness, dana, {
      provider: 'linear',
      externalId: 'lin-dana',
      displayName: 'Dana Okafor',
    });
    expect(
      await harness.mutation(internal.people.resolveItemPeople, {
        agentId,
        sourceSystem: 'linear',
        externalId: 'FIN-1',
        startedUnder: 'owner',
        requester: [{ provider: 'linear', externalId: 'lin-rowan', displayName: 'Rowan Hale' }],
        owner: [{ provider: 'linear', externalId: 'lin-dana', displayName: 'Dana Okafor' }],
      }),
    ).toBe(true);
    const item = await harness.run(async (ctx) => await ctx.db.get(itemId));
    expect(item).toMatchObject({
      requester: 'Rowan Hale',
      owner: 'Dana Okafor',
      requesterLabel: 'Rowan Hale',
      requesterPerson: { kind: 'unknown' },
      ownerPerson: { kind: 'person', personId: dana },
    });
  });

  it('falls back to the address a GraphQL read gave when no Linear identity is recorded', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const itemId = await listedItem(harness, agentId);
    const dana = await seedPerson(harness, 'Dana Okafor', { primaryEmail: 'dana@kestrel.test' });
    await harness.mutation(internal.people.resolveItemPeople, {
      agentId,
      sourceSystem: 'linear',
      externalId: 'FIN-1',
      startedUnder: 'owner',
      owner: [
        { provider: 'linear', externalId: 'lin-dana' },
        { provider: 'email', externalId: 'Dana@Kestrel.test' },
      ],
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(itemId)))?.ownerPerson).toEqual({
      kind: 'person',
      personId: dana,
    });
  });

  it('writes nothing once a handover moved the employee since the sweep read it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const itemId = await listedItem(harness, agentId);
    expect(
      await harness.mutation(internal.people.resolveItemPeople, {
        agentId,
        sourceSystem: 'linear',
        externalId: 'FIN-1',
        startedUnder: 'someone-else',
        owner: [{ provider: 'linear', externalId: 'lin-dana' }],
      }),
    ).toBe(false);
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(itemId)))?.ownerPerson,
    ).toBeUndefined();
  });
});

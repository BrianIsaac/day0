/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

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

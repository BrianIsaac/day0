import { convexTest } from 'convex-test';
import type { GenericId } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { isReprobeCandidate } from '../../convex/orientationData';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

describe('orientation data boundary', (): void => {
  it('returns only the surfaces of the requested agent', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [mine, theirs] = await harness.run(async (ctx): Promise<Id<'agents'>[]> => {
      const ids: Id<'agents'>[] = [];
      for (const name of ['mine', 'theirs']) {
        ids.push(
          await ctx.db.insert('agents', {
            bossEmail: MANAGER_ADDRESS,
            name,
            userId: name,
            state: 'active',
            createdAt: 1,
          }),
        );
      }
      return ids;
    });
    for (const [agentId, name] of [
      [mine, 'Linear'],
      [theirs, 'Slack'],
    ] as const) {
      await harness.mutation(internal.surfaces.seedFromCharter, {
        agentId,
        namedSystems: [{ name, class: 'kanban', whereMentioned: `${name} named.` }],
      });
    }
    const surfaces = await harness.query(internal.orientationData.surfacesForAgent, {
      agentId: mine,
    });
    expect(surfaces.map((surface): string => surface.slug)).toEqual(['linear']);
    await expect(
      harness.query(internal.orientationData.surfaceForOrientation, {
        surfaceId: surfaces[0]._id,
      }),
    ).resolves.toMatchObject({
      surface: { _id: surfaces[0]._id, agentId: mine },
      agent: { _id: mine, userId: 'mine' },
    });
  });

  it('re-probes connected rows and dead rows that still hold a credential and the approval', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 're-probe test',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [
        { name: 'Linear', class: 'kanban', whereMentioned: 'Linear.' },
        { name: 'Slack', class: 'chat', whereMentioned: 'Slack.' },
        { name: 'Jira', class: 'kanban', whereMentioned: 'Jira.' },
        { name: 'Asana', class: 'kanban', whereMentioned: 'Asana.' },
      ],
    });
    const surfaces = await harness.query(internal.orientationData.surfacesForAgent, { agentId });
    const bySlug = Object.fromEntries(
      surfaces.map((surface): [string, Doc<'surfaces'>] => [surface.slug, surface]),
    );
    const credentialId = '10000credentials' as GenericId<'credentials'>;
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(bySlug.linear._id, { verdict: 'connected', credentialLanded: true });
      // Dead after a transient failure, still approved and still holding a credential: retried.
      await ctx.db.patch(bySlug.jira._id, {
        verdict: 'listed-dead',
        credentialId,
        managerApprovedAt: 1,
      });
      // Dead but rejected since (no stamps): not retried.
      await ctx.db.patch(bySlug.asana._id, { verdict: 'listed-dead', credentialId });
      // No credential at all: nothing to retry until one lands.
      await ctx.db.patch(bySlug.slack._id, {
        verdict: 'ungranted',
        managerApprovedAt: 1,
      });
    });
    const candidates = await harness.query(internal.orientationData.reprobeCandidates, {});
    expect(candidates.map((surface): string => surface.slug).sort()).toEqual(['jira', 'linear']);
    expect(isReprobeCandidate({ ...bySlug.slack, verdict: 'approved' })).toBe(false);
  });

  it('re-probes a chat surface the manager lookup left ungranted, and no other ungranted row (Q6)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 're-probe lookup test',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: [
        { name: 'Slack', class: 'chat', whereMentioned: 'Slack.' },
        { name: 'Teams', class: 'chat', whereMentioned: 'Teams.' },
        { name: 'Jira', class: 'kanban', whereMentioned: 'Jira.' },
      ],
    });
    const surfaces = await harness.query(internal.orientationData.surfacesForAgent, { agentId });
    const bySlug = Object.fromEntries(
      surfaces.map((surface): [string, Doc<'surfaces'>] => [surface.slug, surface]),
    );
    const credentialId = '10000credentials' as GenericId<'credentials'>;
    const approved = { credentialId, managerApprovedAt: 1 };
    await harness.run(async (ctx): Promise<void> => {
      // The account behind the manager email was deactivated: the token works.
      await ctx.db.patch(bySlug.slack._id, {
        verdict: 'ungranted',
        reason: 'the manager email boss@day0.local resolves to a deactivated Slack user.',
        ...approved,
      });
      // The credential itself was refused: a new one is what heals it.
      await ctx.db.patch(bySlug.teams._id, {
        verdict: 'ungranted',
        reason: 'Teams refused the credential (invalid_auth).',
        ...approved,
      });
      // A kanban row never holds a manager lookup, whatever its text says.
      await ctx.db.patch(bySlug.jira._id, {
        verdict: 'ungranted',
        reason: 'returned no manager identity',
        ...approved,
      });
    });
    const candidates = await harness.query(internal.orientationData.reprobeCandidates, {});
    expect(candidates.map((surface): string => surface.slug)).toEqual(['slack']);
    const slack = { ...bySlug.slack, ...approved, verdict: 'ungranted' as const };
    expect(
      isReprobeCandidate({
        ...slack,
        reason: 'the agent has no manager email, so the manager DM cannot be derived.',
      }),
    ).toBe(true);
    expect(
      isReprobeCandidate({
        ...slack,
        reason: 'the manager email boss@day0.local resolves to a deactivated Slack user.',
        managerApprovedAt: undefined,
      }),
    ).toBe(false);
  });

  it("returns only the deployment's chat surfaces to the minute-by-minute decision poll", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentIds = await harness.run(
      async (ctx): Promise<Id<'agents'>[]> =>
        await Promise.all(
          ['first', 'second'].map(
            async (name: string): Promise<Id<'agents'>> =>
              await ctx.db.insert('agents', {
                bossEmail: `${name}@day0.local`,
                name,
                userId: name,
                state: 'active',
                createdAt: 1,
              }),
          ),
        ),
    );
    await Promise.all(
      agentIds.map(
        async (agentId: Id<'agents'>, index: number): Promise<Id<'surfaces'>[]> =>
          await harness.mutation(internal.surfaces.seedFromCharter, {
            agentId,
            namedSystems: [
              {
                name: index === 0 ? 'Linear' : 'Slack',
                class: index === 0 ? 'kanban' : 'chat',
                whereMentioned: 'Named for intake.',
              },
            ],
          }),
      ),
    );

    // The manager decision poll runs every minute against a surface set that
    // now grows with the documented estate, so it reads the chat rows by
    // index rather than scanning every surface in the deployment.
    const chat = await harness.query(internal.orientationData.chatSurfacesForIntake, {});
    expect(chat.map((surface): string => surface.slug)).toEqual(['slack']);
  });
});

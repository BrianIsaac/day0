/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { MIGRATION_NAMES } from '../../convex/migrations';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { insertMinimalRow } from './schema-fixtures';

type Harness = TestConvex<typeof schema>;

/** A harness that enforces the deployed backend's per-transaction limits. */
function limitedHarness(): Harness {
  return convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
}

async function agent(harness: Harness, fields: { userId?: string } = {}): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        state: 'active',
        createdAt: 1,
        ...fields,
      }),
  );
}

async function source(harness: Harness, userId: string): Promise<Id<'docSources'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('docSources', {
        userId,
        label: 'Runbooks',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      }),
  );
}

async function runAll(harness: Harness): Promise<void> {
  const result = await harness.action(internal.migrations.runPending, {});
  expect(result.pending).toEqual([]);
}

describe('the upgrade migrations', (): void => {
  it('moves daytonaSandboxId onto sandboxId across several pages, and a second run changes nothing', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    await harness.run(async (ctx) => {
      for (let index = 0; index < 230; index += 1) {
        await ctx.db.insert('skills', {
          agentId,
          name: `skill-${index}`,
          description: 'A skill.',
          body: '',
          sourceType: 'agent-authored',
          state: 'registered',
          createdAt: 1,
          ...(index % 2 === 0 ? { daytonaSandboxId: `sandbox-${index}` } : {}),
          ...(index === 4 ? { sandboxId: 'local:kept' } : {}),
        });
      }
    });

    await runAll(harness);

    const skills = await harness.run(async (ctx) => await ctx.db.query('skills').collect());
    expect(skills.filter((skill) => skill.daytonaSandboxId !== undefined)).toEqual([]);
    expect(skills.find((skill) => skill.name === 'skill-2')?.sandboxId).toBe('sandbox-2');
    expect(skills.find((skill) => skill.name === 'skill-4')?.sandboxId).toBe('local:kept');
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'skills-sandbox-id')).toMatchObject({
      read: 230,
      changed: 115,
    });

    // A finished migration reads nothing again, even over a row put back under the old name.
    await harness.run(async (ctx) => {
      const skill = skills.find((row) => row.name === 'skill-6')!;
      await ctx.db.patch(skill._id, { daytonaSandboxId: 'written-after' });
    });
    await runAll(harness);
    expect(
      (await harness.query(internal.migrations.status, {})).migrations.find(
        (row) => row.name === 'skills-sandbox-id',
      ),
    ).toMatchObject({ read: 230, changed: 115 });
  });

  it('clears a revokedAt the sync stamped when it superseded a credential, and keeps a person’s earlier revoke', async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const { syncStamped, personRevoked, active } = await harness.run(async (ctx) => {
      const completedAt = 1_758_900_000_000;
      await ctx.db.insert('docSyncRuns', {
        sourceId,
        refs: [],
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
        state: 'completed',
        createdAt: completedAt - 5_000,
        completedAt,
      });
      const row = (ref: string, fields: { revokedAt?: number; status?: 'superseded' }) =>
        ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: 'Linear token',
          ciphertext: 'sealed',
          iv: 'iv',
          source: { sourceId, ref },
          createdAt: 1,
          ...fields,
        });
      return {
        // The old sync stamped the run's own completion moment.
        syncStamped: await row('linear.md#credential=1', {
          status: 'superseded',
          revokedAt: completedAt,
        }),
        // A person revoked it earlier; the sync then superseded it and kept that stamp.
        personRevoked: await row('slack.md#credential=1', {
          status: 'superseded',
          revokedAt: completedAt - 86_400_000,
        }),
        active: await row('notion.md#credential=1', { revokedAt: completedAt }),
      };
    });

    await runAll(harness);

    const [first, second, third] = await harness.run(
      async (ctx) =>
        await Promise.all([ctx.db.get(syncStamped), ctx.db.get(personRevoked), ctx.db.get(active)]),
    );
    expect(first).toMatchObject({ status: 'superseded' });
    expect(first?.revokedAt).toBeUndefined();
    expect(second?.revokedAt).toBe(1_758_900_000_000 - 86_400_000);
    // Revoked by a person while active: never touched, whatever its stamp.
    expect(third?.revokedAt).toBe(1_758_900_000_000);
  });

  it('turns a legacy inclusion list into exclusions, so a source linked later is inherited and the rest read as before', async (): Promise<void> => {
    const harness = limitedHarness();
    const included = await source(harness, 'owner');
    const left = await source(harness, 'owner');
    const listed = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
          docSourceIds: [included],
        }),
    );

    await runAll(harness);
    const later = await source(harness, 'owner');

    const row = await harness.run(async (ctx) => await ctx.db.get(listed));
    expect(row?.docSourceIds).toBeUndefined();
    expect(row?.excludedDocSourceIds).toEqual([left]);
    const { agentReadsSource } = await import('../../convex/docSources');
    expect([included, left, later].map((id) => agentReadsSource(row!, id))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('gives an ownerless agent to the one owner, and leaves it when the deployment has two', async (): Promise<void> => {
    const single = limitedHarness();
    await agent(single, { userId: 'dev-no-auth|local-boss' });
    const orphan = await agent(single);
    await runAll(single);
    expect((await single.run(async (ctx) => await ctx.db.get(orphan)))?.userId).toBe(
      'dev-no-auth|local-boss',
    );

    const shared = limitedHarness();
    await agent(shared, { userId: 'owner-a' });
    await agent(shared, { userId: 'owner-b' });
    const unclaimed = await agent(shared);
    await runAll(shared);
    expect((await shared.run(async (ctx) => await ctx.db.get(unclaimed)))?.userId).toBeUndefined();
    expect(
      (await shared.query(internal.migrations.status, {})).migrations.find(
        (row) => row.name === 'agents-owner',
      ),
    ).toMatchObject({ read: 1, changed: 0 });
  });

  it('clears the inclusion list of an agent it could not give an owner, since it reads no source either way', async (): Promise<void> => {
    const harness = limitedHarness();
    await agent(harness, { userId: 'owner-a' });
    await agent(harness, { userId: 'owner-b' });
    const sourceId = await source(harness, 'owner-a');
    const orphan = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'Priya',
          state: 'active',
          createdAt: 1,
          docSourceIds: [sourceId],
        }),
    );

    await runAll(harness);

    const row = await harness.run(async (ctx) => await ctx.db.get(orphan));
    expect(row?.userId).toBeUndefined();
    expect(row?.docSourceIds).toBeUndefined();
    expect(row?.excludedDocSourceIds).toBeUndefined();
  });

  it('reports only the migrations a call ran, not those an earlier call finished', async (): Promise<void> => {
    const harness = limitedHarness();
    const first = await harness.action(internal.migrations.runPending, {});
    expect(first.migrations.map((row) => row.name)).toEqual([...MIGRATION_NAMES]);
    await expect(harness.action(internal.migrations.runPending, {})).resolves.toEqual({
      migrations: [],
      pending: [],
    });
  });

  it('clears the retired posture, supervised-run and credentialRef fields', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'Priya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
          posture: 'supervised',
        }),
    );
    const { skillId, surfaceId } = await harness.run(async (ctx) => {
      const surfaceId = (await insertMinimalRow(
        ctx as never,
        'surfaces',
        agentId,
      )) as Id<'surfaces'>;
      await ctx.db.patch(surfaceId, { credentialRef: 'linear' });
      const skillId = await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment',
        description: 'A skill.',
        body: '',
        sourceType: 'agent-authored',
        state: 'registered',
        createdAt: 1,
        supervisedRunsCompleted: 3,
      });
      return { skillId, surfaceId };
    });

    await runAll(harness);

    const [agentRow, skill, surface] = await harness.run(
      async (ctx) =>
        await Promise.all([ctx.db.get(agentId), ctx.db.get(skillId), ctx.db.get(surfaceId)]),
    );
    expect(agentRow?.posture).toBeUndefined();
    expect(skill?.supervisedRunsCompleted).toBeUndefined();
    expect(surface?.credentialRef).toBeUndefined();
  });

  it('copies listings kept as work.listed events into ticketListings once, where the re-read finds them', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const todo = { assigned: false, state: 'Todo', stateType: 'unstarted', doNotAutomate: false };
    const taken = { ...todo, assigned: true, assigneeId: 'user-ana' };
    const workItemId = await harness.mutation(internal.work.seedItem, {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-9',
      title: 'Reconcile the September pipeline',
      contentSummary: 'First read of the ticket.',
      contentRefs: [],
      tracker: todo,
    });
    const listedAt = Date.now() + 60_000;
    await harness.run(async (ctx) => {
      // As the listing region kept it before the table existed.
      await ctx.db.insert('events', {
        agentId,
        type: 'work.listed',
        payload: { workItemId, tracker: taken },
        createdAt: listedAt,
      });
      await ctx.db.insert('events', {
        agentId,
        type: 'work.listed',
        payload: { workItemId: 'not-an-id', tracker: taken },
        createdAt: listedAt,
      });
    });
    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: listedAt }),
    ).resolves.toEqual({ planned: todo, acknowledged: null });

    await runAll(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(
        (await ctx.db
          .query('migrations')
          .withIndex('by_name', (q) => q.eq('name', 'ticket-listings'))
          .unique())!._id,
        { completedAt: undefined, cursor: undefined },
      );
    });
    await runAll(harness);

    const kept = await harness.run(async (ctx) => await ctx.db.query('ticketListings').collect());
    expect(kept.map((row) => ({ tracker: row.tracker, listedAt: row.listedAt }))).toEqual([
      { tracker: taken, listedAt },
    ]);
    await expect(
      harness.query(internal.work.listedSnapshot, { workItemId, before: listedAt }),
    ).resolves.toEqual({ planned: taken, acknowledged: null });
  });
});

describe('the agents-zone migration (N12, the M2 backfill)', (): void => {
  it('gives every agent with no zone the deployment’s zone and a mode, keeps a zone the manager set, and says which zone in the status', async (): Promise<void> => {
    const harness = limitedHarness();
    const bare = await agent(harness, { userId: 'owner' });
    const zoned = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'Aiko',
          state: 'active',
          zone: 'Asia/Singapore',
          mode: 'real',
          createdAt: 2,
        }),
    );
    await runAll(harness);
    const [bareRow, zonedRow] = await harness.run(
      async (ctx) => await Promise.all([ctx.db.get(bare), ctx.db.get(zoned)]),
    );
    expect(bareRow).toMatchObject({ zone: 'UTC', mode: 'mock' });
    expect(zonedRow).toMatchObject({ zone: 'Asia/Singapore', mode: 'real' });
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'agents-zone')).toMatchObject({
      release: '0.5.0',
      read: 2,
      changed: 1,
      note: 'agents with no zone given the deployment’s zone, UTC; with no mode, mock',
    });
  });
});

describe('the retirements migration (Q15, N1)', (): void => {
  it('copies each older retire tombstone into the owner’s retirements once, and leaves a tombstone that already names its row', async (): Promise<void> => {
    const harness = limitedHarness();
    const gone = await agent(harness, { userId: 'owner' });
    const named = await agent(harness, { userId: 'owner' });
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId: gone,
        type: 'agent.retired',
        payload: {
          userId: 'owner',
          agentId: gone,
          retiredAt: 7,
          rowCounts: { events: 3, surfaces: 1 },
          revokedCredentials: 1,
          keptCredentials: 2,
        },
        createdAt: 7,
      });
      const retirementId = await ctx.db.insert('retirements', {
        userId: 'owner',
        agentId: named,
        agentName: 'Mateo',
        retiredAt: 9,
        rowCounts: {},
        revokedCredentials: 0,
        keptCredentials: 0,
        claims: [],
        rejections: [],
      });
      await ctx.db.insert('events', {
        agentId: named,
        type: 'agent.retired',
        payload: { retirementId, agentId: named, retiredAt: 9 },
        createdAt: 9,
      });
      await ctx.db.insert('events', {
        agentId: gone,
        type: 'work.completed',
        payload: {},
        createdAt: 8,
      });
      await ctx.db.delete(gone);
      await ctx.db.delete(named);
    });

    await runAll(harness);
    await runAll(harness);

    const rows = await harness.run(
      async (ctx) => await ctx.db.query('retirements').order('asc').collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.agentId === gone)).toMatchObject({
      userId: 'owner',
      retiredAt: 7,
      rowCounts: { events: 3, surfaces: 1 },
      revokedCredentials: 1,
      keptCredentials: 2,
      claims: [],
      rejections: [],
    });
    const status = await harness.query(internal.migrations.status, {});
    expect(
      status.migrations.find((row) => row.name === 'retirements-from-tombstones'),
    ).toMatchObject({ release: '0.6.0', read: 2, changed: 1, completedAt: expect.any(Number) });
  });
});

describe('the release stamp', (): void => {
  it('is refused while a migration is unfinished, then kept once per release and commit', async (): Promise<void> => {
    const harness = limitedHarness();

    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: '0.3.0', commit: 'abc1234' }),
    ).rejects.toThrow(`migrations still to run (${MIGRATION_NAMES.join(', ')})`);
    expect(await harness.query(internal.migrations.status, {})).toMatchObject({
      release: null,
      pending: [...MIGRATION_NAMES],
    });

    await runAll(harness);
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: '0.3.0', commit: 'abc1234' }),
    ).resolves.toEqual({ release: '0.3.0', previous: null });
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: '0.3.0', commit: 'abc1234' }),
    ).resolves.toEqual({ release: '0.3.0', previous: '0.3.0' });
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: '0.4.0', commit: 'def5678' }),
    ).resolves.toEqual({ release: '0.4.0', previous: '0.3.0' });

    const status = await harness.query(internal.migrations.status, {});
    expect(status.pending).toEqual([]);
    expect(status.release).toMatchObject({ release: '0.4.0', commit: 'def5678' });
    expect(
      await harness.run(async (ctx) => (await ctx.db.query('deploymentVersions').collect()).length),
    ).toBe(2);
  });
});

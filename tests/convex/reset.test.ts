import { convexTest, type TestConvex } from 'convex-test';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { AGENT_KEYED_TABLES } from '../../convex/reset';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { agentKeyedTables, insertMinimalRow } from './schema-fixtures';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Seed one owner with an agent and linked documentation.
 *
 * Args:
 *   harness: Convex test harness.
 *
 * Returns:
 *   Linked source id.
 */
async function seedOwner(harness: ReturnType<typeof convexTest>): Promise<string> {
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Team folder',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'onboarding.md',
      title: 'Onboarding',
      markdown: '# Onboarding',
      updatedAt: 1,
    });
    await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'reset test',
      userId: 'owner',
      state: 'deployed',
      createdAt: 1,
    });
    return sourceId;
  });
}

describe('reset documentation retention', (): void => {
  it('keeps owner-level documentation by default', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedOwner(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.mutation(api.reset.deleteMyData, {})).resolves.toEqual({
      deleted: 1,
      unlinkedSources: 0,
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(sourceId as never))).not.toBeNull();
  });

  it('removes documentation only when explicitly requested', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedOwner(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.reset.deleteMyData, { alsoUnlinkDocumentation: true }),
    ).resolves.toEqual({ deleted: 1, unlinkedSources: 1 });
    expect(await harness.run(async (ctx) => await ctx.db.get(sourceId as never))).toBeNull();
  });
});

describe('reset transient verification state', (): void => {
  it('deletes a lease held by a deleted employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness);
    const agentId = await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('agents')
        .withIndex('by_userId', (q) => q.eq('userId', 'owner'))
        .unique();
      if (!row) throw new Error('agent missing');
      return row._id;
    });
    const { skillId, runId } = await harness.run(async (ctx) => {
      const skillId = await ctx.db.insert('skills', {
        agentId,
        name: 'queued skill',
        description: 'Queued',
        body: '',
        sourceType: 'agent-authored',
        state: 'authoring',
        createdAt: 1,
      });
      const runId = await ctx.db.insert('events', {
        agentId,
        type: 'skill.authoring-claimed',
        payload: { skillId },
        createdAt: 1,
      });
      return { skillId, runId };
    });
    await harness.mutation(internal.sandboxLease.take, { skillId, runId });
    await harness.withIdentity({ subject: 'owner' }).mutation(api.reset.deleteMyData, {});
    expect(await harness.run(async (ctx) => await ctx.db.query('sandboxLeases').collect())).toEqual(
      [],
    );
  });
});

describe('reset completeness', (): void => {
  it('keeps the README table and the README and SECURITY reset counts aligned with the schema', (): void => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const total = Object.keys(schema.tables).length;
    const agentOwned = agentKeyedTables().length + 1;
    const enumerated = AGENT_KEYED_TABLES.length;
    expect(readme).toContain(
      `The schema contains ${total} tables: ${agentOwned} carry per-agent or agent-owned runtime state`,
    );
    expect(readme).toContain(`from ${enumerated} explicitly enumerated related tables`);
    expect(readme).toContain(`in ${enumerated} enumerated related tables`);
    // SECURITY.md is where the README sends a reader for what a reset deletes (review m9).
    const security = readFileSync(new URL('../../SECURITY.md', import.meta.url), 'utf8');
    expect(security).toContain(`in the ${enumerated} enumerated related tables`);
    expect(readme).toContain('| `externalClaims` |');
    expect(readme).toContain('| `corrections` |');
  });

  it('clears every agent-keyed table the schema declares, and names them all', async (): Promise<void> => {
    const tables = agentKeyedTables();
    expect(tables).toContain('managerDecisionNotices');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'reset test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      for (const table of tables) await insertMinimalRow(ctx as never, table, id);
      return id;
    });
    const countRows = async (): Promise<Record<string, number>> =>
      await harness.run(async (ctx) => {
        const counts: Record<string, number> = {};
        for (const table of tables) {
          const rows = await (
            ctx.db as unknown as {
              query: (t: string) => { collect: () => Promise<Array<{ agentId?: string }>> };
            }
          )
            .query(table)
            .collect();
          counts[table] = rows.filter((row) => row.agentId === agentId).length;
        }
        return counts;
      });
    const before = await countRows();
    for (const table of tables) expect(before[table], table).toBeGreaterThan(0);

    await harness.withIdentity({ subject: 'owner' }).mutation(api.reset.deleteMyData, {});

    const after = await countRows();
    for (const table of tables) expect(after[table], table).toBe(0);
    expect(await harness.run(async (ctx) => await ctx.db.get(agentId))).toBeNull();
    // A table added to the schema with an agentId must be added to the reset
    // list; this assertion names the gap before a demo finds it.
    expect([...AGENT_KEYED_TABLES].sort()).toEqual(tables);
  });
});

describe('credential retention on reset', (): void => {
  async function seedCredentials(
    harness: ReturnType<typeof convexTest>,
    sourceId: string,
  ): Promise<Id<'credentials'>[]> {
    return await harness.run(async (ctx) => {
      const base = { userId: 'owner', ciphertext: 'sealed', iv: 'iv', createdAt: 1 } as const;
      return [
        await ctx.db.insert('credentials', {
          ...base,
          kind: 'value',
          label: 'linear service token',
          source: { sourceId: sourceId as Id<'docSources'>, ref: 'linear-automation' },
        }),
        await ctx.db.insert('credentials', {
          ...base,
          kind: 'value',
          label: 'slack bot token',
          source: 'entered',
        }),
        await ctx.db.insert('credentials', {
          ...base,
          kind: 'oauth',
          label: 'slack app install',
          appId: 'A0DAY0',
          source: 'oauth',
        }),
      ];
    });
  }

  it('keeps every credential readable when documentation is kept', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedOwner(harness);
    const ids = await seedCredentials(harness, sourceId);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.reset.deleteMyData, {});
    for (const id of ids) {
      const row = await harness.run(async (ctx) => await ctx.db.get(id));
      expect(row).toMatchObject({ ciphertext: 'sealed', iv: 'iv' });
      expect(row).not.toHaveProperty('revokedAt');
    }
  });

  it('revokes every owned credential and deletes its ciphertext when documentation is unlinked, keeping the audit row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await seedOwner(harness);
    const ids = await seedCredentials(harness, sourceId);
    const strangerId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: 'stranger',
          kind: 'value',
          label: 'someone else',
          ciphertext: 'sealed',
          iv: 'iv',
          source: 'entered',
          createdAt: 1,
        }),
    );
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { alsoUnlinkDocumentation: true });
    const rows = await harness.run(
      async (ctx) => await Promise.all(ids.map(async (id) => await ctx.db.get(id))),
    );
    expect(rows.map((row) => row?.label)).toEqual([
      'linear service token',
      'slack bot token',
      'slack app install',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ userId: 'owner', createdAt: 1, revokedAt: expect.any(Number) });
      expect(row).not.toHaveProperty('ciphertext');
      expect(row).not.toHaveProperty('iv');
    }
    expect(rows[0]?.source).toEqual({ sourceId, ref: 'linear-automation' });
    expect(rows[2]).toMatchObject({ appId: 'A0DAY0', source: 'oauth' });
    for (const id of ids) {
      await expect(
        harness.action(internal.credentials.decrypt, { credentialId: id }),
      ).rejects.toThrow('unavailable');
    }
    // The summary the Surfaces tab reads still lists the rows as revoked.
    const summary = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.credentials.summaryForOwner, {});
    expect(summary.map((row) => row.revokedAt)).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(await harness.run(async (ctx) => await ctx.db.get(strangerId))).toMatchObject({
      ciphertext: 'sealed',
    });
  });
});

describe('retire in real mode', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  /**
   * Load the Convex modules the real-mode stub resolved and seed one owner's two employees.
   *
   * The first employee's surface binds a credential only it uses and a
   * credential its sibling binds too; its Slack provisioning binds a client
   * secret. A documentation source binds a fourth.
   *
   * Returns:
   *   The harness, both employees and the credential ids.
   */
  async function seedRealOwner(): Promise<{
    harness: TestConvex<typeof schema>;
    retiring: Id<'agents'>;
    sibling: Id<'agents'>;
    only: Id<'credentials'>;
    shared: Id<'credentials'>;
    secret: Id<'credentials'>;
    documentation: Id<'credentials'>;
  }> {
    const [{ default: realSchema }, { allConvexModules: realModules }] = await Promise.all([
      import('../../convex/schema'),
      import('./all-modules'),
    ]);
    const harness = convexTest(realSchema, realModules());
    const seeded = await harness.run(async (ctx) => {
      const credential = async (label: string): Promise<Id<'credentials'>> =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label,
          ciphertext: 'sealed',
          iv: 'iv',
          source: 'entered',
          createdAt: 1,
        });
      const only = await credential('linear service token');
      const shared = await credential('slack bot token');
      const secret = await credential('slack client secret');
      const documentation = await credential('notion token');
      await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        credentialId: documentation,
        createdAt: 1,
        updatedAt: 1,
      });
      const employee = async (name: string): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name,
          userId: 'owner',
          state: 'deployed',
          createdAt: 1,
        });
      const retiring = await employee('retiring');
      const sibling = await employee('sibling');
      const surface = {
        displayName: 'Linear',
        class: 'kanban',
        path: 'mcp',
        verdict: 'connected' as const,
        whereFound: [],
        credentialLanded: true,
        createdAt: 1,
      };
      await ctx.db.insert('surfaces', {
        ...surface,
        agentId: retiring,
        slug: 'linear',
        credentialId: only,
      });
      await ctx.db.insert('surfaces', {
        ...surface,
        agentId: retiring,
        slug: 'slack',
        class: 'chat',
        credentialId: shared,
        provisioning: {
          appId: 'A0DAY0',
          appName: 'Day0',
          clientId: 'client',
          clientSecretCredentialId: secret,
          installUrl: 'https://slack.com/oauth/v2/authorize',
          redirectUrl: 'https://day0.local/api/slack/oauth',
          scopes: ['chat:write'],
          createdAt: 1,
        },
      });
      await ctx.db.insert('surfaces', {
        ...surface,
        agentId: sibling,
        slug: 'slack',
        class: 'chat',
        credentialId: shared,
      });
      await ctx.db.insert('events', {
        agentId: retiring,
        type: 'work.discovered',
        payload: {},
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: retiring,
        type: 'work.evaluated',
        payload: {},
        createdAt: 2,
      });
      return { retiring, sibling, only, shared, secret, documentation };
    });
    return { harness, ...seeded };
  }

  it('deletes the working rows and leaves one tombstone on the agent id, naming the owner', async (): Promise<void> => {
    const { harness, retiring } = await seedRealOwner();
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });
    const events = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', retiring))
          .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent.retired',
      payload: {
        userId: 'owner',
        agentId: retiring,
        retiredAt: expect.any(Number),
        rowCounts: { events: 2, surfaces: 2 },
      },
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(retiring))).toBeNull();
    const surfaces = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (q) => q.eq('agentId', retiring))
          .collect(),
    );
    expect(surfaces).toEqual([]);
  });

  it('revokes only the credentials no remaining employee or documentation binds', async (): Promise<void> => {
    const { harness, retiring, sibling, only, shared, secret, documentation } =
      await seedRealOwner();
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });
    const row = async (id: Id<'credentials'>) =>
      await harness.run(async (ctx) => await ctx.db.get(id));
    for (const id of [only, secret]) {
      expect(await row(id)).toMatchObject({ revokedAt: expect.any(Number) });
      expect(await row(id)).not.toHaveProperty('ciphertext');
    }
    for (const id of [shared, documentation]) {
      expect(await row(id)).toMatchObject({ ciphertext: 'sealed' });
      expect(await row(id)).not.toHaveProperty('revokedAt');
    }
    expect(await harness.run(async (ctx) => await ctx.db.get(sibling))).not.toBeNull();
    const [tombstone] = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) => q.eq('agentId', retiring).eq('type', 'agent.retired'))
          .collect(),
    );
    expect(tombstone?.payload).toMatchObject({ revokedCredentials: 2, keptCredentials: 1 });
  });

  it('retires every employee when none is named, revoking what only they bound', async (): Promise<void> => {
    const { harness, retiring, sibling, only, shared, secret, documentation } =
      await seedRealOwner();
    await expect(
      harness.withIdentity({ subject: 'owner' }).mutation(api.reset.deleteMyData, {}),
    ).resolves.toEqual({ deleted: 2, unlinkedSources: 0 });
    const tombstones = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter((event) => event.type === 'agent.retired'),
    );
    expect(tombstones.map((event) => event.agentId).sort()).toEqual([retiring, sibling].sort());
    const row = async (id: Id<'credentials'>) =>
      await harness.run(async (ctx) => await ctx.db.get(id));
    for (const id of [only, shared, secret])
      expect(await row(id)).toMatchObject({ revokedAt: expect.any(Number) });
    expect(await row(documentation)).not.toHaveProperty('revokedAt');
  });

  it('counts a credential purged with the documentation as revoked, not kept', async (): Promise<void> => {
    const { harness, documentation } = await seedRealOwner();
    await harness.run(async (ctx) => {
      const surfaces = await ctx.db.query('surfaces').collect();
      for (const surface of surfaces)
        await ctx.db.patch(surface._id, { credentialId: documentation });
    });

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { alsoUnlinkDocumentation: true });

    const tombstones = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter((event) => event.type === 'agent.retired'),
    );
    for (const tombstone of tombstones) {
      expect(tombstone.payload).toMatchObject({ keptCredentials: 0 });
    }
    expect(await harness.run(async (ctx) => await ctx.db.get(documentation))).toMatchObject({
      revokedAt: expect.any(Number),
    });
  });

  it('refuses to unlink the documentation while retiring one employee', async (): Promise<void> => {
    const { harness, retiring, shared } = await seedRealOwner();
    await expect(
      harness
        .withIdentity({ subject: 'owner' })
        .mutation(api.reset.deleteMyData, { agentId: retiring, alsoUnlinkDocumentation: true }),
    ).rejects.toThrow('unlinking the documentation retires every employee');
    expect(await harness.run(async (ctx) => await ctx.db.get(retiring))).not.toBeNull();
    expect(await harness.run(async (ctx) => await ctx.db.get(shared))).not.toHaveProperty(
      'revokedAt',
    );
  });

  it('refuses to retire an employee the caller does not own', async (): Promise<void> => {
    const { harness, retiring } = await seedRealOwner();
    await expect(
      harness
        .withIdentity({ subject: 'stranger' })
        .mutation(api.reset.deleteMyData, { agentId: retiring }),
    ).rejects.toThrow();
    expect(await harness.run(async (ctx) => await ctx.db.get(retiring))).not.toBeNull();
  });
});

describe('reset in mock mode', (): void => {
  it('wipes the employee and writes no tombstone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedOwner(harness);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.reset.deleteMyData, {});
    expect(await harness.run(async (ctx) => await ctx.db.query('events').collect())).toEqual([]);
  });
});

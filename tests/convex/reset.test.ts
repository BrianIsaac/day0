import { convexTest } from 'convex-test';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { AGENT_KEYED_TABLES } from '../../convex/reset';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { agentKeyedTables, insertMinimalRow } from './schema-fixtures';

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

describe('reset completeness', (): void => {
  it('keeps the README table and reset counts aligned with the schema', (): void => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const total = Object.keys(schema.tables).length;
    const agentOwned = agentKeyedTables().length + 1;
    const enumerated = AGENT_KEYED_TABLES.length;
    expect(readme).toContain(`The schema contains ${total} tables: ${agentOwned} carry per-agent or agent-owned runtime state`);
    expect(readme).toContain(`from ${enumerated} explicitly enumerated related tables`);
    expect(readme).toContain(`in ${enumerated} enumerated related tables`);
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
          const rows = await (ctx.db as unknown as {
            query: (t: string) => { collect: () => Promise<Array<{ agentId?: string }>> };
          })
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
      await expect(harness.action(internal.credentials.decrypt, { credentialId: id })).rejects.toThrow(
        'unavailable',
      );
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

import { convexTest, type TestConvex } from 'convex-test';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { AGENT_KEYED_TABLES, RETIRE_RECORD_TABLES } from '../../convex/reset';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { browserFieldId, providerItemKey } from '../../src/work/claim-key';
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
    const agentOwned = AGENT_KEYED_TABLES.length + 1;
    const enumerated = AGENT_KEYED_TABLES.length;
    expect(readme).toContain(
      `The schema contains ${total} tables: ${agentOwned} carry per-agent or agent-owned runtime state, one keeps the owner's record of the employees it retired`,
    );
    expect(RETIRE_RECORD_TABLES).toHaveLength(1);
    expect(readme).toContain('| `retirements` |');
    expect(readme).toContain(`from ${enumerated} explicitly enumerated related tables`);
    expect(readme).toContain(`in ${enumerated} enumerated related tables`);
    // SECURITY.md is where the README sends a reader for what a reset deletes (review m9).
    const security = readFileSync(new URL('../../SECURITY.md', import.meta.url), 'utf8');
    expect(security).toContain(`in the ${enumerated} enumerated related tables`);
    expect(readme).toContain('| `externalClaims` |');
    expect(readme).toContain('| `corrections` |');
  });

  it('clears every agent-keyed table the schema declares, keeps the retire record, and names them all', async (): Promise<void> => {
    const tables = agentKeyedTables().filter(
      (table) => !(RETIRE_RECORD_TABLES as readonly string[]).includes(table),
    );
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
    // list, or to the record a retire leaves; this assertion names the gap
    // before a demo finds it.
    expect([...AGENT_KEYED_TABLES].sort()).toEqual(tables);
    expect([...AGENT_KEYED_TABLES, ...RETIRE_RECORD_TABLES].sort()).toEqual(agentKeyedTables());
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

/** The work item fields a Linear ticket's row carries, keyed as intake keys it. */
function workItemFields(
  agentId: Id<'agents'>,
  externalId: string,
  title: string,
): {
  agentId: Id<'agents'>;
  sourceCategory: string;
  sourceSystem: string;
  externalId: string;
  externalClaimKey: string;
  title: string;
  contentSummary: string;
  contentRefs: string[];
  observedAt: number;
  createdAt: number;
} {
  return {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId,
    externalClaimKey: `linear:${externalId}`,
    title,
    contentSummary: title,
    contentRefs: [],
    observedAt: 1,
    createdAt: 1,
  };
}

/** Every retirement the harness holds, newest first. */
async function retirementsOf(harness: TestConvex<typeof schema>): Promise<Doc<'retirements'>[]> {
  return await harness.run(
    async (ctx) => await ctx.db.query('retirements').order('desc').collect(),
  );
}

describe('retire in real mode', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  afterEach((): void => {
    vi.useRealTimers();
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

  it('deletes the working rows and keeps the retirement under its owner, with one event naming it on the agent id', async (): Promise<void> => {
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
    const [retirement] = await retirementsOf(harness);
    expect(retirement).toMatchObject({
      userId: 'owner',
      agentId: retiring,
      agentName: 'retiring',
      retiredAt: expect.any(Number),
      rowCounts: { events: 2, surfaces: 2 },
      claims: [],
      rejections: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent.retired',
      payload: { retirementId: retirement._id, agentId: retiring, retiredAt: retirement.retiredAt },
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
    const [retirement] = await retirementsOf(harness);
    expect(retirement).toMatchObject({ revokedCredentials: 2, keptCredentials: 1 });
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
    expect((await retirementsOf(harness)).map((row) => row.agentId).sort()).toEqual(
      [retiring, sibling].sort(),
    );
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

    for (const retirement of await retirementsOf(harness)) {
      expect(retirement).toMatchObject({ keptCredentials: 0 });
    }
    expect(await harness.run(async (ctx) => await ctx.db.get(documentation))).toMatchObject({
      revokedAt: expect.any(Number),
    });
  });

  it('keeps a retired employee’s claim on an item it may have written, so a colleague neither takes the item nor writes it', async (): Promise<void> => {
    const { harness, retiring, sibling } = await seedRealOwner();
    const { held, asking, writer } = await harness.run(async (ctx) => {
      const held = await ctx.db.insert('workItems', {
        ...workItemFields(retiring, 'REVOPS-7', 'Close REVOPS-7'),
        state: 'completed',
      });
      await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-7',
        agentId: retiring,
        workItemId: held,
        claimedAt: 1,
      });
      const asking = await ctx.db.insert('workItems', {
        ...workItemFields(sibling, 'REVOPS-7', 'Close REVOPS-7'),
        state: 'discovered',
      });
      // The sibling works under autonomy, so its running write leaves a slot for the claim.
      await ctx.db.patch(sibling, { autonomousActions: true });
      const writer = await ctx.db.insert('workItems', {
        ...workItemFields(sibling, 'REVOPS-70', 'Report on REVOPS-7'),
        state: 'executing',
      });
      await ctx.db.insert('surfaces', {
        agentId: sibling,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        path: 'mcp',
        endpoint: 'https://mcp.linear.app/mcp',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        createdAt: 1,
      });
      return { held, asking, writer };
    });

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });

    const [retirement] = await retirementsOf(harness);
    expect(retirement.claims).toMatchObject([
      { key: 'linear:REVOPS-7', workItemId: held, title: 'Close REVOPS-7', state: 'completed' },
    ]);
    await harness.mutation(internal.work.setVerdict, {
      workItemId: asking,
      verdict: { decision: 'claim', value: 1, risk: 0, requiredPermissions: [] },
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(asking))).toMatchObject({
      state: 'skipped',
      skipReason: expect.stringContaining('retiring (retired) holds it (Close REVOPS-7)'),
    });
    expect(
      await harness.query(internal.work.writeClaimHolder, {
        workItemId: writer,
        surfaceSlug: 'linear',
        targets: ['REVOPS-7'],
      }),
    ).toMatchObject({
      target: 'REVOPS-7',
      holderName: 'retiring (retired)',
      sameEmployee: false,
      title: 'Close REVOPS-7',
      state: 'completed',
    });
  });

  it('releases a retired employee’s claim on work it had not begun to write, and wakes the colleague it refused (review M8)', async (): Promise<void> => {
    vi.useFakeTimers();
    const { harness, retiring, sibling } = await seedRealOwner();
    const refused = await harness.run(async (ctx) => {
      const holding = await ctx.db.insert('workItems', {
        ...workItemFields(retiring, 'REVOPS-8', 'Close REVOPS-8'),
        state: 'plan-pending',
      });
      const claimId = await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-8',
        agentId: retiring,
        workItemId: holding,
        claimedAt: 1,
      });
      return await ctx.db.insert('workItems', {
        ...workItemFields(sibling, 'REVOPS-8', 'Close REVOPS-8'),
        state: 'skipped',
        skipReason: 'claimed-by-colleague: retiring holds it (Close REVOPS-8)',
        verdict: {
          decision: 'skip',
          reason: 'claimed-by-colleague: retiring holds it (Close REVOPS-8)',
          claimedBy: { claimId },
        },
      });
    });

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await retirementsOf(harness))[0].claims).toEqual([]);
    expect(await harness.run(async (ctx) => await ctx.db.get(refused))).toMatchObject({
      state: 'discovered',
      reevaluation: { trigger: 'claim-released' },
    });
  });

  it('keeps a rejected ticket rejected after its employee retires, so a colleague’s plan for it waits for the manager (review M14)', async (): Promise<void> => {
    const { harness, retiring, sibling } = await seedRealOwner();
    const planned = await harness.run(async (ctx) => {
      await ctx.db.insert('workItems', {
        ...workItemFields(retiring, 'REVOPS-9', 'Close REVOPS-9'),
        state: 'cancelled',
        rejectedAt: 5,
      });
      await ctx.db.patch(sibling, { autonomousActions: true });
      return await ctx.db.insert('workItems', {
        ...workItemFields(sibling, 'REVOPS-9', 'Close REVOPS-9'),
        state: 'plan-pending',
        plan: { summary: 'Close it.', steps: ['Close REVOPS-9.'] },
      });
    });

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });

    expect((await retirementsOf(harness))[0].rejections).toMatchObject([
      { keys: ['linear:REVOPS-9'], rejectedAt: 5 },
    ]);
    await expect(
      harness.mutation(internal.work.decidePlan, { workItemId: planned }),
    ).resolves.toEqual({ approved: false });
    const held = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) => q.eq('agentId', sibling).eq('type', 'work.plan-held'))
          .collect()
      ).map((event) => event.payload),
    );
    expect(held).toMatchObject([
      { workItemId: planned, reason: 'plan-rejected-for-this-item', rejectedAt: 5 },
    ]);
  });

  it('keeps a retired employee’s claim on a page field it wrote, so a colleague’s older work neither claims the field nor writes it (review M14)', async (): Promise<void> => {
    const { harness, retiring, sibling } = await seedRealOwner();
    const tile = {
      displayName: 'Looker tile',
      class: 'dashboard',
      path: 'browser-driven',
      endpoint: 'http://looker-tile:8080/',
      verdict: 'connected' as const,
      whereFound: [],
      credentialLanded: true,
      createdAt: 1,
    };
    const key = providerItemKey(
      { ...tile, slug: 'looker-tile' },
      { sourceSystem: 'looker-tile', externalId: browserFieldId('Pipeline coverage') },
      'real',
    );
    if (key === undefined) throw new Error('a browser field has a key');
    const writer = await harness.run(async (ctx) => {
      const held = await ctx.db.insert('workItems', {
        ...workItemFields(retiring, 'REVOPS-20', 'Refresh the pipeline coverage'),
        state: 'completed',
      });
      await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key,
        agentId: retiring,
        workItemId: held,
        writeTarget: { surface: 'looker-tile', field: 'Pipeline coverage' },
        claimedAt: 1,
      });
      await ctx.db.insert('surfaces', { ...tile, agentId: sibling, slug: 'looker-tile' });
      return await ctx.db.insert('workItems', {
        ...workItemFields(sibling, 'REVOPS-21', 'Refresh the pipeline coverage too'),
        state: 'plan-approved',
      });
    });

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });

    expect((await retirementsOf(harness))[0].claims).toMatchObject([
      { key, writeTarget: { field: 'Pipeline coverage' }, settledAt: expect.any(Number) },
    ]);
    await expect(
      harness.mutation(internal.work.takeWriteTargetClaims, {
        workItemId: writer,
        targets: [{ surfaceSlug: 'looker-tile', field: 'Pipeline coverage' }],
      }),
    ).resolves.toEqual([]);
    expect(
      await harness.query(internal.work.writeClaimHolder, {
        workItemId: writer,
        surfaceSlug: 'looker-tile',
        targets: ['pipeline coverage'],
      }),
    ).toMatchObject({ holderName: 'retiring (retired)', state: 'completed' });
  });

  it('releases a failed holder’s claim when it landed nothing, so the colleague it refused wakes (review M8)', async (): Promise<void> => {
    vi.useFakeTimers();
    const { harness, retiring, sibling } = await seedRealOwner();
    const refused = await harness.run(async (ctx) => {
      const holding = await ctx.db.insert('workItems', {
        ...workItemFields(retiring, 'REVOPS-22', 'Close REVOPS-22'),
        state: 'failed',
        skipReason: 'stopped: the plan draft died 4 times without an answer',
      });
      const claimId = await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-22',
        agentId: retiring,
        workItemId: holding,
        claimedAt: 1,
      });
      return await ctx.db.insert('workItems', {
        ...workItemFields(sibling, 'REVOPS-22', 'Close REVOPS-22'),
        state: 'skipped',
        verdict: {
          decision: 'skip',
          reason: 'claimed-by-colleague: retiring holds it (Close REVOPS-22)',
          claimedBy: { claimId },
        },
      });
    });

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await retirementsOf(harness))[0].claims).toEqual([]);
    expect(await harness.run(async (ctx) => await ctx.db.get(refused))).toMatchObject({
      state: 'discovered',
    });
  });

  it('lets the claims and rejections go with the live ones when every employee retires', async (): Promise<void> => {
    const { harness, retiring } = await seedRealOwner();
    await harness.run(async (ctx) => {
      const held = await ctx.db.insert('workItems', {
        ...workItemFields(retiring, 'REVOPS-10', 'Close REVOPS-10'),
        state: 'completed',
        rejectedAt: 3,
      });
      await ctx.db.insert('externalClaims', {
        userId: 'owner',
        key: 'linear:REVOPS-10',
        agentId: retiring,
        workItemId: held,
        claimedAt: 1,
      });
    });
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });
    expect((await retirementsOf(harness))[0].claims).toHaveLength(1);

    await harness.withIdentity({ subject: 'owner' }).mutation(api.reset.deleteMyData, {});

    const retirements = await retirementsOf(harness);
    expect(retirements).toHaveLength(2);
    for (const retirement of retirements) {
      expect(retirement).toMatchObject({ claims: [], rejections: [] });
    }
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
    ).rejects.toThrow('forbidden');
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

describe('the jobs a reset leaves scheduled (step 47, P4-7)', (): void => {
  it("cancels the retired employee's pending jobs and keeps a colleague's", async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { retiring, colleague, item } = await harness.run(async (ctx) => {
      const insertAgent = async (name: string): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name,
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
      const retiring = await insertAgent('Priya');
      const colleague = await insertAgent('Mateo');
      const item = await insertMinimalRow(ctx, 'workItems', retiring);
      await ctx.scheduler.runAfter(60_000, internal.workActions.evaluateWorkItemInternal, {
        workItemId: item as Id<'workItems'>,
      });
      await ctx.scheduler.runAfter(60_000, internal.work.reevaluatePending, {
        agentId: retiring,
        trigger: 'claim-released',
        key: 'claim-1',
      });
      await ctx.scheduler.runAfter(60_000, internal.work.reevaluatePending, {
        agentId: colleague,
        trigger: 'claim-released',
        key: 'claim-1',
      });
      return { retiring, colleague, item };
    });

    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.reset.deleteMyData, { agentId: retiring });

    const jobs = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    const stateOf = (predicate: (args: Record<string, unknown>) => boolean): string[] =>
      jobs
        .filter((job) => predicate(job.args[0] as Record<string, unknown>))
        .map((job) => job.state.kind);
    expect(stateOf((args) => args.workItemId === item)).toEqual(['canceled']);
    expect(stateOf((args) => args.agentId === retiring)).toEqual(['canceled']);
    expect(stateOf((args) => args.agentId === colleague)).toEqual(['pending']);
    vi.useRealTimers();
  });
});

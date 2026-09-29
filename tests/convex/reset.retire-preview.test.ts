import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schemaModule from '../../convex/schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * `retirePreview` in `convex/reset.ts`: what the retire dialog says before the manager confirms
 * (decisions Q15 and N1). Split from `reset.test.ts`, which holds the retire itself, to keep
 * each file under a thousand lines. Every case compares the preview with what the retire then
 * does, so the dialog never promises something the retire does not keep.
 */

type Schema = typeof schemaModule;

/** The harness and the rows the cases read. */
interface Seeded {
  readonly harness: TestConvex<Schema>;
  readonly retiring: Id<'agents'>;
  readonly sibling: Id<'agents'>;
}

/**
 * One owner with two employees under the mode the case chose: the retiring one connects Linear
 * with a credential only it binds and Slack with one its sibling binds too, holds a charter, a
 * completed item it claimed and three events.
 */
async function seed(): Promise<Seeded> {
  const [{ default: schema }, { allConvexModules }] = await Promise.all([
    import('../../convex/schema'),
    import('./all-modules'),
  ]);
  const harness = convexTest(schema, allConvexModules());
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
    const employee = async (name: string): Promise<Id<'agents'>> =>
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name,
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
    const retiring = await employee('Mira');
    const sibling = await employee('Aman');
    const surface = {
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
      displayName: 'Linear',
      credentialId: only,
    });
    for (const agentId of [retiring, sibling]) {
      await ctx.db.insert('surfaces', {
        ...surface,
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        credentialId: shared,
      });
    }
    await ctx.db.insert('charters', {
      agentId: retiring,
      version: '0.1',
      body: {},
      approved: true,
      createdAt: 1,
    });
    const item = await ctx.db.insert('workItems', {
      agentId: retiring,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-7',
      externalClaimKey: 'linear:REVOPS-7',
      title: 'Close REVOPS-7',
      contentSummary: 'Close it.',
      contentRefs: [],
      state: 'completed',
      observedAt: 1,
      createdAt: 1,
    });
    await ctx.db.insert('externalClaims', {
      userId: 'owner',
      key: 'linear:REVOPS-7',
      agentId: retiring,
      workItemId: item,
      claimedAt: 1,
    });
    for (const type of ['work.discovered', 'work.evaluated', 'work.completed']) {
      await ctx.db.insert('events', { agentId: retiring, type, payload: {}, createdAt: 1 });
    }
    return { retiring, sibling };
  });
  return { harness, ...seeded };
}

/** The owner's retirement rows. */
async function retirements(harness: TestConvex<Schema>): Promise<Doc<'retirements'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('retirements').collect());
}

describe('retirePreview in real mode', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('says what the retire deletes, revokes and keeps, and the retire then does exactly that', async (): Promise<void> => {
    const { harness, retiring } = await seed();
    const owner = harness.withIdentity({ subject: 'owner' });

    const preview = await owner.query(api.reset.retirePreview, { agentId: retiring });

    expect(preview).toEqual({
      mode: 'real',
      rowCounts: { charters: 1, workItems: 1, externalClaims: 1, events: 3, surfaces: 2 },
      atLeast: false,
      revoked: [{ slug: 'linear', displayName: 'Linear' }],
      kept: [{ slug: 'slack', displayName: 'Slack' }],
      keptClaims: 1,
      tombstone: true,
    });

    await expect(owner.mutation(api.reset.retire, { agentId: retiring })).resolves.toEqual({
      agentName: 'Mira',
    });
    const [retirement] = await retirements(harness);
    expect(retirement).toMatchObject({
      rowCounts: preview?.rowCounts,
      revokedCredentials: 1,
      keptCredentials: 1,
    });
    expect(retirement?.claims).toHaveLength(preview?.keptClaims ?? -1);
  });

  it('answers null once the employee is gone, so the open dialog reads nothing after the retire', async (): Promise<void> => {
    const { harness, retiring } = await seed();
    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.reset.retire, { agentId: retiring });

    await expect(owner.query(api.reset.retirePreview, { agentId: retiring })).resolves.toBeNull();
  });

  it("refuses another owner's employee", async (): Promise<void> => {
    const { harness, retiring } = await seed();

    await expect(
      harness
        .withIdentity({ subject: 'stranger' })
        .query(api.reset.retirePreview, { agentId: retiring }),
    ).rejects.toThrow('forbidden');
  });

  it('revokes a shared credential once no other employee binds it', async (): Promise<void> => {
    const { harness, retiring, sibling } = await seed();
    const owner = harness.withIdentity({ subject: 'owner' });
    // The sibling's Slack goes, so nothing but the retiring employee binds the shared token.
    await harness.run(async (ctx) => {
      const rows = await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', sibling))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    });

    const preview = await owner.query(api.reset.retirePreview, { agentId: retiring });

    expect(preview?.revoked.map((surface) => surface.slug).sort()).toEqual(['linear', 'slack']);
    expect(preview?.kept).toEqual([]);
    await owner.mutation(api.reset.retire, { agentId: retiring });
    expect((await retirements(harness))[0]).toMatchObject({
      revokedCredentials: 2,
      keptCredentials: 0,
    });
  });
});

describe('retirePreview in the hosted office', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('counts the rows the wipe deletes and promises no revoke, no kept claim and no tombstone', async (): Promise<void> => {
    const { harness, retiring } = await seed();
    const owner = harness.withIdentity({ subject: 'owner' });

    const preview = await owner.query(api.reset.retirePreview, { agentId: retiring });

    expect(preview).toMatchObject({
      mode: 'mock',
      rowCounts: { charters: 1, workItems: 1, externalClaims: 1, events: 3, surfaces: 2 },
      revoked: [],
      kept: [],
      keptClaims: 0,
      tombstone: false,
    });
    await owner.mutation(api.reset.retire, { agentId: retiring });
    expect(await retirements(harness)).toEqual([]);
    expect(await harness.run(async (ctx) => await ctx.db.get(retiring))).toBeNull();
  });
});

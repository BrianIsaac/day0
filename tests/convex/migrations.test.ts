/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { MIGRATION_NAMES, MIGRATIONS } from '../../convex/migrations';
import { RETIRED_DECLARATIONS, RETIRING_DECLARATIONS } from '../../scripts/releases';
import { avatarById } from '../../src/agent/avatar-pets';
import { mirroredDocSlug } from '../../src/docs/types';
import {
  CREDENTIAL_KEY_CHANGED_MESSAGE,
  credentialKeyId,
  credentialOwnerBinding,
  credentialValueFingerprint,
  encrypt,
  sealForOwner,
} from '../../src/lib/credential-crypto';
import { credentialSourceRef } from '../../src/docs/redaction';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

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

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the upgrade migrations', (): void => {
  it('clears a revokedAt the sync stamped when it superseded a credential, and keeps a person’s earlier revoke', async (): Promise<void> => {
    // Stored values mean a deployment key; the re-seal logs these unreadable
    // placeholders and leaves them as they are.
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
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

  it('reports only the migrations a call ran, not those an earlier call finished', async (): Promise<void> => {
    const harness = limitedHarness();
    const first = await harness.action(internal.migrations.runPending, {});
    expect(first.migrations.map((row) => row.name)).toEqual([...MIGRATION_NAMES]);
    await expect(harness.action(internal.migrations.runPending, {})).resolves.toEqual({
      migrations: [],
      pending: [],
    });
  });

  it('runs the second schema step’s migrations on the runner, each at 0.6.0, and records each finished', async (): Promise<void> => {
    const secondStep = [
      'surfaces-withheld-tools',
      'work-evaluation-unavailable-cause',
      'sync-runs-unread',
      'doc-page-listings',
      'credentials-superseded-at',
    ];
    expect(MIGRATION_NAMES.slice(-secondStep.length)).toEqual(secondStep);
    const harness = limitedHarness();
    await runAll(harness);
    const status = await harness.query(internal.migrations.status, {});
    expect(
      status.migrations
        .filter((row) => secondStep.includes(row.name))
        .map((row) => [row.name, row.release, row.completedAt !== undefined]),
    ).toEqual(secondStep.map((name) => [name, '0.6.0', true]));
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

describe('the approved tool list backfill (U10 D2 (b))', (): void => {
  it('copies the stored tool list of every card that has one into its approved list, and leaves one the manager approved', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const [connected, expired, approvedByManager, bare] = await harness.run(async (ctx) => {
      const card = async (
        slug: string,
        fields: Partial<Doc<'surfaces'>>,
      ): Promise<Id<'surfaces'>> =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug,
          displayName: slug,
          class: 'kanban',
          verdict: 'connected',
          whereFound: [],
          credentialLanded: true,
          createdAt: 1,
          ...fields,
        });
      return await Promise.all([
        card('linear', { toolAllowlist: ['list_issues', 'save_comment'], lastVerifiedAt: 5 }),
        card('jira', { verdict: 'approved', reason: 'expired', toolAllowlist: ['search'] }),
        card('asana', {
          toolAllowlist: ['list_tasks'],
          approvedToolAllowlist: ['list_tasks', 'create_task'],
          toolAllowlistApprovedAt: 9,
        }),
        card('notion', { verdict: 'proposed', credentialLanded: false }),
      ]);
    });

    await runAll(harness);

    const rows = await harness.run(
      async (ctx) =>
        await Promise.all(
          [connected, expired, approvedByManager, bare].map((id) => ctx.db.get(id)),
        ),
    );
    expect(rows.map((row) => [row?.approvedToolAllowlist, row?.toolAllowlistApprovedAt])).toEqual([
      [['list_issues', 'save_comment'], 5],
      [['search'], 1],
      [['list_tasks', 'create_task'], 9],
      [undefined, undefined],
    ]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'surfaces-approved-tools')).toMatchObject({
      release: '0.6.0',
      read: 4,
      changed: 2,
      completedAt: expect.any(Number),
    });
  });
});

describe('the access setter backfill (Q5, U3 D3 (b))', (): void => {
  it('records who set each end date from its newest access-set event, and the upgrade where none says', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const [byManager, byUpgrade, unrecorded, noClock] = await harness.run(async (ctx) => {
      const card = async (
        slug: string,
        verdict: Doc<'surfaces'>['verdict'],
        expiresAt?: number,
      ): Promise<Id<'surfaces'>> =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug,
          displayName: slug,
          class: 'kanban',
          verdict,
          whereFound: [],
          credentialLanded: verdict === 'connected',
          createdAt: 1,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
      // The proposal-started clock of the code before 0.4.0 is on a proposed
      // card with no event; the access-clock migration leaves it alone.
      const ids = await Promise.all([
        card('linear', 'connected', 100),
        card('jira', 'connected', 200),
        card('asana', 'proposed', 300),
        card('notion', 'declared'),
      ]);
      const set = async (surfaceId: Id<'surfaces'>, by: string, at: number): Promise<void> => {
        await ctx.db.insert('events', {
          agentId,
          type: 'surface.access-set',
          payload: { surfaceId, by, days: 90, expiresAt: at },
          createdAt: at,
        });
      };
      await set(ids[0], 'approval', 10);
      await set(ids[0], 'manager', 20);
      await set(ids[1], 'upgrade', 30);
      return ids;
    });

    await runAll(harness);

    const setters = await harness.run(
      async (ctx) =>
        await Promise.all(
          [byManager, byUpgrade, unrecorded, noClock].map(
            async (id) => (await ctx.db.get(id))?.accessSetBy ?? null,
          ),
        ),
    );
    expect(setters).toEqual(['manager', 'upgrade', 'upgrade', null]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'surfaces-access-set-by')).toMatchObject({
      release: '0.6.0',
      read: 4,
      changed: 3,
      completedAt: expect.any(Number),
    });
  });
});

describe('the withheld tools backfill (K D2 (b))', (): void => {
  it('copies the tools each connected card’s newest connection withheld onto the row, less any the manager approved since', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const [narrowed, approvedSince, withholdsNothing, notConnected] = await harness.run(
      async (ctx) => {
        const card = async (
          slug: string,
          verdict: Doc<'surfaces'>['verdict'],
          approved: string[],
        ): Promise<Id<'surfaces'>> =>
          await ctx.db.insert('surfaces', {
            agentId,
            slug,
            displayName: slug,
            class: 'kanban',
            verdict,
            whereFound: [],
            credentialLanded: verdict === 'connected',
            approvedToolAllowlist: approved,
            toolAllowlist: approved,
            createdAt: 1,
          });
        const ids = await Promise.all([
          card('linear', 'connected', ['list_issues']),
          card('jira', 'connected', ['list_issues', 'delete_issue']),
          card('asana', 'connected', ['list_tasks']),
          card('notion', 'listed-dead', ['search']),
        ]);
        const connected = async (
          surfaceId: Id<'surfaces'>,
          at: number,
          withheldTools?: string[],
        ): Promise<void> => {
          await ctx.db.insert('events', {
            agentId,
            type: 'surface.connected',
            payload: { surfaceId, ...(withheldTools ? { withheldTools } : {}) },
            createdAt: at,
          });
        };
        await connected(ids[0], 10, ['old_tool']);
        await connected(ids[0], 20, ['save_comment', 'delete_issue']);
        await connected(ids[1], 30, ['delete_issue', 'archive_issue']);
        await connected(ids[2], 40);
        await connected(ids[3], 50, ['create_page']);
        return ids;
      },
    );

    await runAll(harness);

    const withheld = await harness.run(
      async (ctx) =>
        await Promise.all(
          [narrowed, approvedSince, withholdsNothing, notConnected].map(
            async (id) => (await ctx.db.get(id))?.withheldTools ?? null,
          ),
        ),
    );
    expect(withheld).toEqual([['save_comment', 'delete_issue'], ['archive_issue'], null, null]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'surfaces-withheld-tools')).toMatchObject({
      release: '0.6.0',
      read: 4,
      changed: 2,
      completedAt: expect.any(Number),
    });
  });
});

describe('the unavailable cause backfill (K D2 (b))', (): void => {
  it('copies onto each row stamped unavailable the cause its newest unavailable event gave, and leaves every other row', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const [stamped, noEvent, unstamped] = await harness.run(async (ctx) => {
      const row = async (externalId: string, unavailableAt?: number): Promise<Id<'workItems'>> =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId,
          title: externalId,
          contentSummary: externalId,
          contentRefs: [],
          state: 'discovered',
          observedAt: 1,
          createdAt: 1,
          ...(unavailableAt !== undefined ? { evaluationUnavailableAt: unavailableAt } : {}),
        });
      const ids = await Promise.all([row('REVOPS-1', 30), row('REVOPS-2', 40), row('REVOPS-3')]);
      const unavailable = async (
        workItemId: Id<'workItems'>,
        cause: string,
        at: number,
      ): Promise<void> => {
        await ctx.db.insert('events', {
          agentId,
          type: 'work.scope-judgement-unavailable',
          payload: { workItemId, cause },
          createdAt: at,
        });
      };
      await unavailable(ids[0], 'timeout after 60 s', 10);
      await unavailable(ids[0], 'provider answered 503', 30);
      await unavailable(ids[2], 'provider answered 503', 50);
      return ids;
    });

    await runAll(harness);

    const causes = await harness.run(
      async (ctx) =>
        await Promise.all(
          [stamped, noEvent, unstamped].map(
            async (id) => (await ctx.db.get(id))?.evaluationUnavailableCause ?? null,
          ),
        ),
    );
    expect(causes).toEqual(['provider answered 503', null, null]);
    const status = await harness.query(internal.migrations.status, {});
    expect(
      status.migrations.find((row) => row.name === 'work-evaluation-unavailable-cause'),
    ).toMatchObject({ release: '0.6.0', read: 3, changed: 1, completedAt: expect.any(Number) });
  });
});

describe('the unread record move (D D1 (a))', (): void => {
  it('moves the record each run kept below its reason onto its field, leaving the line it ended short on', async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const record = [
      '3 pages could not be read this sync and keep their last stored version',
      '- https://wiki.example/a: HTTP 404',
      '- b.md: truncated',
      '- and 1 more',
    ].join('\n');
    const [failed, completed, clean, moved] = await harness.run(async (ctx) => {
      const run = async (
        state: Doc<'docSyncRuns'>['state'],
        fields: Partial<Doc<'docSyncRuns'>>,
      ): Promise<Id<'docSyncRuns'>> =>
        await ctx.db.insert('docSyncRuns', {
          sourceId,
          refs: [],
          credentialRefs: [],
          pageCount: 0,
          redactionCount: 0,
          state,
          createdAt: 1,
          ...fields,
        });
      return await Promise.all([
        run('error', { reason: `The documentation read was interrupted (timeout).\n${record}` }),
        run('completed', { reason: record }),
        run('superseded', {
          reason: 'a newer sync of the source started before this one finished',
        }),
        run('completed', { unread: { count: 1, pages: [{ ref: 'c.md', reason: 'gone' }] } }),
      ]);
    });

    await runAll(harness);

    const runs = await harness.run(
      async (ctx) =>
        await Promise.all(
          [failed, completed, clean, moved].map(async (id) => await ctx.db.get(id)),
        ),
    );
    const listed = {
      count: 3,
      pages: [
        { ref: 'https://wiki.example/a', reason: 'HTTP 404' },
        { ref: 'b.md', reason: 'truncated' },
      ],
    };
    expect(runs.map((run) => [run?.reason ?? null, run?.unread ?? null])).toEqual([
      ['The documentation read was interrupted (timeout).', listed],
      [null, listed],
      ['a newer sync of the source started before this one finished', null],
      [null, { count: 1, pages: [{ ref: 'c.md', reason: 'gone' }] }],
    ]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'sync-runs-unread')).toMatchObject({
      release: '0.6.0',
      read: 4,
      changed: 2,
      completedAt: expect.any(Number),
    });
  });
});

describe('the page listing stamp (D D2 (a))', (): void => {
  it('gives every stored page a listing row stamped 0, and leaves a page a sync already stamped', async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    await harness.run(async (ctx): Promise<void> => {
      for (const ref of ['a.md', 'b.md', 'c.md']) {
        await ctx.db.insert('docPages', {
          sourceId,
          ref,
          title: ref,
          markdown: `# ${ref}`,
          updatedAt: 1,
        });
      }
      await ctx.db.insert('docPageListings', { sourceId, ref: 'c.md', seenBy: 4 });
    });

    await runAll(harness);

    const listings = await harness.run(async (ctx) =>
      (await ctx.db.query('docPageListings').collect()).map((row) => [row.ref, row.seenBy]).sort(),
    );
    expect(listings).toEqual([
      ['a.md', 0],
      ['b.md', 0],
      ['c.md', 4],
    ]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'doc-page-listings')).toMatchObject({
      release: '0.6.0',
      read: 3,
      changed: 2,
      completedAt: expect.any(Number),
    });
  });
});

describe('the superseded-at stamp (C2 D2 (a))', (): void => {
  it('stamps each row a sync superseded with the upgrade, and leaves a live, a suspect and a stamped row', async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const ids = await harness.run(async (ctx) => {
      const row = async (
        ref: string,
        fields: Partial<Doc<'credentials'>>,
      ): Promise<Id<'credentials'>> =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: ref,
          source: { sourceId, ref },
          createdAt: 1,
          ...fields,
        });
      return await Promise.all([
        row('a.md', { status: 'superseded' }),
        row('b.md', { status: 'superseded', supersededAt: 7 }),
        row('c.md', { status: 'suspect' }),
        row('d.md', {}),
      ]);
    });
    const before = Date.now();

    await runAll(harness);

    const stamps = await harness.run(
      async (ctx) =>
        await Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.supersededAt ?? null)),
    );
    expect(stamps[0]).toBeGreaterThanOrEqual(before);
    expect(stamps.slice(1)).toEqual([7, null, null]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'credentials-superseded-at')).toMatchObject(
      { release: '0.6.0', read: 4, changed: 1, completedAt: expect.any(Number) },
    );
  });
});

describe('the single approval (Q10)', (): void => {
  const UPGRADED_AT = Date.UTC(2026, 8, 28, 9);
  const DAY = 24 * 60 * 60 * 1_000;

  afterEach((): void => {
    vi.useRealTimers();
  });

  it('approves a card the manager alone approved, clears every IT stamp, and leaves a refused card proposed saying why', async (): Promise<void> => {
    // The approval schedules a probe; the fake clock holds it so none runs.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(UPGRADED_AT);
    vi.stubEnv('DAY0_BROWSER_MCP_URL', '');
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const ids = await harness.run(async (ctx) => {
      const card = async (
        slug: string,
        fields: Partial<Doc<'surfaces'>>,
      ): Promise<Id<'surfaces'>> =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug,
          displayName: slug,
          class: 'kanban',
          verdict: 'proposed',
          path: 'mcp',
          whereFound: [],
          credentialLanded: false,
          createdAt: 1,
          ...fields,
        });
      const connected = await card('asana', {
        verdict: 'connected',
        managerApprovedAt: 10,
        itApprovedAt: 11,
        expiresAt: UPGRADED_AT + DAY,
        accessSetBy: 'approval',
      });
      // A clock an earlier release started carries its event; the access-clock
      // migration leaves it alone.
      await ctx.db.insert('events', {
        agentId,
        type: 'surface.access-set',
        payload: { surfaceId: connected, by: 'approval', days: 90, expiresAt: UPGRADED_AT + DAY },
        createdAt: 11,
      });
      return {
        managerOnly: await card('linear', { managerApprovedAt: 50 }),
        itOnly: await card('jira', { itApprovedAt: 60 }),
        connected,
        refused: await card('looker', { path: 'browser-driven', managerApprovedAt: 70 }),
        untouched: await card('notion', {}),
      };
    });

    await runAll(harness);

    const rows = await harness.run(async (ctx) => ({
      managerOnly: await ctx.db.get(ids.managerOnly),
      itOnly: await ctx.db.get(ids.itOnly),
      connected: await ctx.db.get(ids.connected),
      refused: await ctx.db.get(ids.refused),
      untouched: await ctx.db.get(ids.untouched),
      events: await ctx.db.query('events').collect(),
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }));
    expect(rows.managerOnly).toMatchObject({
      verdict: 'approved',
      managerApprovedAt: 50,
      expiresAt: UPGRADED_AT + 90 * DAY,
      accessSetBy: 'upgrade',
    });
    expect(rows.itOnly).toMatchObject({ verdict: 'proposed' });
    expect(rows.itOnly?.managerApprovedAt).toBeUndefined();
    expect(rows.connected).toMatchObject({
      verdict: 'connected',
      managerApprovedAt: 10,
      expiresAt: UPGRADED_AT + DAY,
      accessSetBy: 'approval',
    });
    expect(rows.refused).toMatchObject({
      verdict: 'proposed',
      reason: expect.stringContaining('BROWSER_DRIVER_ABSENT'),
    });
    expect(rows.refused?.managerApprovedAt).toBeUndefined();
    expect(rows.untouched).toMatchObject({ verdict: 'proposed' });
    expect(rows.untouched?.reason).toBeUndefined();
    for (const row of [rows.managerOnly, rows.itOnly, rows.connected, rows.refused]) {
      expect(row).not.toHaveProperty('itApprovedAt');
    }
    expect(
      rows.events
        .filter((event) => event.createdAt === UPGRADED_AT)
        .map((event) => ({ type: event.type, payload: event.payload })),
    ).toEqual([
      {
        type: 'surface.access-set',
        payload: {
          surfaceId: ids.managerOnly,
          by: 'upgrade',
          days: 90,
          expiresAt: UPGRADED_AT + 90 * DAY,
        },
      },
      { type: 'surface.approved', payload: { surfaceId: ids.managerOnly } },
    ]);
    expect(rows.scheduled).toMatchObject([
      { name: 'surfaceActions:probeInternal', args: [{ surfaceId: ids.managerOnly }] },
    ]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'surfaces-single-approval')).toMatchObject({
      release: '0.6.0',
      read: 5,
      changed: 4,
      completedAt: expect.any(Number),
    });
  });

  it('changes nothing when it runs again', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(UPGRADED_AT);
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const surfaceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'proposed',
          path: 'mcp',
          whereFound: [],
          credentialLanded: false,
          managerApprovedAt: 50,
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.migrations.runMigrationPage, {
      name: 'surfaces-single-approval',
    });
    const approved = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('migrations')
        .withIndex('by_name', (q) => q.eq('name', 'surfaces-single-approval'))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });
    vi.setSystemTime(UPGRADED_AT + DAY);
    await harness.mutation(internal.migrations.runMigrationPage, {
      name: 'surfaces-single-approval',
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(surfaceId))).toEqual(approved);
    const approvals = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter((event) => event.type === 'surface.approved'),
    );
    expect(approvals).toHaveLength(1);
  });
});

describe('the declarations the schema step retired (N10)', (): void => {
  it('runs no migration of a retired declaration and declares none of them any more', (): void => {
    for (const { declaration, migration } of RETIRED_DECLARATIONS) {
      expect(MIGRATION_NAMES as readonly string[]).not.toContain(migration);
      const [table, field] = declaration.split('.') as [keyof typeof schema.tables, string];
      const fields = (
        schema.tables[table].validator as unknown as { fields: Record<string, unknown> }
      ).fields;
      expect(fields, declaration).not.toHaveProperty(field);
    }
  });
});

describe('the declarations the next release retires (N10, Q D2)', (): void => {
  /** Whether the schema still declares a `table.field`. */
  const declared = (declaration: string): boolean => {
    const [table, field] = declaration.split('.') as [keyof typeof schema.tables, string];
    const fields = (
      schema.tables[table].validator as unknown as { fields: Record<string, unknown> }
    ).fields;
    return field in fields;
  };

  it('ships the clearing migration of each, at its release, naming it in thenRemoves, and still declares it', (): void => {
    for (const { declaration, migration, release } of RETIRING_DECLARATIONS) {
      expect(MIGRATION_NAMES as readonly string[]).toContain(migration);
      const described = MIGRATIONS[migration as (typeof MIGRATION_NAMES)[number]];
      expect(described.release).toBe(release);
      expect(described.thenRemoves).toContain(`the ${declaration} declaration`);
      expect(declared(declaration), declaration).toBe(true);
    }
  });

  it('lists every declaration a shipped migration says the next release removes', (): void => {
    const named = MIGRATION_NAMES.flatMap((name) => {
      const match = /the (\w+\.\w+) declaration/.exec(MIGRATIONS[name].thenRemoves);
      return match ? [match[1]] : [];
    });
    expect(RETIRING_DECLARATIONS.map((row) => row.declaration).sort()).toEqual(named.sort());
  });
});

describe('the avatar id rewrite (U15 D1 (a), N6)', (): void => {
  it('gives an agent stored under a handle-keyed avatar id the face the dashboard shows for it, and leaves a listed one', async (): Promise<void> => {
    const harness = limitedHarness();
    const [handle, listed, none] = await Promise.all(
      [{ avatarId: 'tw-someone' }, { avatarId: 'face-07' }, {}].map(
        async (fields) =>
          await harness.run(
            async (ctx) =>
              await ctx.db.insert('agents', {
                bossEmail: 'boss@day0.local',
                name: 'Priya',
                state: 'active',
                createdAt: 1,
                ...fields,
              }),
          ),
      ),
    );

    await runAll(harness);

    const ids = await harness.run(
      async (ctx) =>
        await Promise.all(
          [handle, listed, none].map(async (id) => (await ctx.db.get(id))?.avatarId ?? null),
        ),
    );
    expect(ids).toEqual([avatarById('tw-someone').id, 'face-07', null]);
    expect(ids[0]).toMatch(/^face-\d{2}$/);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'agents-avatar-digest')).toMatchObject({
      release: '0.6.0',
      read: 3,
      changed: 1,
      completedAt: expect.any(Number),
    });
  });
});

describe('the mirror re-key (review M20)', (): void => {
  it('deletes a mirror an earlier slug rule keyed where a sync wrote the page again, and moves one no sync has reached', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const sourceId = await source(harness, 'owner');
    const legacySlug = (ref: string): string =>
      `source-${String(sourceId).slice(-10).toLowerCase()}-${ref === 'Café.md' ? 'caf-md' : 'md'}`;
    await harness.run(async (ctx) => {
      const mirror = async (slug: string, sourceRef: string): Promise<void> => {
        await ctx.db.insert('mockDocs', {
          agentId,
          slug,
          title: sourceRef,
          body: `# ${sourceRef}`,
          category: 'team-doc',
          sourceId,
          sourceRef,
          updatedAt: 1,
        });
      };
      await mirror(legacySlug('Café.md'), 'Café.md');
      await mirror(mirroredDocSlug(sourceId, 'Café.md'), 'Café.md');
      await mirror(legacySlug('运营手册.md'), '运营手册.md');
      await mirror(mirroredDocSlug(sourceId, 'handbook.md'), 'handbook.md');
    });

    await runAll(harness);

    const slugs = await harness.run(async (ctx) =>
      (await ctx.db.query('mockDocs').collect()).map((row) => row.slug).sort(),
    );
    expect(slugs).toEqual(
      [
        mirroredDocSlug(sourceId, 'Café.md'),
        mirroredDocSlug(sourceId, '运营手册.md'),
        mirroredDocSlug(sourceId, 'handbook.md'),
      ].sort(),
    );
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'mirrors-rekey')).toMatchObject({
      release: '0.6.0',
      read: 4,
      changed: 2,
      completedAt: expect.any(Number),
    });
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

/** One stored credential row, sealed as the release named in `shape` would have sealed it. */
async function sealedRow(
  harness: Harness,
  row: {
    userId: string;
    plaintext: string;
    key: string;
    shape: 'unbound' | 'bound' | 'keyed' | 'purged';
  },
): Promise<Id<'credentials'>> {
  const sealed =
    row.shape === 'unbound'
      ? encrypt(row.plaintext, row.key)
      : row.shape === 'bound'
        ? encrypt(row.plaintext, row.key, credentialOwnerBinding(row.userId))
        : row.shape === 'keyed'
          ? sealForOwner(row.plaintext, { current: row.key }, row.userId)
          : {};
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('credentials', {
        userId: row.userId,
        kind: 'value',
        label: `${row.shape} value`,
        source: 'entered',
        createdAt: 1,
        ...sealed,
        ...(row.shape === 'purged' ? { revokedAt: 2 } : {}),
      }),
  );
}

/** The re-seal migration's row in `migrations:status`. */
async function resealStatus(harness: Harness): Promise<Record<string, unknown> | undefined> {
  return (await harness.query(internal.migrations.status, {})).migrations.find(
    (row) => row.name === 'credentials-reseal',
  ) as Record<string, unknown> | undefined;
}

/** Run one page of the re-seal the way `runPending` does: start, page, record. */
async function resealOnePage(harness: Harness): Promise<void> {
  const start = await harness.query(internal.migrations.migrationStart, {
    name: 'credentials-reseal',
  });
  const page = await harness.action(internal.credentialCryptoActions.resealPage, {
    cursor: start.cursor,
  });
  await harness.mutation(internal.migrations.recordActionPage, {
    name: 'credentials-reseal',
    fromCursor: start.cursor,
    page: { read: page.read, changed: page.changed, cursor: page.cursor, isDone: page.isDone },
  });
}

describe('the credential re-seal (Q15, step 14)', (): void => {
  const KEY = randomBytes(32).toString('base64');
  const LOST_KEY = randomBytes(32).toString('base64');

  /**
   * A bed-shaped table: three owners' rows in every shape an upgraded volume
   * holds, 120 in all, so the re-seal takes three pages.
   */
  async function bed(harness: Harness): Promise<{
    unbound: Id<'credentials'>[];
    bound: Id<'credentials'>[];
    keyed: Id<'credentials'>[];
    purged: Id<'credentials'>[];
    unreadable: Id<'credentials'>[];
  }> {
    // Rows needing no change first, so the unbound ones sit in the last page.
    const shapes = { keyed: 30, purged: 5, unreadable: 5, bound: 40, unbound: 40 } as const;
    const made = { unbound: [], bound: [], keyed: [], purged: [], unreadable: [] } as Record<
      keyof typeof shapes,
      Id<'credentials'>[]
    >;
    for (const [shape, count] of Object.entries(shapes) as Array<[keyof typeof shapes, number]>) {
      for (let index = 0; index < count; index += 1) {
        made[shape].push(
          await sealedRow(harness, {
            userId: `owner-${index % 3}`,
            plaintext: `${shape}-value-${index}`,
            key: shape === 'unreadable' ? LOST_KEY : KEY,
            shape: shape === 'unreadable' ? 'bound' : shape,
          }),
        );
      }
    }
    return made;
  }

  it('runs in pages on the runner, says how many rows remain, and binds every value it can open to its owner under the current key', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const harness = limitedHarness();
    const rows = await bed(harness);

    expect(await resealStatus(harness)).toMatchObject({ release: '0.6.0', remaining: 85 });
    await resealOnePage(harness);
    const partway = await resealStatus(harness);
    expect(partway).toMatchObject({ read: 50 });
    expect(partway?.completedAt).toBeUndefined();
    expect(partway?.remaining).toBeLessThan(85);
    expect(partway?.remaining).toBeGreaterThan(5);

    await runAll(harness);

    expect(await resealStatus(harness)).toMatchObject({
      read: 120,
      changed: 80,
      remaining: 5,
    });
    const keyId = credentialKeyId(KEY);
    for (const id of [...rows.unbound, ...rows.bound, ...rows.keyed]) {
      const row = await harness.run(async (ctx) => await ctx.db.get(id));
      expect(row?.keyId).toBe(keyId);
      await expect(
        harness.action(internal.credentials.decrypt, { credentialId: id }),
      ).resolves.toMatch(/-value-/);
    }
    for (const id of rows.purged) {
      expect((await harness.run(async (ctx) => await ctx.db.get(id)))?.keyId).toBeUndefined();
    }
  });

  it('keeps opening a row sealed before binding while the re-seal is part-way, and refuses an unbound value once it has finished', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const harness = limitedHarness();
    const rows = await bed(harness);
    const last = rows.unbound[rows.unbound.length - 1];

    await resealOnePage(harness);
    // The page has not reached this row, and the checks are not on yet.
    expect((await harness.run(async (ctx) => await ctx.db.get(last)))?.keyId).toBeUndefined();
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: last }),
    ).resolves.toBe(`unbound-value-${rows.unbound.length - 1}`);

    await runAll(harness);
    // An unbound value put on a row after the re-seal finished opens nowhere.
    const planted = await sealedRow(harness, {
      userId: 'owner-0',
      plaintext: 'planted-value',
      key: KEY,
      shape: 'unbound',
    });
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: planted }),
    ).rejects.toThrow(CREDENTIAL_KEY_CHANGED_MESSAGE);
    await expect(
      harness.action(internal.credentialCryptoActions.ownerValues, { userId: 'owner-0' }),
    ).resolves.not.toContain('planted-value');
  });

  it('logs by id each row the key cannot open, leaves it as it was, and still finishes', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const log = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const harness = limitedHarness();
    const rows = await bed(harness);
    const before = await harness.run(
      async (ctx) => await Promise.all(rows.unreadable.map(async (id) => await ctx.db.get(id))),
    );

    await runAll(harness);

    const after = await harness.run(
      async (ctx) => await Promise.all(rows.unreadable.map(async (id) => await ctx.db.get(id))),
    );
    expect(after.map((row) => row?.ciphertext)).toEqual(before.map((row) => row?.ciphertext));
    expect(after.every((row) => row?.keyId === undefined)).toBe(true);
    const lines = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    const logged = lines
      .filter((line) => line.reason === CREDENTIAL_KEY_CHANGED_MESSAGE)
      .flatMap((line) => line.credentialIds as string[]);
    expect(logged.sort()).toEqual([...rows.unreadable].sort());
    expect(JSON.stringify(lines)).not.toMatch(/-value-/);
    expect((await resealStatus(harness))?.completedAt).toBeDefined();
  });

  it('finishes with no key on a deployment that stores no value', async (): Promise<void> => {
    const harness = limitedHarness();
    await sealedRow(harness, { userId: 'owner', plaintext: '', key: KEY, shape: 'purged' });
    await runAll(harness);
    expect(await resealStatus(harness)).toMatchObject({ read: 1, changed: 0, remaining: 0 });
  });

  it('records a page once when two runners reach it together', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const harness = limitedHarness();
    await bed(harness);
    const page = { read: 50, changed: 20, cursor: 'next', isDone: false };

    await harness.mutation(internal.migrations.recordActionPage, {
      name: 'credentials-reseal',
      fromCursor: null,
      page,
    });
    await harness.mutation(internal.migrations.recordActionPage, {
      name: 'credentials-reseal',
      fromCursor: null,
      page,
    });

    expect(await resealStatus(harness)).toMatchObject({ read: 50, changed: 20 });
  });

  it('leaves a row a sync rewrote while the page was sealing it', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const harness = limitedHarness();
    const id = await sealedRow(harness, {
      userId: 'owner',
      plaintext: 'old-value',
      key: KEY,
      shape: 'unbound',
    });
    const opened = await harness.run(async (ctx) => await ctx.db.get(id));
    const rewritten = sealForOwner('new-value', { current: KEY }, 'owner');
    await harness.run(async (ctx) => await ctx.db.patch(id, rewritten));

    const applied = await harness.mutation(internal.credentials.applyReseal, {
      rows: [
        {
          credentialId: id,
          fromCiphertext: opened?.ciphertext ?? '',
          ...sealForOwner('old-value', { current: KEY }, 'owner'),
        },
      ],
    });

    expect(applied).toBe(0);
    await expect(harness.action(internal.credentials.decrypt, { credentialId: id })).resolves.toBe(
      'new-value',
    );
  });
});

/** The ref rewrite's row in `migrations:status`. */
async function valueRefStatus(harness: Harness): Promise<Record<string, unknown> | undefined> {
  return (await harness.query(internal.migrations.status, {})).migrations.find(
    (row) => row.name === 'credentials-value-refs',
  ) as Record<string, unknown> | undefined;
}

/** Run one page of the ref rewrite the way `runPending` does: start, page, record. */
async function valueRefOnePage(harness: Harness): Promise<void> {
  const start = await harness.query(internal.migrations.migrationStart, {
    name: 'credentials-value-refs',
  });
  const page = await harness.action(internal.credentialCryptoActions.valueRefPage, {
    cursor: start.cursor,
  });
  await harness.mutation(internal.migrations.recordActionPage, {
    name: 'credentials-value-refs',
    fromCursor: start.cursor,
    page: { read: page.read, changed: page.changed, cursor: page.cursor, isDone: page.isDone },
  });
}

describe('the value-keyed credential refs (C step 1, P5-12, P7-15)', (): void => {
  const KEY = randomBytes(32).toString('base64');
  const LOST_KEY = randomBytes(32).toString('base64');

  /** The ref a sync gives a value on a page under `KEY`. */
  function valueRef(pageRef: string, plaintext: string, userId: string): string {
    return credentialSourceRef(pageRef, credentialValueFingerprint(plaintext, KEY, userId));
  }

  /** One stored row as the store wrote it, on a page ref or entered by a person. */
  async function storedRow(
    harness: Harness,
    row: {
      userId: string;
      sourceId: Id<'docSources'>;
      ref?: string;
      plaintext: string;
      key?: string;
      label?: string;
      status?: 'superseded';
      purged?: boolean;
    },
  ): Promise<Id<'credentials'>> {
    const sealed = row.purged
      ? {}
      : sealForOwner(row.plaintext, { current: row.key ?? KEY }, row.userId);
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: row.userId,
          kind: 'value',
          label: row.label ?? 'linear service token',
          source: row.ref === undefined ? 'entered' : { sourceId: row.sourceId, ref: row.ref },
          createdAt: 1,
          quoted: true,
          ...sealed,
          ...(row.status !== undefined ? { status: row.status } : {}),
          ...(row.purged ? { revokedAt: 2 } : {}),
        }),
    );
  }

  /**
   * A bed-shaped table: three owners' rows in every shape an upgraded volume
   * holds, 120 in all, so the rewrite takes three pages.
   */
  async function bed(harness: Harness): Promise<{
    legacy: Array<{ id: Id<'credentials'>; pageRef: string; plaintext: string; userId: string }>;
    untouched: Id<'credentials'>[];
    unreadable: Id<'credentials'>[];
  }> {
    const owners = ['owner-0', 'owner-1', 'owner-2'];
    const sources = await Promise.all(owners.map(async (userId) => await source(harness, userId)));
    const legacy: Array<{
      id: Id<'credentials'>;
      pageRef: string;
      plaintext: string;
      userId: string;
    }> = [];
    const untouched: Id<'credentials'>[] = [];
    const unreadable: Id<'credentials'>[] = [];
    const place = (index: number) => ({
      userId: owners[index % 3],
      sourceId: sources[index % 3],
      pageRef: `runbooks/page-${index}.md`,
    });
    // Rows needing no change first, so the legacy ones spread over the later pages.
    for (let index = 0; index < 20; index += 1) {
      const { userId, sourceId, pageRef } = place(index);
      const plaintext = `keyed-value-${index}`;
      untouched.push(
        await storedRow(harness, {
          userId,
          sourceId,
          plaintext,
          ref: valueRef(pageRef, plaintext, userId),
        }),
      );
    }
    for (let index = 0; index < 5; index += 1) {
      const { userId, sourceId, pageRef } = place(index);
      untouched.push(await storedRow(harness, { userId, sourceId, plaintext: `entered-${index}` }));
      untouched.push(
        await storedRow(harness, {
          userId,
          sourceId,
          ref: `${pageRef}#credential=9-purged`,
          plaintext: '',
          purged: true,
        }),
      );
      unreadable.push(
        await storedRow(harness, {
          userId,
          sourceId,
          ref: `${pageRef}#credential=8-lost`,
          plaintext: `lost-value-${index}`,
          key: LOST_KEY,
        }),
      );
    }
    for (let index = 0; index < 85; index += 1) {
      const { userId, sourceId, pageRef } = place(100 + index);
      const plaintext = `legacy-value-${index}`;
      const ref =
        index % 2 === 0
          ? pageRef
          : `${pageRef}#credential=${(index % 3) + 1}-${encodeURIComponent('linear service token')}`;
      legacy.push({
        id: await storedRow(harness, {
          userId,
          sourceId,
          ref,
          plaintext,
          ...(index % 17 === 0 ? { status: 'superseded' as const } : {}),
        }),
        pageRef,
        plaintext,
        userId,
      });
    }
    return { legacy, untouched, unreadable };
  }

  it('rewrites a bed-shaped table in pages on the runner, keeping each row and its page, and says how many remain', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const log = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const harness = limitedHarness();
    const rows = await bed(harness);
    const before = await harness.run(
      async (ctx) =>
        await Promise.all(rows.untouched.map(async (id) => (await ctx.db.get(id))?.source)),
    );

    expect(await valueRefStatus(harness)).toMatchObject({ release: '0.6.0', remaining: 90 });
    await valueRefOnePage(harness);
    const partway = await valueRefStatus(harness);
    expect(partway).toMatchObject({ read: 50 });
    expect(partway?.completedAt).toBeUndefined();
    expect(partway?.remaining).toBeLessThan(90);
    expect(partway?.remaining).toBeGreaterThan(5);

    await runAll(harness);

    expect(await valueRefStatus(harness)).toMatchObject({
      read: 120,
      changed: 85,
      remaining: 5,
      completedAt: expect.any(Number),
    });
    for (const { id, pageRef, plaintext, userId } of rows.legacy) {
      const row = await harness.run(async (ctx) => await ctx.db.get(id));
      expect(row?.source).toEqual({
        sourceId: expect.any(String),
        ref: valueRef(pageRef, plaintext, userId),
      });
      expect(row).toMatchObject({ label: 'linear service token', quoted: true });
      await expect(
        harness.query(internal.credentials.pageRowsForStore, {
          userId,
          sourceId: (row?.source as { sourceId: Id<'docSources'> }).sourceId,
          pageRef,
        }),
      ).resolves.toEqual([expect.objectContaining({ _id: id })]);
    }
    const statuses = await harness.run(
      async (ctx) =>
        await Promise.all(
          rows.legacy.map(async ({ id }) => (await ctx.db.get(id))?.status ?? 'live'),
        ),
    );
    expect(statuses.filter((status) => status === 'superseded')).toHaveLength(5);
    expect(
      await harness.run(
        async (ctx) =>
          await Promise.all(rows.untouched.map(async (id) => (await ctx.db.get(id))?.source)),
      ),
    ).toEqual(before);
    const lines = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    const leftOnOldRef = lines
      .filter((line) => String(line.msg ?? line.message ?? '').includes('valueRefs'))
      .flatMap((line) => line.credentialIds as string[]);
    expect(leftOnOldRef.sort()).toEqual([...rows.unreadable].sort());
    expect(JSON.stringify(lines)).not.toMatch(/-value-/);
  });

  it('gives the sync the ref it would have given, so the next sync finds the row and stores nothing new', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const plaintext = ['lin', 'api', 'migrated-contract-0123456789abcdef'].join('_');
    const id = await storedRow(harness, {
      userId: 'owner',
      sourceId,
      ref: 'runbook.md#credential=2-linear%20service%20token',
      plaintext,
    });

    await runAll(harness);

    const fingerprint = await harness.action(internal.credentialCryptoActions.fingerprint, {
      plaintext,
      userId: 'owner',
    });
    await expect(
      harness.action(internal.credentials.store, {
        userId: 'owner',
        kind: 'value',
        label: 'linear service token',
        plaintext,
        source: { sourceId, ref: credentialSourceRef('runbook.md', fingerprint) },
      }),
    ).resolves.toBe(id);
    expect(
      await harness.run(async (ctx) => (await ctx.db.query('credentials').collect()).length),
    ).toBe(1);
  });

  it("carries a moved row's ref into a sync that ended short, so the sync that takes it over keeps the row", async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const plaintext = 'resumed-run-value';
    const id = await storedRow(harness, {
      userId: 'owner',
      sourceId,
      ref: 'runbook.md',
      plaintext,
    });
    const { completed, endedShort } = await harness.run(async (ctx) => {
      const run = {
        sourceId,
        refs: ['runbook.md'],
        credentialRefs: ['runbook.md'],
        pageCount: 1,
        redactionCount: 1,
        createdAt: Date.now(),
      };
      return {
        completed: await ctx.db.insert('docSyncRuns', {
          ...run,
          state: 'completed',
          completedAt: Date.now(),
        }),
        // Read the page before the upgrade, then stopped short of the listing's end.
        endedShort: await ctx.db.insert('docSyncRuns', {
          ...run,
          state: 'error',
          cursor: 'page-2',
          completedAt: Date.now(),
        }),
      };
    });

    await runAll(harness);

    const [completedRun, endedShortRun] = await harness.run(
      async (ctx) => await Promise.all([ctx.db.get(completed), ctx.db.get(endedShort)]),
    );
    expect(completedRun?.credentialRefs).toEqual(['runbook.md']);
    expect(endedShortRun?.credentialRefs).toEqual([valueRef('runbook.md', plaintext, 'owner')]);

    // The next sync takes the run over from its cursor and finishes without re-reading the page.
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await expect(
      harness.mutation(internal.docSources.finishSync, {
        sourceId,
        runId,
        currentCursor: 'page-2',
        refs: [],
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
      }),
    ).resolves.toMatchObject({ completed: true });
    expect((await harness.run(async (ctx) => await ctx.db.get(id)))?.status).toBeUndefined();
  });

  it('leaves a row whose value another row of its page already holds, logs it and still finishes', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const log = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const plaintext = 'twice-stored-value';
    const keyed = await storedRow(harness, {
      userId: 'owner',
      sourceId,
      ref: valueRef('runbook.md', plaintext, 'owner'),
      plaintext,
    });
    const twin = await storedRow(harness, {
      userId: 'owner',
      sourceId,
      ref: 'runbook.md',
      plaintext,
    });

    await runAll(harness);

    const [keyedRow, twinRow] = await harness.run(
      async (ctx) => await Promise.all([ctx.db.get(keyed), ctx.db.get(twin)]),
    );
    expect(keyedRow?.source).toEqual({ sourceId, ref: valueRef('runbook.md', plaintext, 'owner') });
    expect(twinRow?.source).toEqual({ sourceId, ref: 'runbook.md' });
    expect(await valueRefStatus(harness)).toMatchObject({
      changed: 0,
      remaining: 1,
      completedAt: expect.any(Number),
    });
    const logged = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.reason === 'another row of the page already holds the same value');
    expect(logged.flatMap((line) => line.credentialIds as string[])).toEqual([twin]);
  });

  it('leaves a row a sync moved while the page was fingerprinting it', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const id = await storedRow(harness, {
      userId: 'owner',
      sourceId,
      ref: 'runbook.md#credential=1-linear%20service%20token',
      plaintext: 'moving-value',
    });
    const movedTo = valueRef('runbook.md', 'moving-value', 'owner');
    await harness.run(
      async (ctx) => await ctx.db.patch(id, { source: { sourceId, ref: movedTo } }),
    );

    await expect(
      harness.mutation(internal.credentials.applyValueRefs, {
        rows: [
          {
            credentialId: id,
            fromRef: 'runbook.md#credential=1-linear%20service%20token',
            ref: valueRef('runbook.md', 'other-value', 'owner'),
          },
        ],
      }),
    ).resolves.toEqual({ changed: 0, blocked: [] });
    expect((await harness.run(async (ctx) => await ctx.db.get(id)))?.source).toEqual({
      sourceId,
      ref: movedTo,
    });
  });

  it('finishes with no key on a deployment that stores no value', async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    await storedRow(harness, {
      userId: 'owner',
      sourceId,
      ref: 'runbook.md',
      plaintext: '',
      purged: true,
    });
    await runAll(harness);
    expect(await valueRefStatus(harness)).toMatchObject({ read: 1, changed: 0, remaining: 0 });
  });
});

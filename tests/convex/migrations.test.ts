/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { MIGRATION_NAMES, MIGRATIONS, passedOverNote } from '../../convex/migrations';
import { RETIRED_DECLARATIONS, RETIRING_DECLARATIONS } from '../../scripts/releases';
import { NEWEST_MIGRATION_RELEASE } from '../../src/lib/release';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { isOfferable } from '../../src/work/skill-library';
import { USE_COUNT_SCAN_LIMIT } from '../../convex/skillVersions';
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
import { credentialSourceRef } from '../../src/docs/credential-ref';
import { listingCursor } from '../../src/docs/readers/batch';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { upgradeScopeNote } from '../../src/surfaces/intake-scope';

type Harness = TestConvex<typeof schema>;

/** A harness that enforces the deployed backend's per-transaction limits. */
function limitedHarness(): Harness {
  return convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
}

async function agent(harness: Harness, fields: { userId?: string } = {}): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
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

  it('runs the second schema step’s migrations and the batch settling on the runner, each at 0.6.0, and records each finished', async (): Promise<void> => {
    const secondStep = [
      'surfaces-withheld-tools',
      'work-evaluation-unavailable-cause',
      'sync-runs-unread',
      'doc-page-listings',
      'credentials-superseded-at',
      'decision-batches-settled',
    ];
    // Re-pinned at 12-S3 to where the step starts rather than its distance from the end: every
    // later release appends its passes behind it (0.13.0 to 0.16.0 so far), and they stay in order.
    const start = MIGRATION_NAMES.indexOf('surfaces-withheld-tools');
    expect(MIGRATION_NAMES.slice(start, start + secondStep.length)).toEqual(secondStep);
    expect(MIGRATION_NAMES.indexOf('skills-library')).toBe(start + secondStep.length);
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
          bossEmail: MANAGER_ADDRESS,
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

  it('gives an approved card whose failed probe cleared its list an empty approved list at its last connection, and leaves one that never connected', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const [cleared, neverConnected, unapproved] = await harness.run(async (ctx) => {
      const card = async (
        slug: string,
        fields: Partial<Doc<'surfaces'>>,
      ): Promise<Id<'surfaces'>> =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug,
          displayName: slug,
          class: 'kanban',
          verdict: 'listed-dead',
          whereFound: [],
          credentialLanded: false,
          createdAt: 1,
          ...fields,
        });
      const ids = await Promise.all([
        card('linear', { reason: 'no answer', managerApprovedAt: 5 }),
        card('jira', { verdict: 'ungranted', reason: '401', managerApprovedAt: 6 }),
        card('asana', { reason: 'no answer' }),
      ]);
      for (const [surfaceId, createdAt] of [
        [ids[0], 40],
        [ids[0], 70],
        [ids[2], 50],
      ] as const) {
        await ctx.db.insert('events', {
          agentId,
          type: 'surface.connected',
          payload: { surfaceId },
          createdAt,
        });
      }
      return ids;
    });

    await runAll(harness);

    const rows = await harness.run(
      async (ctx) =>
        await Promise.all([cleared, neverConnected, unapproved].map((id) => ctx.db.get(id))),
    );
    expect(rows.map((row) => [row?.approvedToolAllowlist, row?.toolAllowlistApprovedAt])).toEqual([
      [[], 70],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    expect(
      (await harness.query(internal.migrations.status, {})).migrations.find(
        (row) => row.name === 'surfaces-approved-tools',
      ),
    ).toMatchObject({ read: 3, changed: 1 });
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

  it('retires docSyncRuns.refs with the clearing migration that cleared it at 0.16.0 (13-K)', (): void => {
    expect(RETIRED_DECLARATIONS).toContainEqual({
      declaration: 'docSyncRuns.refs',
      migration: 'sync-runs-refs',
      release: '0.16.0',
    });
    expect(RETIRING_DECLARATIONS.map((row) => row.declaration)).not.toContain('docSyncRuns.refs');
    expect(MIGRATION_NAMES as readonly string[]).not.toContain('sync-runs-refs');
  });

  it('retires surfaces.itApprovedAt with the single-approval migration that cleared it at 0.6.0 (12-S3)', (): void => {
    expect(RETIRED_DECLARATIONS).toContainEqual({
      declaration: 'surfaces.itApprovedAt',
      migration: 'surfaces-single-approval',
      release: '0.6.0',
    });
    expect(RETIRING_DECLARATIONS.map((row) => row.declaration)).not.toContain(
      'surfaces.itApprovedAt',
    );
    expect(MIGRATION_NAMES as readonly string[]).not.toContain('surfaces-single-approval');
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
                bossEmail: MANAGER_ADDRESS,
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

  it('reads within its byte bound, so mirrors of full page bodies re-key inside the transaction read limit (M23)', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const sourceId = await source(harness, 'owner');
    // Thirty mirrors of 600 KB each are 18 MB: more than one transaction may read, so a page
    // bounded by rows alone fails, and one bounded by bytes takes them a few at a time.
    const body = 'x'.repeat(600_000);
    const refs = Array.from({ length: 30 }, (_unused, index) => `page-${index}.md`);
    for (const ref of refs) {
      await harness.run(async (ctx) => {
        await ctx.db.insert('mockDocs', {
          agentId,
          slug: `source-legacy-${ref}`,
          title: ref,
          body,
          category: 'team-doc',
          sourceId,
          sourceRef: ref,
          updatedAt: 1,
        });
      });
    }

    await runAll(harness);

    // One read per mirror: the test is held to the same read limit as the migration.
    for (const ref of refs) {
      const mirror = await harness.run(
        async (ctx) =>
          await ctx.db
            .query('mockDocs')
            .withIndex('by_agent_slug', (q) =>
              q.eq('agentId', agentId).eq('slug', mirroredDocSlug(sourceId, ref)),
            )
            .unique(),
      );
      expect(mirror?.sourceRef, ref).toBe(ref);
    }
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'mirrors-rekey')).toMatchObject({
      read: 30,
      changed: 30,
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
    // Re-pinned at 0.19.0, the wave 15 schema step (its block status pass), from 0.6.0, 0.10.0,
    // 0.13.0, 0.14.0, 0.15.0, 0.16.0, 0.17.0 and 0.18.0: a stamp names a release no older than
    // the newest a shipped migration names.
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: '0.19.0', commit: 'abc1234' }),
    ).resolves.toEqual({ release: '0.19.0', previous: null });
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: '0.19.0', commit: 'abc1234' }),
    ).resolves.toEqual({ release: '0.19.0', previous: '0.19.0' });
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: '0.20.0', commit: 'def5678' }),
    ).resolves.toEqual({ release: '0.20.0', previous: '0.19.0' });

    const status = await harness.query(internal.migrations.status, {});
    expect(status.pending).toEqual([]);
    expect(status.release).toMatchObject({ release: '0.20.0', commit: 'def5678' });
    expect(
      await harness.run(async (ctx) => (await ctx.db.query('deploymentVersions').collect()).length),
    ).toBe(2);
  });
});

describe('the release a stamp may name', (): void => {
  it('refuses a release older than the newest one a shipped migration names, and a malformed one', async (): Promise<void> => {
    const harness = limitedHarness();
    await runAll(harness);
    const newest = Object.values(MIGRATIONS)
      .map((migration) => migration.release)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .at(-1)!;
    // The constant the upgrade reads before it pushes is the migrations' own.
    expect(NEWEST_MIGRATION_RELEASE).toBe(newest);
    // A deployment set up from a tree whose package still says the release
    // before its migrations would otherwise read as a release that lacks them.
    for (const release of ['0.5.0', '0.3.0', 'v0.6.0', '0.6', 'latest']) {
      await expect(
        harness.mutation(internal.migrations.recordRelease, { release }),
        release,
      ).rejects.toThrow(newest);
    }
    expect(await harness.query(internal.migrations.status, {})).toMatchObject({ release: null });
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: newest }),
    ).resolves.toMatchObject({ release: newest });
  });
});

describe('the decision batches decided one member at a time before 0.6.0 (S2 D6)', (): void => {
  it('marks a batch with no open member decided, and leaves one a member still waits on', async (): Promise<void> => {
    const harness = limitedHarness();
    const agentId = await agent(harness, { userId: 'owner' });
    const [settledId, openId] = await harness.run(async (ctx) => {
      const pendingRunId = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: {},
        createdAt: 1,
      });
      const item = async (
        externalId: string,
        decided: boolean,
      ): Promise<{
        workItemId: Id<'workItems'>;
        decisionId: string;
        pendingRunId: Id<'events'>;
      }> => ({
        workItemId: await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId,
          title: externalId,
          contentSummary: externalId,
          contentRefs: [],
          state: 'actions-pending',
          pendingRunId,
          observedAt: 1,
          createdAt: 1,
          decision: {
            id: externalId.toLowerCase(),
            kind: 'actions',
            surfaceSlug: 'slack',
            surfaceName: 'Slack',
            channel: 'D0MANAGER',
            requestedAt: 1,
            ...(decided ? { decidedAt: 2, outcome: 'approved' as const } : {}),
          },
        }),
        decisionId: externalId.toLowerCase(),
        pendingRunId,
      });
      const batch = async (id: string, members: unknown[]): Promise<Id<'decisionBatches'>> =>
        await ctx.db.insert('decisionBatches', {
          agentId,
          id,
          surfaceSlug: 'slack',
          channel: 'D0MANAGER',
          members: members as Doc<'decisionBatches'>['members'],
          requestedAt: 1,
        });
      return [
        await batch('settled', [await item('A-1', true), await item('A-2', true)]),
        await batch('waiting', [await item('B-1', true), await item('B-2', false)]),
      ];
    });
    await runAll(harness);
    const [settled, open] = await harness.run(async (ctx) => [
      await ctx.db.get(settledId),
      await ctx.db.get(openId),
    ]);
    expect(settled?.decidedAt).toEqual(expect.any(Number));
    expect(settled?.outcome).toBeUndefined();
    expect(open?.decidedAt).toBeUndefined();
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'decision-batches-settled')).toMatchObject({
      read: 2,
      changed: 1,
    });
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
    // A cursor a resume can check (D D5): the offset bound to the listing it continues.
    const PAGE_2 = listingCursor(1, ['runbook.md', 'policy.md']);
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
      // Re-pinned at 12-S3: the runs carry no page refs. A run whose cursor is a listing cursor
      // began at 0.6.0 or later and never wrote refs, and the sync-runs-refs pass now clears the cursor of a run
      // that still carries them, so a fixture with both would not be taken over. Re-pinned at 13-K:
      // each run carries the listing every run since 0.6.0 is given when it begins, which the lazy
      // listing a run before 0.6.0 got (now retired) used to make up.
      const run = {
        sourceId,
        listing: 1,
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
          cursor: PAGE_2,
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
        currentCursor: PAGE_2,
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

describe('the skill library backfills (10-K, K3)', (): void => {
  /** A registered agent-authored skill as v0.12.0 left it: no version, no count, no kept check. */
  async function registeredSkill(
    harness: Harness,
    agentId: Id<'agents'>,
    fields: Partial<Doc<'skills'>> = {},
  ): Promise<Id<'skills'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId,
          name: 'kanban-comment-and-close',
          description: 'Ticket comment-and-close.',
          body: '# Comment and close',
          sourceType: 'agent-authored',
          state: 'registered',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          requiredScopes: ['tickets:write'],
          createdAt: 1,
          registeredAt: 2,
          ...fields,
        }),
    );
  }

  /** Every row the two backfills write or read, to compare a second run against the first. */
  async function libraryState(harness: Harness): Promise<unknown> {
    return await harness.run(async (ctx) => ({
      versions: await ctx.db.query('skillVersions').collect(),
      skills: await ctx.db.query('skills').collect(),
      recheckEvents: (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'skill.recheck-due',
      ),
    }));
  }

  it('the library backfill is safe to run twice and marks every backfilled version not offerable', async (): Promise<void> => {
    const harness = limitedHarness();
    const priya = await agent(harness, { userId: 'owner' });
    const mateo = await agent(harness, { userId: 'owner' });
    // A second owner keeps the legacy employee ownerless through `agents-owner`.
    await agent(harness, { userId: 'rival' });
    const legacy = await agent(harness);
    const first = await registeredSkill(harness, priya);
    const sameBody = await registeredSkill(harness, mateo);
    const otherBody = await registeredSkill(harness, mateo, {
      name: 'kanban-comment-and-close',
      body: '# Comment, then close once it reads back',
    });
    const builtin = await registeredSkill(harness, priya, {
      name: 'message-boss',
      sourceType: 'builtin',
      surfaceClass: undefined,
      operation: undefined,
    });
    const unshaped = await registeredSkill(harness, priya, {
      name: 'linear-action-revops-7',
      surfaceClass: undefined,
      operation: undefined,
    });
    const ownerless = await registeredSkill(harness, legacy);
    const failed = await registeredSkill(harness, priya, { name: 'kanban-other', state: 'failed' });

    await runAll(harness);

    const versions = await harness.run(
      async (ctx) => await ctx.db.query('skillVersions').collect(),
    );
    expect(
      versions.map((version) => [version.version, version.body, version.authorAgentId]),
    ).toEqual([
      [1, '# Comment and close', priya],
      [2, '# Comment, then close once it reads back', mateo],
    ]);
    for (const version of versions) {
      expect(isOfferable(version)).toBe(false);
      expect(version.smokeTest).toBeUndefined();
      expect(version).toMatchObject({
        userId: 'owner',
        verifiedAt: 2,
        harnessTools: [],
        readRefs: [],
      });
    }
    const rows = await harness.run(async (ctx) =>
      Promise.all(
        [first, sameBody, otherBody, builtin, unshaped, ownerless, failed].map((id) =>
          ctx.db.get(id),
        ),
      ),
    );
    const [one, two, three, ...outside] = rows;
    // Two holders of one body share its version; each holder is due a re-check.
    expect([one?.versionId, two?.versionId, three?.versionId]).toEqual([
      versions[0]._id,
      versions[0]._id,
      versions[1]._id,
    ]);
    for (const holder of [one, two, three]) {
      expect(holder?.recheckReason).toBe('its check was not kept');
    }
    for (const row of outside) {
      expect(row?.versionId).toBeUndefined();
      expect(row?.recheckDueAt).toBeUndefined();
    }

    // A second run, of the whole upgrade and of each backfill from its first page.
    const before = await libraryState(harness);
    await expect(harness.action(internal.migrations.runPending, {})).resolves.toEqual({
      migrations: [],
      pending: [],
    });
    await harness.run(async (ctx) => {
      for (const row of await ctx.db.query('migrations').collect()) {
        if (row.name === 'skills-library' || row.name === 'skills-use-count') {
          await ctx.db.delete(row._id);
        }
      }
    });
    const again = await harness.action(internal.migrations.runPending, {});
    expect(again.migrations.map((row) => [row.name, row.changed])).toEqual([
      ['skills-library', 0],
      ['skills-use-count', 0],
    ]);
    expect(await libraryState(harness)).toEqual(before);
  });

  it('backfills the use count and the last use from the claims that named each skill, never lowering either', async (): Promise<void> => {
    const harness = limitedHarness();
    const priya = await agent(harness, { userId: 'owner' });
    const used = await registeredSkill(harness, priya);
    const counted = await registeredSkill(harness, priya, { name: 'kanban-other', useCount: 9 });
    const unused = await registeredSkill(harness, priya, { name: 'kanban-third' });
    await harness.run(async (ctx) => {
      const item = await ctx.db.insert('workItems', {
        agentId: priya,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'tickets',
        externalId: 'OPS-1',
        title: 'OPS-1',
        contentSummary: 'Done.',
        contentRefs: [],
        state: 'completed',
        skillId: used,
        observedAt: 1,
        createdAt: 1,
      });
      // One item run twice (a Retry) is two uses; the other skill's claim is not this one's.
      for (const [skillId, createdAt] of [
        [used, 100],
        [used, 300],
        [counted, 200],
      ] as const) {
        await ctx.db.insert('events', {
          agentId: priya,
          type: 'work.execution-claimed',
          payload: { workItemId: item, skillId },
          createdAt,
        });
      }
    });

    await runAll(harness);

    const [one, two, three] = await harness.run(async (ctx) =>
      Promise.all([used, counted, unused].map((id) => ctx.db.get(id))),
    );
    expect(one).toMatchObject({ useCount: 2, lastUsedAt: 300 });
    expect(two).toMatchObject({ useCount: 9, lastUsedAt: 200 });
    expect(three?.useCount).toBeUndefined();
    expect(three?.lastUsedAt).toBeUndefined();
    const status = await harness.query(internal.migrations.status, {});
    expect(
      status.migrations
        .filter((row) => row.name.startsWith('skills-'))
        .map((row) => [row.name, row.release, row.completedAt !== undefined]),
    ).toEqual([
      ['skills-library', '0.13.0', true],
      ['skills-use-count', '0.13.0', true],
      // Re-pinned: the owner key pass (0.15.0) is a skills pass too, and finishes with them.
      ['skills-owner-key', '0.15.0', true],
    ]);
  });

  it('reads the newest claims first, so the last use is right when the count is a floor', async (): Promise<void> => {
    const harness = limitedHarness();
    const priya = await agent(harness, { userId: 'owner' });
    const used = await registeredSkill(harness, priya);
    await harness.run(async (ctx) => {
      for (let index = 0; index <= USE_COUNT_SCAN_LIMIT; index += 1) {
        await ctx.db.insert('events', {
          agentId: priya,
          type: 'work.execution-claimed',
          payload: { skillId: used },
          createdAt: 1_000 + index,
        });
      }
    });

    await runAll(harness);

    expect(await harness.run(async (ctx) => await ctx.db.get(used))).toMatchObject({
      useCount: USE_COUNT_SCAN_LIMIT,
      lastUsedAt: 1_000 + USE_COUNT_SCAN_LIMIT,
    });
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'skills-use-count')?.note).toContain(
      'each count is a floor',
    );
  });

  it('backfills a library larger than one page, every holder once', async (): Promise<void> => {
    const harness = limitedHarness();
    const priya = await agent(harness, { userId: 'owner' });
    for (let index = 0; index < 60; index += 1) {
      await registeredSkill(harness, priya, {
        name: `kanban-comment-and-close-${index}`,
        body: `# Body ${index}`,
      });
    }

    await runAll(harness);

    const [versions, skills] = await harness.run(async (ctx) => [
      await ctx.db.query('skillVersions').collect(),
      await ctx.db.query('skills').collect(),
    ]);
    expect(versions).toHaveLength(60);
    expect(skills.every((row) => row.versionId !== undefined)).toBe(true);
  });
});

describe('the acts-as backfill (11-AK, the access plan section 4.2)', (): void => {
  // The credential re-seal runs before it over the same rows and needs a key; the sealed
  // placeholders are rows it cannot open, which it logs and leaves.
  beforeEach((): void => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  });

  /** A card as v0.13.0 left it, holding the given credential or none. */
  async function card(
    harness: Harness,
    agentId: Id<'agents'>,
    fields: Partial<Doc<'surfaces'>>,
  ): Promise<Id<'surfaces'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'connected',
          whereFound: [],
          credentialLanded: true,
          createdAt: 1,
          ...fields,
        }),
    );
  }

  /** A credential row as v0.13.0 wrote it. */
  async function credential(
    harness: Harness,
    fields: Pick<Doc<'credentials'>, 'kind' | 'label'> & Partial<Doc<'credentials'>>,
  ): Promise<Id<'credentials'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          source: 'entered',
          ciphertext: 'sealed',
          iv: 'iv',
          createdAt: 1,
          ...fields,
        }),
    );
  }

  /** Every card's `actsAs`, by id, to compare a second run against the first. */
  async function identities(harness: Harness): Promise<unknown> {
    return await harness.run(async (ctx) =>
      (await ctx.db.query('surfaces').collect()).map((row) => [row._id, row.actsAs ?? null]),
    );
  }

  it('is registered at 0.14.0, after the skill library backfills it follows', (): void => {
    expect(MIGRATIONS['surfaces-acts-as'].release).toBe('0.14.0');
    expect(MIGRATION_NAMES.indexOf('surfaces-acts-as')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('skills-use-count'),
    );
  });

  it('names an installed app’s card as its own app and every pasted key’s as a shared key, leaves the rest, and is safe to run twice', async (): Promise<void> => {
    const harness = limitedHarness();
    const maya = await agent(harness, { userId: 'owner' });
    const botToken = await credential(harness, {
      kind: 'oauth',
      label: 'Slack bot token (slack dedicated app)',
      source: 'oauth',
    });
    const clientSecret = await credential(harness, { kind: 'value', label: 'Maya client secret' });
    const slack = await card(harness, maya, {
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      credentialId: botToken,
      credentialKind: 'oauth',
      providerIdentityId: 'U0DAY0BOT',
      provisioning: {
        appId: 'A0DAY0',
        appName: 'Maya (Day0)',
        clientId: 'client-1',
        clientSecretCredentialId: clientSecret,
        installUrl: 'https://slack.com/oauth/v2/authorize',
        redirectUrl: 'http://localhost:3000/api/oauth/slack',
        scopes: ['chat:write'],
        createdAt: 1,
        installedAt: 2,
      },
    });
    const pasted = await credential(harness, { kind: 'value', label: 'Linear access' });
    const linear = await card(harness, maya, { credentialId: pasted, credentialKind: 'value' });
    // A card the older code attached without copying the kind reads it off the credential.
    const vault = await credential(harness, { kind: 'location', label: 'Looker key in the vault' });
    const looker = await card(harness, maya, {
      slug: 'looker',
      displayName: 'Looker',
      verdict: 'ungranted',
      credentialLanded: false,
      credentialId: vault,
    });
    const revoked = await credential(harness, {
      kind: 'value',
      label: 'Old Notion key',
      revokedAt: 5,
    });
    const notion = await card(harness, maya, {
      slug: 'notion',
      credentialId: revoked,
      credentialKind: 'value',
    });
    const emptied = await credential(harness, {
      kind: 'value',
      label: 'Unlinked key',
      ciphertext: undefined,
      iv: undefined,
    });
    const unlinked = await card(harness, maya, {
      slug: 'drive',
      credentialId: emptied,
      credentialKind: 'value',
    });
    const gone = await credential(harness, { kind: 'value', label: 'Deleted key' });
    await harness.run(async (ctx) => await ctx.db.delete(gone));
    const dangling = await card(harness, maya, {
      slug: 'github',
      credentialId: gone,
      credentialKind: 'value',
    });
    const bare = await card(harness, maya, {
      slug: 'zendesk',
      verdict: 'approved',
      credentialLanded: false,
    });
    const written = await card(harness, maya, {
      slug: 'hubspot',
      credentialId: pasted,
      credentialKind: 'value',
      actsAs: { kind: 'shared-app', label: 'Day0' },
    });

    const first = await harness.action(internal.migrations.runPending, {});
    expect(first.pending).toEqual([]);
    expect(first.migrations.find((row) => row.name === 'surfaces-acts-as')).toMatchObject({
      read: 8,
      changed: 3,
      completedAt: expect.any(Number),
    });
    const read = await harness.run(async (ctx) =>
      Promise.all(
        [slack, linear, looker, notion, unlinked, dangling, bare, written].map((id) =>
          ctx.db.get(id),
        ),
      ),
    );
    expect(read.map((row) => row?.actsAs)).toEqual([
      { kind: 'own-app', label: 'Maya (Day0)', providerIdentityId: 'U0DAY0BOT' },
      { kind: 'shared-key', label: 'Linear access' },
      { kind: 'shared-key', label: 'Looker key in the vault' },
      undefined,
      undefined,
      undefined,
      undefined,
      { kind: 'shared-app', label: 'Day0' },
    ]);
    // Nothing else on a card changes: the backfill writes only whom it acts as.
    const [slackAfter] = read;
    expect(slackAfter).toMatchObject({
      verdict: 'connected',
      credentialId: botToken,
      credentialKind: 'oauth',
      credentialLanded: true,
    });

    // A second run, of the whole upgrade and of the backfill from its first page.
    const before = await identities(harness);
    await expect(harness.action(internal.migrations.runPending, {})).resolves.toEqual({
      migrations: [],
      pending: [],
    });
    await harness.run(async (ctx) => {
      for (const row of await ctx.db.query('migrations').collect()) {
        if (row.name === 'surfaces-acts-as') await ctx.db.delete(row._id);
      }
    });
    const again = await harness.action(internal.migrations.runPending, {});
    expect(again.migrations.map((row) => [row.name, row.changed])).toEqual([
      ['surfaces-acts-as', 0],
    ]);
    expect(await identities(harness)).toEqual(before);
  });

  it('reads every card of a deployment larger than one page', async (): Promise<void> => {
    const harness = limitedHarness();
    const maya = await agent(harness, { userId: 'owner' });
    const pasted = await credential(harness, { kind: 'value', label: 'Linear access' });
    await harness.run(async (ctx) => {
      for (let index = 0; index < 230; index += 1) {
        await ctx.db.insert('surfaces', {
          agentId: maya,
          slug: `linear-${index}`,
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'connected',
          whereFound: [],
          credentialLanded: true,
          credentialId: pasted,
          credentialKind: 'value',
          createdAt: 1,
        });
      }
    });
    await runAll(harness);
    const unnamed = await harness.run(async (ctx) =>
      (await ctx.db.query('surfaces').collect()).filter((row) => row.actsAs === undefined),
    );
    expect(unnamed).toEqual([]);
  });
});

describe('the issued-by backfill (11-AR; the cockpit item 4 of 11-AK)', (): void => {
  // The re-seal runs before it over the same rows and needs a key; the sealed placeholders are
  // rows it cannot open, which it logs and leaves.
  beforeEach((): void => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  });

  /** A credential row as v0.13.0 wrote it. */
  async function credential(
    harness: Harness,
    fields: Pick<Doc<'credentials'>, 'kind' | 'label'> & Partial<Doc<'credentials'>>,
  ): Promise<Id<'credentials'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          source: 'entered',
          ciphertext: 'sealed',
          iv: 'iv',
          createdAt: 1,
          ...fields,
        }),
    );
  }

  /** A Slack card as v0.13.0 left it once its own app was installed. */
  async function installedSlackCard(
    harness: Harness,
    agentId: Id<'agents'>,
    ids: { readonly botToken: Id<'credentials'>; readonly clientSecret: Id<'credentials'> },
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
          credentialId: ids.botToken,
          credentialKind: 'oauth',
          provisioning: {
            appId: 'A0W11AR',
            appName: 'Maya (Day0)',
            clientId: '1234.5678',
            clientSecretCredentialId: ids.clientSecret,
            installUrl: 'https://slack.com/oauth/v2/authorize',
            redirectUrl: 'http://localhost:3000/api/oauth/slack',
            scopes: ['chat:write'],
            createdAt: 1,
            installedAt: 2,
          },
          createdAt: 1,
        }),
    );
  }

  /** Every credential's `issuedBy`, by id, to compare a second run against the first. */
  async function issuers(harness: Harness): Promise<unknown> {
    return await harness.run(async (ctx) =>
      (await ctx.db.query('credentials').collect()).map((row) => [row._id, row.issuedBy ?? null]),
    );
  }

  it('is registered at 0.14.0, after the acts-as backfill', (): void => {
    expect(MIGRATIONS['credentials-issued-by'].release).toBe('0.14.0');
    expect(MIGRATION_NAMES.indexOf('credentials-issued-by')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('surfaces-acts-as'),
    );
  });

  it("names each installed app's bot token and client secret as Day0's, leaves every pasted key, and is safe to run twice", async (): Promise<void> => {
    const harness = limitedHarness();
    const maya = await agent(harness, { userId: 'owner' });
    const botToken = await credential(harness, {
      kind: 'oauth',
      label: 'Slack bot token (slack dedicated app)',
      source: 'oauth',
      appId: 'A0W11AR',
    });
    const clientSecret = await credential(harness, {
      kind: 'oauth',
      label: 'Maya (Day0) client secret',
      source: 'oauth',
      appId: 'A0W11AR',
    });
    await installedSlackCard(harness, maya, { botToken, clientSecret });
    const pasted = await credential(harness, { kind: 'value', label: 'Linear access' });
    await harness.run(async (ctx) => {
      await ctx.db.insert('surfaces', {
        agentId: maya,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        credentialId: pasted,
        credentialKind: 'value',
        createdAt: 1,
      });
    });
    // A shared bot token pasted on a Slack card before its own app replaced it, revoked then.
    const retired = await credential(harness, {
      kind: 'value',
      label: 'Shared Slack bot token',
      revokedAt: 3,
    });
    // An install-redirect token on a card that lost its app record still names its app.
    const orphanToken = await credential(harness, {
      kind: 'oauth',
      label: 'Slack bot token (support dedicated app)',
      source: 'oauth',
      appId: 'A0ORPHAN',
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('surfaces', {
        agentId: maya,
        slug: 'support',
        displayName: 'Support Slack',
        class: 'chat',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        credentialId: orphanToken,
        credentialKind: 'oauth',
        createdAt: 1,
      });
    });

    const first = await harness.action(internal.migrations.runPending, {});
    expect(first.pending).toEqual([]);
    expect(first.migrations.find((row) => row.name === 'credentials-issued-by')).toMatchObject({
      read: 3,
      changed: 3,
      completedAt: expect.any(Number),
    });
    const rows = await harness.run(async (ctx) =>
      Promise.all(
        [botToken, clientSecret, orphanToken, pasted, retired].map((id) => ctx.db.get(id)),
      ),
    );
    expect(rows.map((row) => row?.issuedBy)).toEqual([
      {
        system: 'slack',
        grant: 'oauth-install',
        appId: 'A0W11AR',
        clientId: '1234.5678',
        clientSecretCredentialId: clientSecret,
      },
      { system: 'slack', grant: 'app-created', appId: 'A0W11AR', clientId: '1234.5678' },
      { system: 'slack', grant: 'oauth-install', appId: 'A0ORPHAN' },
      undefined,
      undefined,
    ]);

    const before = await issuers(harness);
    await harness.run(async (ctx) => {
      for (const row of await ctx.db.query('migrations').collect()) {
        if (row.name === 'credentials-issued-by') await ctx.db.delete(row._id);
      }
    });
    const again = await harness.action(internal.migrations.runPending, {});
    expect(again.migrations.map((row) => [row.name, row.changed])).toEqual([
      ['credentials-issued-by', 0],
    ]);
    expect(await issuers(harness)).toEqual(before);
  });

  it('leaves a revoked or emptied install token, whose access already ended', async (): Promise<void> => {
    const harness = limitedHarness();
    const maya = await agent(harness, { userId: 'owner' });
    const botToken = await credential(harness, {
      kind: 'oauth',
      label: 'Slack bot token',
      source: 'oauth',
      revokedAt: 4,
    });
    const clientSecret = await credential(harness, {
      kind: 'oauth',
      label: 'client secret',
      source: 'oauth',
      ciphertext: undefined,
      iv: undefined,
      revokedAt: 4,
    });
    await installedSlackCard(harness, maya, { botToken, clientSecret });
    await runAll(harness);
    const rows = await harness.run(async (ctx) =>
      Promise.all([botToken, clientSecret].map((id) => ctx.db.get(id))),
    );
    expect(rows.map((row) => row?.issuedBy)).toEqual([undefined, undefined]);
  });
});

describe('the owner key backfill (K-m3; R-S)', (): void => {
  // Re-pinned at 12-S3: the newest release a migration names is now the sync runs' refs
  // clearing's, 0.16.0, which its own registration test pins.
  it('is registered at 0.15.0, after the access track’s backfills', (): void => {
    expect(MIGRATIONS['skills-owner-key'].release).toBe('0.15.0');
    expect(MIGRATION_NAMES.indexOf('skills-owner-key')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('credentials-issued-by'),
    );
  });

  it('keys every row of an owned employee on its owner, leaves an owner-less one and a keyed one, and is safe to run twice', async (): Promise<void> => {
    const harness = limitedHarness();
    const priya = await agent(harness, { userId: 'owner' });
    // A second owner, so the owner adoption leaves the owner-less employee as it is.
    await agent(harness, { userId: 'rival' });
    const ownerless = await agent(harness);
    const rows = await harness.run(async (ctx) => {
      const row = {
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket, then close it.',
        body: '',
        sourceType: 'agent-authored' as const,
        state: 'proposed' as const,
        createdAt: 1,
      };
      return {
        older: await ctx.db.insert('skills', { ...row, agentId: priya }),
        builtin: await ctx.db.insert('skills', {
          ...row,
          agentId: priya,
          name: 'triage',
          sourceType: 'builtin',
          state: 'registered',
        }),
        keyed: await ctx.db.insert('skills', { ...row, agentId: priya, ownerKey: 'kept' }),
        ownerless: await ctx.db.insert('skills', { ...row, agentId: ownerless }),
      };
    });

    await runAll(harness);

    const read = async (): Promise<Record<string, string | null>> =>
      await harness.run(async (ctx) =>
        Object.fromEntries(
          await Promise.all(
            Object.entries(rows).map(async ([name, id]) => [
              name,
              (await ctx.db.get(id))?.ownerKey ?? null,
            ]),
          ),
        ),
      );
    expect(await read()).toEqual({
      older: 'owner',
      builtin: 'owner',
      keyed: 'kept',
      ownerless: null,
    });
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'skills-owner-key')).toMatchObject({
      release: '0.15.0',
      changed: 2,
    });
    await expect(harness.action(internal.migrations.runPending, {})).resolves.toEqual({
      migrations: [],
      pending: [],
    });
    expect(await read()).toEqual({
      older: 'owner',
      builtin: 'owner',
      keyed: 'kept',
      ownerless: null,
    });
  });
});

describe('the organisation secret purge (F19; the pre-tag’s cockpit item; R-S)', (): void => {
  const DAY = 24 * 60 * 60 * 1000;

  it('is registered at 0.15.0, after the owner key and intake scope passes', (): void => {
    expect(MIGRATIONS['credentials-organisation-purge'].release).toBe('0.15.0');
    expect(MIGRATION_NAMES.indexOf('credentials-organisation-purge')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('surfaces-intake-scope'),
    );
  });

  it('deletes the value of an organisation secret revoked over 24 hours ago, leaves every other row, and is safe to run twice', async (): Promise<void> => {
    const key = randomBytes(32).toString('base64');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', key);
    const harness = limitedHarness();
    const now = Date.now();
    const rows = await harness.run(async (ctx) => {
      const secret = {
        userId: 'day0:organisation',
        holder: 'organisation' as const,
        kind: 'value' as const,
        label: 'Slack configuration token',
        source: 'entered' as const,
        ...sealForOwner('xoxe.xoxp-1-cfg1', { current: key }, 'day0:organisation'),
        createdAt: 1,
      };
      return {
        expired: await ctx.db.insert('credentials', { ...secret, revokedAt: now - 2 * DAY }),
        held: await ctx.db.insert('credentials', { ...secret, revokedAt: now - 60 * 60 * 1000 }),
        live: await ctx.db.insert('credentials', secret),
        pending: await ctx.db.insert('credentials', {
          ...secret,
          revokedAt: now - 2 * DAY,
          sourceRevocation: { state: 'pending', attempts: 1 },
        }),
        owners: await ctx.db.insert('credentials', {
          ...secret,
          ...sealForOwner('lin_api_1234567890', { current: key }, 'owner'),
          userId: 'owner',
          holder: undefined,
          revokedAt: now - 2 * DAY,
        }),
      };
    });

    await runAll(harness);

    const read = async (): Promise<Record<string, [boolean, number | null]>> =>
      await harness.run(async (ctx) =>
        Object.fromEntries(
          await Promise.all(
            Object.entries(rows).map(async ([name, id]) => {
              const row = await ctx.db.get(id);
              return [name, [row?.ciphertext !== undefined, row?.revokedAt ?? null]];
            }),
          ),
        ),
      );
    expect(await read()).toEqual({
      expired: [false, now - 2 * DAY],
      held: [true, now - 60 * 60 * 1000],
      live: [true, null],
      pending: [true, now - 2 * DAY],
      owners: [true, now - 2 * DAY],
    });
    const status = await harness.query(internal.migrations.status, {});
    expect(
      status.migrations.find((row) => row.name === 'credentials-organisation-purge'),
    ).toMatchObject({ release: '0.15.0', changed: 1 });
    await expect(harness.action(internal.migrations.runPending, {})).resolves.toEqual({
      migrations: [],
      pending: [],
    });
    expect((await read()).expired).toEqual([false, now - 2 * DAY]);
  });
});

describe('the intake scope backfill (the wave 11 review’s m5; R-S)', (): void => {
  afterEach((): void => {
    restoreSurfaceMode();
  });

  /** The manager's sentence about Linear in the charter, as discovery quoted it on the card. */
  function charterQuote(quote: string): NonNullable<Doc<'surfaces'>['discoveryEvidence']> {
    return [
      { kind: 'charter', ref: 'charter', quote, current: true, firstSeenAt: 1, lastSeenAt: 1 },
    ];
  }

  /**
   * Two employees of one owner on the RevOps handbook's Linear page, each with a Linear card
   * proposed before the field: Priya's charter sentence names the project, Mateo's names none.
   */
  async function seedCards(harness: Harness): Promise<{
    priyaCard: Id<'surfaces'>;
    mateoCard: Id<'surfaces'>;
    chatCard: Id<'surfaces'>;
    declaredCard: Id<'surfaces'>;
  }> {
    const sourceId = await source(harness, 'owner');
    return await harness.run(async (ctx) => {
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'linear.md',
        title: 'Linear',
        markdown:
          '# Linear\n\nThe RevOps team tracks its work in Linear.\n\n- Team: `RevOps`\n- Project: `Renewals`\n',
        updatedAt: 1,
      });
      const employee = async (name: string): Promise<Id<'agents'>> => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name,
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        await ctx.db.insert('charters', {
          agentId,
          version: '1',
          body: { proposedFunction: 'Revenue operations coordinator', namedSystems: [] },
          approved: true,
          approvedAt: 1,
          createdAt: 1,
        });
        return agentId;
      };
      const [priya, mateo] = [await employee('Priya'), await employee('Mateo')];
      const card = {
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected' as const,
        whereFound: [],
        credentialLanded: true,
        createdAt: 1,
      };
      return {
        priyaCard: await ctx.db.insert('surfaces', {
          ...card,
          agentId: priya,
          discoveryEvidence: charterQuote('Priya works the Renewals project in Linear.'),
        }),
        mateoCard: await ctx.db.insert('surfaces', {
          ...card,
          agentId: mateo,
          discoveryEvidence: charterQuote('Mateo keeps the tickets moving in Linear.'),
        }),
        chatCard: await ctx.db.insert('surfaces', {
          ...card,
          agentId: priya,
          slug: 'slack',
          displayName: 'Slack',
          class: 'chat',
        }),
        declaredCard: await ctx.db.insert('surfaces', {
          ...card,
          agentId: mateo,
          slug: 'jira',
          displayName: 'Jira',
          verdict: 'declared',
        }),
      };
    });
  }

  async function scopes(
    harness: Harness,
    cards: Record<string, Id<'surfaces'>>,
  ): Promise<Record<string, Doc<'surfaces'>['intakeScope'] | null>> {
    return await harness.run(async (ctx) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(cards).map(async ([name, id]) => [
            name,
            (await ctx.db.get(id))?.intakeScope ?? null,
          ]),
        ),
      ),
    );
  }

  it('is registered at 0.15.0, after the owner key, and runs in the Node runtime', (): void => {
    expect(MIGRATIONS['surfaces-intake-scope'].release).toBe('0.15.0');
    expect(MIGRATION_NAMES.indexOf('surfaces-intake-scope')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('skills-owner-key'),
    );
  });

  it("scopes a card older than the field from the manager's own words, leaves one they do not scope on the page scan, and is safe to run twice", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = limitedHarness();
    const cards = await seedCards(harness);

    await runAll(harness);

    const read = await scopes(harness, cards);
    expect(read.priyaCard).toEqual({
      project: {
        value: 'Renewals',
        sourceId: expect.any(String),
        ref: 'linear.md',
        quote: '- Project: `Renewals`',
      },
      notes: [upgradeScopeNote('Linear')],
    });
    expect(read.mateoCard).toBeNull();
    expect(read.chatCard).toBeNull();
    expect(read.declaredCard).toBeNull();
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'surfaces-intake-scope')).toMatchObject({
      release: '0.15.0',
      changed: 1,
      note: expect.stringContaining('keeps the page scan'),
    });
    await expect(harness.action(internal.migrations.runPending, {})).resolves.toEqual({
      migrations: [],
      pending: [],
    });
    expect(await scopes(harness, cards)).toEqual(read);
  });

  it('reads no card in mock mode, where intake reads the mock office', async (): Promise<void> => {
    const harness = limitedHarness();
    const cards = await seedCards(harness);

    await runAll(harness);

    expect(Object.values(await scopes(harness, cards))).toEqual([null, null, null, null]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'surfaces-intake-scope')).toMatchObject({
      changed: 0,
      note: expect.stringContaining('mock mode'),
    });
  });
});

describe('the decision close record (12-W, N-3; 12-S3)', (): void => {
  // Re-pinned at 13-K: the sync runs refs clearing it followed left the list with the declaration
  // it cleared (`RETIRED_DECLARATIONS`), so the pass now follows the access follow-up passes.
  it('is registered at 0.16.0, after the access follow-up passes', (): void => {
    expect(MIGRATIONS['work-decision-closed'].release).toBe('0.16.0');
    expect(MIGRATION_NAMES.indexOf('work-decision-closed')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('credentials-organisation-purge'),
    );
  });

  it('records every close edit claimed before the release as made, leaves every other row, and is safe to run twice', async (): Promise<void> => {
    const harness = limitedHarness();
    const priya = await agent(harness, { userId: 'owner' });
    const decision = {
      id: 'abc234',
      kind: 'plan' as const,
      requestedAt: 2,
      channel: 'D0123',
      surfaceSlug: 'slack',
      surfaceName: 'Slack',
      ts: '1700000000.000100',
      decidedAt: 3,
      outcome: 'approved' as const,
    };
    const rows = await harness.run(async (ctx) => {
      const row = (externalId: string, fields: Partial<Doc<'workItems'>> = {}) => ({
        agentId: priya,
        sourceCategory: 'ticket',
        sourceSystem: 'linear',
        externalId,
        title: externalId,
        contentSummary: externalId,
        contentRefs: [],
        state: 'completed' as const,
        observedAt: 1,
        createdAt: 1,
        ...fields,
      });
      return {
        claimed: await ctx.db.insert(
          'workItems',
          row('REVOPS-1', { decision: { ...decision, closeClaimedAt: 4 } }),
        ),
        failed: await ctx.db.insert(
          'workItems',
          row('REVOPS-2', {
            decision: { ...decision, id: 'abc235', closeClaimedAt: 4, closeFailure: 'gone' },
          }),
        ),
        unclaimed: await ctx.db.insert(
          'workItems',
          row('REVOPS-3', { decision: { ...decision, id: 'abc236' } }),
        ),
        none: await ctx.db.insert('workItems', row('REVOPS-4')),
      };
    });
    const read = async (): Promise<Record<string, unknown>> =>
      await harness.run(async (ctx) =>
        Object.fromEntries(
          await Promise.all(
            Object.entries(rows).map(async ([name, id]) => {
              const found = (await ctx.db.get(id))?.decision;
              return [
                name,
                found
                  ? { closedAt: found.closedAt ?? null, failure: found.closeFailure ?? null }
                  : null,
              ];
            }),
          ),
        ),
      );
    const recorded = {
      claimed: { closedAt: 4, failure: null },
      failed: { closedAt: null, failure: 'gone' },
      unclaimed: { closedAt: null, failure: null },
      none: null,
    };

    await runAll(harness);

    expect(await read()).toEqual(recorded);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'work-decision-closed')).toMatchObject({
      release: '0.16.0',
      read: 4,
      changed: 1,
      completedAt: expect.any(Number),
    });
    await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('migrations')
        .withIndex('by_name', (q) => q.eq('name', 'work-decision-closed'))
        .unique();
      if (row !== null) await ctx.db.delete(row._id);
    });
    await expect(
      harness.mutation(internal.migrations.runMigrationPage, { name: 'work-decision-closed' }),
    ).resolves.toMatchObject({ read: 4, changed: 0 });
    expect(await read()).toEqual(recorded);
  });
});

describe('the kept identity mark pass, retired at 0.18.0 with the reason-word fallback (N10, 14-I)', (): void => {
  it('leaves the list: 0.17.0 marked every kept card, and a stamp waits for every pass', (): void => {
    expect(MIGRATION_NAMES).not.toContain('surfaces-kept-identity-since');
    expect(Object.keys(MIGRATIONS)).not.toContain('surfaces-kept-identity-since');
  });

  // Re-pinned at 0.19.0 (15-K): the stamp names the newest release a shipped migration names.
  it("runs every pass and stamps the newest release over a 0.17.0 deployment's finished row of it", async (): Promise<void> => {
    const harness = limitedHarness();
    await harness.run(async (ctx) => {
      await ctx.db.insert('migrations', {
        name: 'surfaces-kept-identity-since',
        release: '0.17.0',
        read: 2,
        changed: 1,
        startedAt: 1,
        completedAt: 2,
      });
    });
    await runAll(harness);
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: NEWEST_MIGRATION_RELEASE }),
    ).resolves.toMatchObject({ release: NEWEST_MIGRATION_RELEASE });
  });
});

describe('the messages tab and not-their-address passes, retired at 0.19.0 (N10, 15-K)', (): void => {
  it('leave the list with their pages: 0.18.0 ran both, and a stamp waits for every pass', async (): Promise<void> => {
    for (const name of ['surfaces-messages-tab', 'people-not-their-addresses']) {
      expect(MIGRATION_NAMES, name).not.toContain(name);
      expect(Object.keys(MIGRATIONS), name).not.toContain(name);
    }
    // Their pages went with them: nothing but the passes read either.
    expect(await import('../../convex/slackMessagesTab')).not.toHaveProperty(
      'backfillMessagesTabPage',
    );
    expect(await import('../../convex/peopleProposals')).not.toHaveProperty('notTheirAddresses');
  });

  it("runs every pass and stamps 0.19.0 over a 0.18.0 deployment's finished rows of both, its marked person unchanged", async (): Promise<void> => {
    const harness = limitedHarness();
    const person = await harness.run(async (ctx) => {
      for (const [name, release] of [
        ['surfaces-messages-tab', '0.17.0'],
        ['people-not-their-addresses', '0.18.0'],
      ] as const) {
        await ctx.db.insert('migrations', {
          name,
          release,
          read: 1,
          changed: 1,
          startedAt: 1,
          completedAt: 2,
        });
      }
      // As 0.18.0 left a person the manager said an address was not: the marker kept beside the
      // field the pass filled, the evidence line the card shows.
      return await ctx.db.insert('people', {
        userId: 'owner',
        displayName: 'Aiko Tanaka',
        nameKey: 'aiko tanaka',
        status: 'active',
        source: 'documentation',
        evidence: [
          {
            quote: 'aiko@other.example is not Aiko Tanaka',
            where: 'A different person',
            at: 3,
            ref: 'not-their-address:aiko@other.example',
          },
        ],
        notTheirAddresses: ['aiko@other.example'],
        createdAt: 1,
        updatedAt: 3,
      });
    });
    const before = await harness.run(async (ctx) => await ctx.db.get(person));
    await runAll(harness);
    await expect(
      harness.mutation(internal.migrations.recordRelease, { release: '0.19.0' }),
    ).resolves.toMatchObject({ release: '0.19.0' });
    expect(await harness.run(async (ctx) => await ctx.db.get(person))).toEqual(before);
    const rows = await harness.run(async (ctx) => await ctx.db.query('migrations').collect());
    expect(
      rows
        .filter((row) => ['surfaces-messages-tab', 'people-not-their-addresses'].includes(row.name))
        .map((row) => [row.name, row.release, row.completedAt]),
    ).toEqual([
      ['surfaces-messages-tab', '0.17.0', 2],
      ['people-not-their-addresses', '0.18.0', 2],
    ]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.map((row) => row.name)).not.toContain('people-not-their-addresses');
  });
});

describe('the owner person at the upgrade (13-K)', (): void => {
  it('writes nothing before the owner signs in: every pass leaves the people graph empty', async (): Promise<void> => {
    const harness = limitedHarness();
    const priya = await agent(harness, { userId: 'owner' });
    await harness.run(async (ctx) => {
      await ctx.db.insert('surfaces', {
        agentId: priya,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        managerUserId: 'U0BOSS',
        providerWorkspaceId: 'T0123',
        createdAt: 1,
      });
    });

    await runAll(harness);
    await runAll(harness);

    const graph = await harness.run(async (ctx) => ({
      people: await ctx.db.query('people').collect(),
      identities: await ctx.db.query('personIdentities').collect(),
    }));
    expect(graph).toEqual({ people: [], identities: [] });
  });
});

/** A completed run of a source, made its last completed sync. */
async function completedRun(
  harness: Harness,
  sourceId: Id<'docSources'>,
): Promise<Id<'docSyncRuns'>> {
  return await harness.run(async (ctx) => {
    const runId = await ctx.db.insert('docSyncRuns', {
      sourceId,
      listing: 1,
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
      state: 'completed',
      createdAt: 2,
    });
    await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
    return runId;
  });
}

/** A stored page of a source, written in its own transaction. */
async function storedPage(
  harness: Harness,
  page: { sourceId: Id<'docSources'>; ref: string; markdown: string },
): Promise<void> {
  await harness.run(async (ctx) => {
    await ctx.db.insert('docPages', { ...page, title: page.ref, updatedAt: 3 });
  });
}

/** Five nested 200-character Han headings over 1,400 sections of their own, each with a line of text. */
function nestedHanPage(seed: number): string {
  const han = (length: number, offset: number): string =>
    Array.from({ length }, (_unused, index) =>
      String.fromCodePoint(0x4e00 + ((index * 7 + offset * 13) % 2_000)),
    ).join('');
  const outer = [1, 2, 3, 4, 5].map((level) => `${'#'.repeat(level)} ${han(200, seed + level)}`);
  const sections = Array.from(
    { length: 1_400 },
    (_unused, index) => `###### ${han(200, seed + index)}\n\n${han(4, index)}`,
  );
  return [...outer, ...sections].join('\n\n');
}

describe('the block backfill (14-I)', (): void => {
  // Re-pinned at 0.19.0: the newest release a migration names is document authority's (15-K).
  it('is registered at 0.18.0 after the wave 13 passes', (): void => {
    expect(MIGRATIONS['docs-backfill-blocks'].release).toBe('0.18.0');
    // Re-pinned at 0.19.0: the 0.17.0 pass it followed left the list (15-K).
    expect(MIGRATION_NAMES.indexOf('docs-backfill-blocks')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('work-decision-closed'),
    );
  });

  it('splits every stored page as stored, redacting nothing and asking no component, and is safe to run twice', async (): Promise<void> => {
    // Nothing may be redacted: every request the pass made would land here and fail it.
    const reached: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL): Promise<Response> => {
      reached.push(String(input));
      throw new Error('the backfill must not call out');
    });
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const { runId, olderSource } = await harness.run(async (ctx) => {
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        listing: 1,
        credentialRefs: [],
        pageCount: 3,
        redactionCount: 1,
        state: 'completed',
        createdAt: 2,
      });
      await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
      const page = (ref: string, markdown: string) => ({
        sourceId,
        ref,
        title: ref,
        markdown,
        updatedAt: 3,
      });
      await ctx.db.insert(
        'docPages',
        page('refresh.md', '# Refresh\n\nToken: <credential: linear service token, stored>'),
      );
      await ctx.db.insert(
        'docPages',
        page('看板.md', '# 看板\n\n请刷新管道看板然后在频道里发布结果'),
      );
      await ctx.db.insert('docPages', page('empty.md', '# Only a heading'));
      // A source whose first sync is still running holds pages too; its running run stands for them.
      const olderSource = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Older',
        kind: 'folder',
        locator: 'older',
        status: 'linking',
        createdAt: 1,
        updatedAt: 1,
      });
      const running = await ctx.db.insert('docSyncRuns', {
        sourceId: olderSource,
        listing: 1,
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
        state: 'running',
        createdAt: 4,
      });
      await ctx.db.patch(olderSource, { activeSyncId: running });
      await ctx.db.insert('docPages', {
        sourceId: olderSource,
        ref: 'a.md',
        title: 'A',
        markdown: '# A\n\nAlpha.',
        updatedAt: 4,
      });
      return { runId, olderSource };
    });

    await runAll(harness);

    const blocks = await harness.run(async (ctx) => await ctx.db.query('docBlocks').collect());
    expect(
      blocks
        .filter((block) => block.sourceId === sourceId)
        .map((block) => [block.pageRef, block.text, block.generation, block.userId]),
    ).toEqual(
      expect.arrayContaining([
        ['refresh.md', 'Token: <credential: linear service token, stored>', runId, 'owner'],
        ['看板.md', '请刷新管道看板然后在频道里发布结果', runId, 'owner'],
      ]),
    );
    expect(blocks).toHaveLength(3);
    expect(blocks.find((block) => block.sourceId === olderSource)?.text).toBe('Alpha.');
    expect(blocks.find((block) => block.pageRef === '看板.md')?.searchText).toContain(
      '管道 道看 看板',
    );
    expect(reached).toEqual([]);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'docs-backfill-blocks')).toMatchObject({
      release: '0.18.0',
      read: 4,
      changed: 3,
    });
    await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('migrations')
        .withIndex('by_name', (q) => q.eq('name', 'docs-backfill-blocks'))
        .unique();
      if (row !== null) await ctx.db.delete(row._id);
    });
    // One stored page a call since W14-R1, so the second run takes four calls to finish.
    let second = await harness.mutation(internal.migrations.runMigrationPage, {
      name: 'docs-backfill-blocks',
    });
    while (second.completedAt === undefined) {
      second = await harness.mutation(internal.migrations.runMigrationPage, {
        name: 'docs-backfill-blocks',
      });
    }
    expect(second).toMatchObject({ read: 4, changed: 0, completedAt: expect.any(Number) });
    expect(await harness.run(async (ctx) => await ctx.db.query('docBlocks').collect())).toEqual(
      blocks,
    );
    vi.unstubAllGlobals();
  });

  it("splits pages dense with blocks inside a transaction's write and read limits, twice (second pass)", async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    // Each page is 1,400 one-line sections: 1,400 blocks, near the bound a page may split into.
    const dense = Array.from(
      { length: 1_400 },
      (_unused, index) => `## ${index}\n\nx${index}`,
    ).join('\n\n');
    await harness.run(async (ctx) => {
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        listing: 1,
        credentialRefs: [],
        pageCount: 12,
        redactionCount: 0,
        state: 'completed',
        createdAt: 2,
      });
      await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
      for (let index = 0; index < 12; index += 1) {
        await ctx.db.insert('docPages', {
          sourceId,
          ref: `dense-${index}.md`,
          title: `Dense ${index}`,
          markdown: dense,
          updatedAt: 3,
        });
      }
    });
    await runAll(harness);
    const count = async (): Promise<number> =>
      await harness.run(async (ctx) => (await ctx.db.query('docBlocks').collect()).length);
    expect(await count()).toBe(12 * 1_400);
    await harness.run(async (ctx) => {
      const row = await ctx.db
        .query('migrations')
        .withIndex('by_name', (q) => q.eq('name', 'docs-backfill-blocks'))
        .unique();
      if (row !== null) await ctx.db.delete(row._id);
    });
    await runAll(harness);
    expect(await count()).toBe(12 * 1_400);
  }, 120_000);

  it("splits pages of long nested CJK headings inside a transaction's limits (W14-R1)", async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const runId = await completedRun(harness, sourceId);
    // Reader 1's probe: five nested 200-character Han headings over 1,400 more of their own, so
    // every block's path held 1,200 characters, twice, with its bigrams: past 16 MiB of rows a page.
    for (const ref of ['nested-a.md', 'nested-b.md']) {
      await storedPage(harness, { sourceId, ref, markdown: nestedHanPage(ref.length) });
    }
    await runAll(harness);
    const blocks = await harness.run(async (ctx) => await ctx.db.query('docBlocks').collect());
    expect(blocks).toHaveLength(2 * 1_400);
    expect(blocks.every((block) => block.generation === runId)).toBe(true);
    expect(Math.max(...blocks.map((block) => block.headingPath.join('').length))).toBe(300);
  }, 120_000);

  it('records a page it cannot split in the pass’s note and goes on to the next (W14-R1)', async (): Promise<void> => {
    // A tighter write limit than the backend's stands in for a page whose rows pass it.
    const harness = convexTest({
      schema,
      modules: allConvexModules(),
      transactionLimits: { bytesWritten: 1024 * 1024 },
    });
    const sourceId = await source(harness, 'owner');
    await completedRun(harness, sourceId);
    await storedPage(harness, { sourceId, ref: 'before.md', markdown: '# Before\n\nRead first.' });
    await storedPage(harness, {
      sourceId,
      ref: 'too-large.md',
      markdown: Array.from(
        { length: 300 },
        (_unused, index) => `## 第${index}节\n\n${'管道看板'.repeat(100)}`,
      ).join('\n\n'),
    });
    await storedPage(harness, { sourceId, ref: 'after.md', markdown: '# After\n\nRead on.' });
    await runAll(harness);
    const blocks = await harness.run(async (ctx) => await ctx.db.query('docBlocks').collect());
    expect([...new Set(blocks.map((block) => block.pageRef))].sort()).toEqual([
      'after.md',
      'before.md',
    ]);
    const status = await harness.query(internal.migrations.status, {});
    const row = status.migrations.find((entry) => entry.name === 'docs-backfill-blocks');
    expect(row).toMatchObject({ read: 3, changed: 2, completedAt: expect.any(Number) });
    expect(row?.note).toBe(
      '1 page could not be split into sections for the documentation search, so the search does not find it: too-large.md.',
    );
  }, 120_000);

  it('counts every page it passed over and names the first ten (W14-R1)', (): void => {
    let note: string | undefined;
    for (let index = 0; index < 12; index += 1) note = passedOverNote(note, `p${index}.md`);
    expect(note).toBe(
      '12 pages could not be split into sections for the documentation search, so the search does not find them: p0.md, p1.md, p2.md, p3.md, p4.md, p5.md, p6.md, p7.md, p8.md, p9.md and 2 more.',
    );
  });

  it('reads nothing on a deployment that stores no page, as the hosted mock deployment does', async (): Promise<void> => {
    const harness = limitedHarness();
    await agent(harness, { userId: 'owner' });
    await runAll(harness);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'docs-backfill-blocks')).toMatchObject({
      read: 0,
      changed: 0,
    });
  });
});

describe('the block status pass (15-K; K-1)', (): void => {
  /** Every block's page and status, in page order, read a page at a time inside the read limit. */
  const blockStatuses = async (harness: Harness): Promise<Array<[string, string | undefined]>> => {
    const statuses: Array<[string, string | undefined]> = [];
    let cursor: string | null = null;
    for (;;) {
      const page: { page: Doc<'docBlocks'>[]; isDone: boolean; continueCursor: string } =
        await harness.run(
          async (ctx) => await ctx.db.query('docBlocks').paginate({ numItems: 500, cursor }),
        );
      statuses.push(
        ...page.page.map((block): [string, string | undefined] => [block.pageRef, block.status]),
      );
      if (page.isDone) return statuses.sort(([a], [b]) => a.localeCompare(b));
      cursor = page.continueCursor;
    }
  };

  /**
   * Split the stored pages as 0.18.0 left their blocks: by the block backfill, run to its end,
   * then with the status taken off each block again. Re-pinned by 15-A: the block writer now
   * carries its page's status (`replacePageBlocks`), so the tip's own split cannot store a block
   * the way 0.18.0 did, and the pass's input has to be made by hand.
   */
  const splitAsBefore019 = async (harness: Harness): Promise<void> => {
    for (;;) {
      const progress = await harness.mutation(internal.migrations.runMigrationPage, {
        name: 'docs-backfill-blocks',
      });
      if (progress.completedAt !== undefined) break;
    }
    await harness.run(async (ctx) => {
      for (const block of await ctx.db.query('docBlocks').collect()) {
        await ctx.db.patch(block._id, { status: undefined });
      }
    });
  };

  it('is registered at 0.19.0 after the block backfill, the newest release any migration names', (): void => {
    expect(MIGRATIONS['docs-blocks-status'].release).toBe('0.19.0');
    expect(NEWEST_MIGRATION_RELEASE).toBe('0.19.0');
    expect(MIGRATION_NAMES.indexOf('docs-blocks-status')).toBeGreaterThan(
      MIGRATION_NAMES.indexOf('docs-backfill-blocks'),
    );
  });

  it("writes active on every block, the status every page had before 0.19.0, leaves a block's own status, and is safe to run twice", async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const runId = await completedRun(harness, sourceId);
    await storedPage(harness, {
      sourceId,
      ref: 'a.md',
      markdown: '# A\n\nAlpha.\n\n## B\n\nBeta.',
    });
    await storedPage(harness, { sourceId, ref: 'c.md', markdown: '# C\n\nGamma.' });
    await splitAsBefore019(harness);
    // A block a split wrote with its page's status after the push and before the pass ran.
    await harness.run(async (ctx) => {
      await ctx.db.insert('docBlocks', {
        userId: 'owner',
        sourceId,
        pageRef: 'd.md',
        generation: runId,
        index: 0,
        headingPath: ['D'],
        text: 'Delta.',
        searchText: 'D\nDelta.',
        kind: 'text',
        hash: 'd'.repeat(64),
        chars: 6,
        status: 'draft',
      });
    });
    await runAll(harness);
    expect(await blockStatuses(harness)).toEqual([
      ['a.md', 'active'],
      ['a.md', 'active'],
      ['c.md', 'active'],
      ['d.md', 'draft'],
    ]);
    const row = async () =>
      (await harness.query(internal.migrations.status, {})).migrations.find(
        (entry) => entry.name === 'docs-blocks-status',
      );
    expect(await row()).toMatchObject({
      release: '0.19.0',
      read: 4,
      changed: 3,
      completedAt: expect.any(Number),
    });
    await harness.run(async (ctx) => {
      const done = await ctx.db
        .query('migrations')
        .withIndex('by_name', (q) => q.eq('name', 'docs-blocks-status'))
        .unique();
      if (done !== null) await ctx.db.delete(done._id);
    });
    await expect(
      harness.mutation(internal.migrations.runMigrationPage, { name: 'docs-blocks-status' }),
    ).resolves.toMatchObject({ read: 4, changed: 0 });
  });

  it("finds an active block by the search's status filter once the pass has run, and none before", async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    await completedRun(harness, sourceId);
    await storedPage(harness, {
      sourceId,
      ref: 'refresh.md',
      markdown: '# Refreshing the tile\n\nPress Refresh twice.',
    });
    const found = async (): Promise<string[]> =>
      await harness.run(async (ctx) =>
        (
          await ctx.db
            .query('docBlocks')
            .withSearchIndex('by_text', (q) =>
              q
                .search('searchText', 'refresh')
                .eq('userId', 'owner')
                .eq('sourceId', sourceId)
                .eq('status', 'active'),
            )
            .take(12)
        ).map((block) => block.pageRef),
      );
    await splitAsBefore019(harness);
    expect(await found()).toEqual([]);
    await runAll(harness);
    expect(await found()).toEqual(['refresh.md']);
  });

  it("stamps blocks dense enough to pass a transaction's limits in one read, a bounded page at a time", async (): Promise<void> => {
    const harness = limitedHarness();
    const sourceId = await source(harness, 'owner');
    const runId = await completedRun(harness, sourceId);
    // 2,500 blocks of about 3 KiB of Han text and its bigrams: more than one page's byte bound.
    const han = '管道看板'.repeat(250);
    for (let start = 0; start < 2_500; start += 500) {
      await harness.run(async (ctx) => {
        for (let index = start; index < start + 500; index += 1) {
          await ctx.db.insert('docBlocks', {
            userId: 'owner',
            sourceId,
            pageRef: `dense-${Math.floor(index / 100)}.md`,
            generation: runId,
            index: index % 100,
            headingPath: ['Dense'],
            text: han,
            searchText: `Dense\n${han}\n${han}`,
            kind: 'text',
            hash: index.toString(16).padStart(64, '0'),
            chars: han.length,
          });
        }
      });
    }
    await runAll(harness);
    const statuses = await blockStatuses(harness);
    expect(statuses).toHaveLength(2_500);
    expect(statuses.every(([, status]) => status === 'active')).toBe(true);
  }, 120_000);

  it('reads nothing on a deployment that stores no block, as the hosted mock deployment does', async (): Promise<void> => {
    const harness = limitedHarness();
    await agent(harness, { userId: 'owner' });
    await runAll(harness);
    const status = await harness.query(internal.migrations.status, {});
    expect(status.migrations.find((row) => row.name === 'docs-blocks-status')).toMatchObject({
      read: 0,
      changed: 0,
      completedAt: expect.any(Number),
    });
  });
});

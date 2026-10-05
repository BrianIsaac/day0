/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { socketBridgeStateOf } from '../../convex/socketHeartbeats';
import {
  SOCKET_HEARTBEAT_FRESH_MS,
  SOCKET_HEARTBEAT_REFRESH_MS,
} from '../../src/surfaces/slack-socket';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { reportBridgeOn } from './fakes/socket-heartbeat';

/*
 * The Socket Mode bridge's heartbeat (wave 13, 13-FS; D-6 (b), W12-R16): what the backend keeps of
 * each report, one row per card written only when it says something new, and what a card reads
 * of it.
 */

beforeEach((): void => {
  vi.stubEnv('DAY0_SOCKET_BRIDGE_SECRET', 'bridge-secret-for-tests');
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** An employee with a connected Slack card whose own app holds its app-level token. */
async function seedCard(
  harness: TestConvex<typeof schema>,
): Promise<{ agentId: Id<'agents'>; surfaceId: Id<'surfaces'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Mateo',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const secret = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'client secret',
      ciphertext: 'c',
      iv: 'i',
      source: 'entered',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      managerDmChannelId: 'D0MANAGER',
      credentialLanded: true,
      provisioning: {
        appId: 'A0MATEO',
        appName: 'Mateo (Day0)',
        clientId: '1.2',
        clientSecretCredentialId: secret,
        installUrl: 'https://slack.com/oauth/v2/authorize',
        redirectUrl: 'https://day0.example/api/oauth/slack',
        scopes: [],
        createdAt: 1,
        installedAt: 2,
        appLevelTokenCredentialId: secret,
      },
      createdAt: 1,
    });
    return { agentId, surfaceId };
  });
}

async function rowsOf(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
): Promise<Doc<'socketHeartbeats'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('socketHeartbeats')
        .withIndex('by_surface', (q) => q.eq('surfaceId', surfaceId))
        .collect(),
  );
}

async function stateOf(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
): Promise<string> {
  return await harness.run(async (ctx) => {
    const surface = await ctx.db.get(surfaceId);
    if (surface === null) throw new Error('no card');
    return await socketBridgeStateOf(ctx, surface, Date.now());
  });
}

describe('recordHeartbeats', (): void => {
  it('keeps one row per card, with the app, its liveness and the bridge’s failure', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId } = await seedCard(harness);
    await expect(
      harness.mutation(internal.socketHeartbeats.recordHeartbeats, {
        reports: [
          {
            surfaceId,
            appId: 'A0MATEO',
            live: false,
            failure: 'no connection URL: invalid_auth',
          },
        ],
      }),
    ).resolves.toEqual({ written: 1 });
    expect(await rowsOf(harness, surfaceId)).toEqual([
      expect.objectContaining({
        agentId,
        surfaceId,
        appId: 'A0MATEO',
        live: false,
        failure: 'no connection URL: invalid_auth',
      }),
    ]);
    await harness.mutation(internal.socketHeartbeats.recordHeartbeats, {
      reports: [{ surfaceId, appId: 'A0MATEO', live: true, liveSince: 7 }],
    });
    const [row] = await rowsOf(harness, surfaceId);
    expect(row).toMatchObject({ live: true, liveSince: 7 });
    expect(row?.failure).toBeUndefined();
    expect(await rowsOf(harness, surfaceId)).toHaveLength(1);
  });

  it('writes an unchanged report again only once its row is about two minutes old', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    const young = Date.now() - 30_000;
    await reportBridgeOn(harness, surfaceId, { reportedAt: young });
    const report = { surfaceId, appId: 'A0MATEO', live: true, liveSince: young };
    await expect(
      harness.mutation(internal.socketHeartbeats.recordHeartbeats, { reports: [report] }),
    ).resolves.toEqual({ written: 0 });
    expect((await rowsOf(harness, surfaceId))[0]?.reportedAt).toBe(young);

    await harness.run(async (ctx) => {
      const [row] = await ctx.db
        .query('socketHeartbeats')
        .withIndex('by_surface', (q) => q.eq('surfaceId', surfaceId))
        .collect();
      await ctx.db.patch(row!._id, { reportedAt: Date.now() - SOCKET_HEARTBEAT_REFRESH_MS });
    });
    await expect(
      harness.mutation(internal.socketHeartbeats.recordHeartbeats, { reports: [report] }),
    ).resolves.toEqual({ written: 1 });
    expect((await rowsOf(harness, surfaceId))[0]?.reportedAt).toBeGreaterThan(young);
  });

  it('writes a change of liveness at once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    await reportBridgeOn(harness, surfaceId, { reportedAt: Date.now() - 10_000 });
    await expect(
      harness.mutation(internal.socketHeartbeats.recordHeartbeats, {
        reports: [{ surfaceId, appId: 'A0MATEO', live: false }],
      }),
    ).resolves.toEqual({ written: 1 });
    expect((await rowsOf(harness, surfaceId))[0]).toMatchObject({ live: false });
    expect((await rowsOf(harness, surfaceId))[0]?.liveSince).toBeUndefined();
  });

  it('writes nothing for a card id that names no chat card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedCard(harness);
    await expect(
      harness.mutation(internal.socketHeartbeats.recordHeartbeats, {
        reports: [
          { surfaceId: 'not-an-id', appId: 'A0MATEO', live: true },
          { surfaceId: agentId, appId: 'A0MATEO', live: true },
        ],
      }),
    ).resolves.toEqual({ written: 0 });
    expect(
      await harness.run(async (ctx) => await ctx.db.query('socketHeartbeats').collect()),
    ).toEqual([]);
  });
});

describe('socketBridgeStateOf', (): void => {
  it('reads the bridge as live for a card whose own app has a live and recent report', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    expect(await stateOf(harness, surfaceId)).toBe('down');
    await reportBridgeOn(harness, surfaceId);
    expect(await stateOf(harness, surfaceId)).toBe('live');
  });

  it('reads a report for another app, a stale one and one that is not live as down', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const other = await seedCard(harness);
    await reportBridgeOn(harness, other.surfaceId, { appId: 'A0SOMEONEELSE' });
    expect(await stateOf(harness, other.surfaceId)).toBe('down');
    const stale = await seedCard(harness);
    await reportBridgeOn(harness, stale.surfaceId, {
      reportedAt: Date.now() - SOCKET_HEARTBEAT_FRESH_MS - 1_000,
    });
    expect(await stateOf(harness, stale.surfaceId)).toBe('down');
    const off = await seedCard(harness);
    await reportBridgeOn(harness, off.surfaceId, { live: false });
    expect(await stateOf(harness, off.surfaceId)).toBe('down');
  });

  it('reads a deployment that holds no bridge secret as unconfigured', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    await reportBridgeOn(harness, surfaceId);
    vi.stubEnv('DAY0_SOCKET_BRIDGE_SECRET', '');
    expect(await stateOf(harness, surfaceId)).toBe('unconfigured');
  });
});

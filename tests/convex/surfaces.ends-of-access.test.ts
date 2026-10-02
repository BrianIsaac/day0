/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schemaModule from '../../convex/schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { managerIdentity } from './fakes/manager-identity';
import { stubVendorNetwork, type VendorNetwork } from './fakes/vendor-revocation';
import {
  CONFIGURATION_TOKEN,
  LEO_APP_ID,
  LEO_BOT_TOKEN,
  seedIssuedIdentities,
} from './fakes/issued-identities';
import { SLACK_AUTH_REVOKE_OK, SLACK_MANIFEST_DELETE_OK } from '../fixtures/revokers';

/*
 * The ends of access on a card (11-AR; the wave 11 file's 11-AR with the 1 October correction):
 * the manager's Disconnect, the expiry, the rejection, the renewal after them, and the
 * administrator's revoke of an organisation connection. What each does at the vendor is the
 * revokers' (`tests/convex/sourceRevocationActions.test.ts`); these read what the card and the
 * record say.
 */

type Schema = typeof schemaModule;

/** The administrator IT named at install (B8). */
const ADMINISTRATOR_ADDRESS = 'ines@acme.test';

/** Ines, signed in with that verified address. */
const ADMINISTRATOR = managerIdentity('ines', { email: ADMINISTRATOR_ADDRESS });

/** A real-mode harness, its modules loaded after the mode is set. */
async function realHarness(): Promise<TestConvex<Schema>> {
  const [{ default: schema }, { allConvexModules }] = await Promise.all([
    import('../../convex/schema'),
    import('./all-modules'),
  ]);
  return convexTest(schema, allConvexModules());
}

/** An employee's events of one type, oldest first. */
async function eventsOf(
  harness: TestConvex<Schema>,
  agentId: Id<'agents'>,
  type: string,
): Promise<unknown[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect())
      .filter((event) => event.agentId === agentId && event.type === type)
      .map((event) => event.payload as unknown),
  );
}

/** A row, read back whole. */
async function read<Table extends 'surfaces' | 'credentials'>(
  harness: TestConvex<Schema>,
  id: Id<Table>,
): Promise<Doc<Table> | null> {
  return await harness.run(async (ctx) => await ctx.db.get(id));
}

/** A card on a pasted Linear key, the employee's, linked to an organisation connection or not. */
async function pastedLinearCard(
  harness: TestConvex<Schema>,
  agentId: Id<'agents'>,
  organisationConnectionId?: Id<'organisationConnections'>,
): Promise<{ readonly surfaceId: Id<'surfaces'>; readonly key: Id<'credentials'> }> {
  return await harness.run(async (ctx) => {
    const key = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'Linear access',
      ciphertext: 'sealed',
      iv: 'iv',
      source: 'entered',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear-pasted',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      whereFound: [],
      credentialLanded: true,
      credentialId: key,
      credentialKind: 'value',
      managerApprovedAt: 1,
      createdAt: 1,
      ...(organisationConnectionId !== undefined ? { organisationConnectionId } : {}),
    });
    return { surfaceId, key };
  });
}

describe('the ends of access on a card (11-AR)', (): void => {
  let network: VendorNetwork;

  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    vi.useFakeTimers();
    network = stubVendorNetwork();
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreSurfaceMode();
  });

  it('disconnect and expiry revoke the Slack bot token and keep the app; the record says its channel memberships were removed', async (): Promise<void> => {
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });
    for (const how of ['disconnect', 'expiry'] as const) {
      const harness = await realHarness();
      const leo = await seedIssuedIdentities(harness, { connection: true });
      network.calls.length = 0;
      if (how === 'disconnect') {
        await harness
          .withIdentity(managerIdentity())
          .mutation(api.surfaces.disconnect, { surfaceId: leo.slack.surfaceId });
      } else {
        await harness.run(
          async (ctx) => await ctx.db.patch(leo.slack.surfaceId, { expiresAt: Date.now() - 1 }),
        );
        await harness.mutation(internal.surfaces.recordExpired, {
          surfaceId: leo.slack.surfaceId,
          now: Date.now(),
        });
      }
      await harness.finishAllScheduledFunctions(vi.runAllTimers);

      expect(network.calls).toEqual([
        {
          url: 'https://slack.com/api/auth.revoke',
          authorization: `Bearer ${LEO_BOT_TOKEN}`,
          form: {},
        },
      ]);
      const card = await read(harness, leo.slack.surfaceId);
      // The card no longer holds the token, and keeps the app the renewal reinstalls.
      expect(card?.credentialId).toBeUndefined();
      expect(card?.credentialLanded).toBe(false);
      expect(card?.provisioning?.appId).toBe(LEO_APP_ID);
      expect(card?.verdict).toBe('approved');
      const secret = await read(harness, leo.slack.secret);
      expect(secret?.revokedAt).toBeUndefined();
      expect(await eventsOf(harness, leo.agentId, 'credential.revoked-at-source')).toEqual([
        expect.objectContaining({
          surfaceId: leo.slack.surfaceId,
          system: 'slack',
          end: how,
          outcome: 'token-revoked',
          channelMembershipsRemoved: true,
        }),
      ]);
      expect(await eventsOf(harness, leo.agentId, 'surface.disconnected')).toEqual(
        how === 'disconnect' ? [{ surfaceId: leo.slack.surfaceId, by: 'manager' }] : [],
      );
    }
  });

  it("disconnect revokes the bot token of an identity the organisation holds, as it does the owner's", async (): Promise<void> => {
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true, heldBy: 'organisation' });

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.disconnect, { surfaceId: leo.slack.surfaceId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([
      {
        url: 'https://slack.com/api/auth.revoke',
        authorization: `Bearer ${LEO_BOT_TOKEN}`,
        form: {},
      },
    ]);
    expect((await read(harness, leo.slack.token))?.sourceRevocation?.state).toBe('done');
    expect((await read(harness, leo.slack.secret))?.revokedAt).toBeUndefined();
    expect(await eventsOf(harness, leo.agentId, 'credential.revoked-at-source')).toEqual([
      expect.objectContaining({ system: 'slack', end: 'disconnect', outcome: 'token-revoked' }),
    ]);
  });

  it('disconnects a pasted-key card without sending the key anywhere, and keeps it in the owner’s store', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: false });
    const pasted = await pastedLinearCard(harness, leo.agentId);

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.disconnect, { surfaceId: pasted.surfaceId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([]);
    expect((await read(harness, pasted.surfaceId))?.credentialId).toBeUndefined();
    const key = await read(harness, pasted.key);
    expect(key?.revokedAt).toBeUndefined();
    expect(key?.sourceRevocation).toBeUndefined();
    expect(await eventsOf(harness, leo.agentId, 'credential.revoked-at-source')).toEqual([
      expect.objectContaining({ system: 'Linear', end: 'disconnect', outcome: 'pasted-key' }),
    ]);
  });

  it("refuses another owner's Disconnect, and one on a card that holds nothing", async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: false });
    await expect(
      harness
        .withIdentity(managerIdentity('stranger'))
        .mutation(api.surfaces.disconnect, { surfaceId: leo.slack.surfaceId }),
    ).rejects.toThrow();
    await harness.run(
      async (ctx) => await ctx.db.patch(leo.linear.surfaceId, { credentialId: undefined }),
    );
    await expect(
      harness
        .withIdentity(managerIdentity())
        .mutation(api.surfaces.disconnect, { surfaceId: leo.linear.surfaceId }),
    ).rejects.toMatchObject({ data: 'This connection holds no credential to disconnect.' });
    expect(network.calls).toEqual([]);
  });

  it('deletes the app at a rejection, since the card forgets it', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    await harness.run(
      async (ctx) => await ctx.db.patch(leo.slack.surfaceId, { verdict: 'approved' }),
    );
    network.answer('/api/apps.manifest.delete', { status: 200, body: SLACK_MANIFEST_DELETE_OK });

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.reject, { surfaceId: leo.slack.surfaceId, reason: 'Not this one.' });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([
      {
        url: 'https://slack.com/api/apps.manifest.delete',
        authorization: `Bearer ${CONFIGURATION_TOKEN}`,
        form: { app_id: LEO_APP_ID },
      },
    ]);
    expect(await eventsOf(harness, leo.agentId, 'credential.revoked-at-source')).toEqual([
      expect.objectContaining({ end: 'reject', outcome: 'app-deleted' }),
    ]);
    const [token, secret] = await Promise.all([
      read(harness, leo.slack.token),
      read(harness, leo.slack.secret),
    ]);
    expect([token?.sourceRevocation?.state, secret?.sourceRevocation?.state]).toEqual([
      'done',
      'done',
    ]);
  });

  it('leaves a token another card still binds, and its pair, when one card is rejected', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: false });
    await harness.run(async (ctx) => {
      await ctx.db.patch(leo.linear.surfaceId, { verdict: 'approved' });
      await ctx.db.insert('surfaces', {
        agentId: leo.agentId,
        slug: 'linear-second',
        displayName: 'Linear (second team)',
        class: 'kanban',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        credentialId: leo.linear.access,
        credentialKind: 'oauth',
        createdAt: 1,
      });
    });

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.reject, { surfaceId: leo.linear.surfaceId, reason: 'One is enough.' });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([]);
    const [access, refresh] = await Promise.all([
      read(harness, leo.linear.access),
      read(harness, leo.linear.refresh),
    ]);
    expect([access?.sourceRevocation, refresh?.sourceRevocation]).toEqual([undefined, undefined]);
  });

  it('renews an ended card whose token was revoked at the vendor by asking for its install again, not a probe', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });
    await harness.run(
      async (ctx) => await ctx.db.patch(leo.slack.surfaceId, { expiresAt: Date.now() - 1 }),
    );
    await harness.mutation(internal.surfaces.recordExpired, {
      surfaceId: leo.slack.surfaceId,
      now: Date.now(),
    });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const renewal = await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.setAccessDays, { surfaceId: leo.slack.surfaceId, days: 30 });

    expect(renewal).toEqual({ expiresAt: expect.any(Number), reissue: 'install' });
    const card = await read(harness, leo.slack.surfaceId);
    expect(card).toMatchObject({ verdict: 'approved', expiresAt: renewal.expiresAt });
    expect(card?.reason).toBeUndefined();
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(
      scheduled.filter((job) => job.name.includes('probeInternal') && job.state.kind === 'pending'),
    ).toEqual([]);
    expect(await eventsOf(harness, leo.agentId, 'surface.access-set')).toEqual([
      expect.objectContaining({ by: 'manager', days: 30, renewed: true, reissue: 'install' }),
    ]);
  });

  it('renewing a pasted-key card whose system has an organisation connection offers the move', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    const linked = await pastedLinearCard(harness, leo.agentId, leo.connectionId);
    const alone = await harness.run(async (ctx) => {
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId: leo.agentId,
        slug: 'zendesk',
        displayName: 'Zendesk',
        class: 'helpdesk',
        verdict: 'approved',
        reason: 'expired',
        whereFound: [],
        credentialLanded: false,
        credentialId: linked.key,
        credentialKind: 'value',
        managerApprovedAt: 1,
        expiresAt: 1,
        createdAt: 1,
      });
      return surfaceId;
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(linked.surfaceId, {
        verdict: 'approved',
        reason: 'expired',
        expiresAt: 1,
      });
    });
    const owner = harness.withIdentity(managerIdentity());

    await expect(
      owner.mutation(api.surfaces.setAccessDays, { surfaceId: linked.surfaceId, days: 30 }),
    ).resolves.toEqual({ expiresAt: expect.any(Number), offer: 'own-identity' });
    await expect(
      owner.mutation(api.surfaces.setAccessDays, { surfaceId: alone, days: 30 }),
    ).resolves.toEqual({ expiresAt: expect.any(Number) });
    // The offer is an offer: the key keeps working until the manager moves the card (A27).
    expect((await read(harness, linked.surfaceId))?.credentialId).toBe(linked.key);
  });
});

describe('an organisation connection revoked by the administrator (11-AR over 11-AO; cross-unit test 3)', (): void => {
  let network: VendorNetwork;

  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    vi.useFakeTimers();
    network = stubVendorNetwork();
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    restoreSurfaceMode();
  });

  it('ends every card on the connection, each with the reason, and no card on another system', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });
    const connectionId = leo.connectionId;
    if (connectionId === undefined) throw new Error('The fixture made no connection.');

    const ended = await harness.run(async (ctx) => {
      const { endCardsOnConnection } = await import('../../convex/surfaces');
      return await endCardsOnConnection(ctx, {
        organisationConnectionId: connectionId,
        reason: 'Slack was disconnected for everyone by IT.',
        now: Date.now(),
      });
    });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(ended).toEqual([leo.slack.surfaceId]);
    const [slack, linear] = await Promise.all([
      read(harness, leo.slack.surfaceId),
      read(harness, leo.linear.surfaceId),
    ]);
    expect(slack).toMatchObject({
      verdict: 'approved',
      reason: 'Slack was disconnected for everyone by IT.',
      credentialLanded: false,
    });
    expect(slack?.credentialId).toBeUndefined();
    expect(linear).toMatchObject({ verdict: 'connected', credentialId: leo.linear.access });
    expect(await eventsOf(harness, leo.agentId, 'surface.disconnected')).toEqual([
      {
        surfaceId: leo.slack.surfaceId,
        by: 'organisation',
        reason: 'Slack was disconnected for everyone by IT.',
      },
    ]);
    expect(await eventsOf(harness, leo.agentId, 'credential.revoked-at-source')).toEqual([
      expect.objectContaining({ end: 'organisation-revoked', outcome: 'token-revoked' }),
    ]);
  });

  it("ends every card through the administrator's own revoke, in its transaction", async (): Promise<void> => {
    vi.stubEnv('DAY0_ADMINISTRATORS', ADMINISTRATOR_ADDRESS);
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });
    const connectionId = leo.connectionId;
    if (connectionId === undefined) throw new Error('The fixture made no connection.');

    await harness.withIdentity(ADMINISTRATOR).mutation(api.organisationConnections.revoke, {
      organisationConnectionId: connectionId,
      reason: 'Revoked by IT.',
    });
    // Ended in the revoke's own transaction, before any vendor answers.
    const slack = await read(harness, leo.slack.surfaceId);
    expect(slack).toMatchObject({
      verdict: 'approved',
      reason: 'Revoked by IT.',
      credentialLanded: false,
    });
    expect(slack?.credentialId).toBeUndefined();
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([
      {
        url: 'https://slack.com/api/auth.revoke',
        authorization: `Bearer ${LEO_BOT_TOKEN}`,
        form: {},
      },
    ]);
    expect((await read(harness, leo.linear.surfaceId))?.credentialId).toBe(leo.linear.access);
    expect(await eventsOf(harness, leo.agentId, 'surface.disconnected')).toEqual([
      { surfaceId: leo.slack.surfaceId, by: 'organisation', reason: 'Revoked by IT.' },
    ]);
    expect(await eventsOf(harness, leo.agentId, 'credential.revoked-at-source')).toEqual([
      expect.objectContaining({ end: 'organisation-revoked', outcome: 'token-revoked' }),
    ]);
  });
});

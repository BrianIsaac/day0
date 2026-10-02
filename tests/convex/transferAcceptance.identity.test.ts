/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schemaModule from '../../convex/schema';
import { HANDOVER_REAPPROVE_REASON } from '../../convex/surfaces';
import { transferExpiresAt } from '../../src/agent/manager-transfer';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, fixtureAddressOf, managerIdentity } from './fakes/manager-identity';
import { stubVendorNetwork, type VendorNetwork } from './fakes/vendor-revocation';
import {
  CONFIGURATION_TOKEN,
  LEO_APP_ID,
  LEO_BOT_TOKEN,
  LEO_LINEAR_ACCESS,
  LEO_LINEAR_REFRESH,
  seedIssuedIdentities,
  type IssuedIdentities,
} from './fakes/issued-identities';
import { SLACK_MANIFEST_DELETE_OK } from '../fixtures/revokers';

/*
 * A handover keeps the employee's own identities (A25; the access plan, section 4.12): a card
 * acting as the employee's own app obtained through IT's organisation connection keeps it and
 * returns to `proposed` for the new manager to re-approve, its token not revoked at the vendor
 * unless the new manager rejects it; a card on anything else is cut as D5 (a) rules, and the cut
 * revokes at the vendor what Day0 obtained for it, as a Disconnect does (the wave 11 review's M1,
 * decision 2 (a)).
 */

type Schema = typeof schemaModule;

/** The account the handover names. */
const COLLEAGUE = managerIdentity('colleague');

/** A real-mode harness, its modules loaded after the mode is set. */
async function realHarness(): Promise<TestConvex<Schema>> {
  const [{ default: schema }, { allConvexModules }] = await Promise.all([
    import('../../convex/schema'),
    import('./all-modules'),
  ]);
  return convexTest(schema, allConvexModules());
}

/** Ask for Leo's handover to the colleague and have the colleague accept it. */
async function handOverLeo(harness: TestConvex<Schema>, leo: IssuedIdentities): Promise<void> {
  const transferId = await harness.run(
    async (ctx) =>
      await ctx.db.insert('managerTransfers', {
        agentId: leo.agentId,
        agentName: 'Leo',
        fromOwnerKey: 'owner',
        fromAddress: MANAGER_ADDRESS,
        toAddress: fixtureAddressOf('colleague'),
        state: 'asked',
        requestedAt: Date.now(),
        expiresAt: transferExpiresAt(Date.now()),
      }),
  );
  await harness.withIdentity(COLLEAGUE).mutation(api.transferAcceptance.accept, { transferId });
}

/** A row, read back whole. */
async function read<Table extends 'surfaces' | 'credentials'>(
  harness: TestConvex<Schema>,
  id: Id<Table>,
): Promise<Doc<Table> | null> {
  return await harness.run(async (ctx) => await ctx.db.get(id));
}

/** The two calls a cut of Leo's own Linear app makes at Linear: the refresh token, then access. */
const LINEAR_CUT_CALLS = [
  {
    url: 'https://api.linear.app/oauth/revoke',
    form: { token: LEO_LINEAR_REFRESH, token_type_hint: 'refresh_token' },
  },
  {
    url: 'https://api.linear.app/oauth/revoke',
    form: { token: LEO_LINEAR_ACCESS, token_type_hint: 'access_token' },
  },
];

/** The calls the network saw, in a stable order, so several ends' calls compare as a set. */
function sortedCalls(calls: readonly unknown[]): unknown[] {
  return [...calls].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

/** Leo's ledger lines, oldest first. */
async function lines(harness: TestConvex<Schema>, agentId: Id<'agents'>): Promise<unknown[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect())
      .filter((event) => event.agentId === agentId && event.type === 'credential.revoked-at-source')
      .map((event) => event.payload as unknown),
  );
}

describe("the employee's own identity at a handover (A25)", (): void => {
  let network: VendorNetwork;

  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    vi.useFakeTimers();
    network = stubVendorNetwork();
    // The handover cuts Leo's own Linear app, which no organisation connection issued (M1).
    network.answer('/oauth/revoke', { status: 200, body: '' });
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreSurfaceMode();
  });

  it('a transfer keeps an organisation-backed identity, clears its approval and returns the card to proposed', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });

    await handOverLeo(harness, leo);
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const slack = await read(harness, leo.slack.surfaceId);
    expect(slack).toMatchObject({
      verdict: 'proposed',
      reason: HANDOVER_REAPPROVE_REASON,
      credentialId: leo.slack.token,
      credentialKind: 'oauth',
      actsAs: { kind: 'own-app', label: 'Leo (Day0)' },
      organisationConnectionId: leo.connectionId,
    });
    expect(slack?.managerApprovedAt).toBeUndefined();
    expect(slack?.provisioning?.appId).toBe(LEO_APP_ID);
    const token = await read(harness, leo.slack.token);
    expect(token?.revokedAt).toBeUndefined();
    expect(token?.ciphertext).toEqual(expect.any(String));
    // Nothing at the vendor for the kept identity; the cut one is revoked as a Disconnect would
    // (decision 2 (a)), and only it.
    expect(network.calls).toEqual(LINEAR_CUT_CALLS);

    // The Linear app was not obtained through an organisation connection: cut as D5 (a) rules.
    const linear = await read(harness, leo.linear.surfaceId);
    expect(linear).toMatchObject({ verdict: 'proposed' });
    expect(linear?.credentialId).toBeUndefined();
    const access = await read(harness, leo.linear.access);
    expect(access?.revokedAt).toEqual(expect.any(Number));
    expect(access?.ciphertext).toBeUndefined();
    expect(access?.sourceRevocation?.state).toBe('done');
    expect(await lines(harness, leo.agentId)).toEqual([
      expect.objectContaining({
        surfaceId: leo.linear.surfaceId,
        system: 'linear',
        end: 'transfer',
        outcome: 'token-revoked',
      }),
    ]);
  });

  it("revokes at the vendor a cut card's identity Day0 obtained, so the old manager's grant ends where it was given (M1)", async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: false });
    network.answer('/api/auth.revoke', { status: 200, body: { ok: true, revoked: true } });

    await handOverLeo(harness, leo);
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    // Neither card was obtained through IT's connection: both are cut, and each identity Day0
    // obtained is revoked at its vendor, the Slack app kept as a Disconnect keeps it.
    expect(sortedCalls(network.calls)).toEqual(
      sortedCalls([
        ...LINEAR_CUT_CALLS,
        {
          url: 'https://slack.com/api/auth.revoke',
          authorization: `Bearer ${LEO_BOT_TOKEN}`,
          form: {},
        },
      ]),
    );
    for (const id of [leo.slack.token, leo.linear.access]) {
      expect((await read(harness, id))?.sourceRevocation?.state).toBe('done');
    }
    expect(
      (await lines(harness, leo.agentId)).map((line) => {
        const { system, end, outcome } = line as { system: string; end: string; outcome: string };
        return [system, end, outcome];
      }),
    ).toEqual(
      expect.arrayContaining([
        ['linear', 'transfer', 'token-revoked'],
        ['slack', 'transfer', 'token-revoked'],
      ]),
    );
  });

  it('keeps the identity when the old manager later deletes their data, since it is no longer theirs to end', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    await handOverLeo(harness, leo);

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.reset.deleteMyData, { alsoUnlinkDocumentation: true });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const token = await read(harness, leo.slack.token);
    expect(token?.revokedAt).toBeUndefined();
    expect(token?.ciphertext).toEqual(expect.any(String));
    expect((await read(harness, leo.slack.surfaceId))?.credentialId).toBe(leo.slack.token);
    expect(network.calls).toEqual(LINEAR_CUT_CALLS);
  });

  it("keeps a disconnected identity's app secret when the old manager later deletes their data", async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    network.answer('/api/auth.revoke', { status: 200, body: { ok: true, revoked: true } });
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.disconnect, { surfaceId: leo.slack.surfaceId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    await handOverLeo(harness, leo);
    expect((await read(harness, leo.slack.surfaceId))?.verdict).toBe('proposed');

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.reset.deleteMyData, { alsoUnlinkDocumentation: true });

    const secret = await read(harness, leo.slack.secret);
    expect(secret?.revokedAt).toBeUndefined();
    expect(secret?.ciphertext).toEqual(expect.any(String));
  });

  it("keeps an identity the organisation holds at a handover and through the old manager's deletion", async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true, heldBy: 'organisation' });
    await handOverLeo(harness, leo);

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.reset.deleteMyData, { alsoUnlinkDocumentation: true });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await read(harness, leo.slack.surfaceId)).toMatchObject({
      verdict: 'proposed',
      reason: HANDOVER_REAPPROVE_REASON,
      credentialId: leo.slack.token,
    });
    for (const id of [leo.slack.token, leo.slack.secret]) {
      const row = await read(harness, id);
      expect(row?.revokedAt).toBeUndefined();
      expect(row?.ciphertext).toEqual(expect.any(String));
    }
    expect(network.calls).toEqual(LINEAR_CUT_CALLS);
  });

  it('deletes the app of an identity the organisation holds when the new manager rejects the card', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true, heldBy: 'organisation' });
    network.answer('/api/apps.manifest.delete', { status: 200, body: SLACK_MANIFEST_DELETE_OK });
    await handOverLeo(harness, leo);

    await harness
      .withIdentity(COLLEAGUE)
      .mutation(api.surfaces.reject, { surfaceId: leo.slack.surfaceId, reason: 'Not ours.' });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(sortedCalls(network.calls)).toEqual(
      sortedCalls([
        ...LINEAR_CUT_CALLS,
        {
          url: 'https://slack.com/api/apps.manifest.delete',
          authorization: `Bearer ${CONFIGURATION_TOKEN}`,
          form: { app_id: LEO_APP_ID },
        },
      ]),
    );
    expect((await read(harness, leo.slack.token))?.sourceRevocation?.state).toBe('done');
  });

  it('revokes the kept identity at the vendor when the new manager rejects the card', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    network.answer('/api/apps.manifest.delete', { status: 200, body: SLACK_MANIFEST_DELETE_OK });
    await handOverLeo(harness, leo);

    await harness
      .withIdentity(COLLEAGUE)
      .mutation(api.surfaces.reject, { surfaceId: leo.slack.surfaceId, reason: 'Not ours.' });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(sortedCalls(network.calls)).toEqual(
      sortedCalls([
        ...LINEAR_CUT_CALLS,
        {
          url: 'https://slack.com/api/apps.manifest.delete',
          authorization: `Bearer ${CONFIGURATION_TOKEN}`,
          form: { app_id: LEO_APP_ID },
        },
      ]),
    );
    expect(await lines(harness, leo.agentId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: 'slack', end: 'reject', outcome: 'app-deleted' }),
      ]),
    );
  });
});

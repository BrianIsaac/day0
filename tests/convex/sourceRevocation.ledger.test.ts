/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type schemaModule from '../../convex/schema';
import { transferExpiresAt } from '../../src/agent/manager-transfer';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, fixtureAddressOf, managerIdentity } from './fakes/manager-identity';
import { stubVendorNetwork, type VendorNetwork } from './fakes/vendor-revocation';
import { seedIssuedIdentities, type IssuedIdentities } from './fakes/issued-identities';
import {
  SLACK_AUTH_REVOKE_OK,
  SLACK_MANIFEST_DELETE_OK,
  SLACK_UNINSTALL_OK,
} from '../fixtures/revokers';

/*
 * The access plan's cross-unit test 2 (section 8), 11-AR's: "every end of access leaves one ledger
 * line per system". Expiry, Disconnect, the retire and the handover's cut, each over Leo's two
 * systems, each leaving one `credential.revoked-at-source` per system on his record and nothing
 * of either credential usable.
 */

type Schema = typeof schemaModule;

/** The ends the test walks, and how each is brought about. */
const ENDS = ['expiry', 'disconnect', 'retire', 'transfer'] as const;

/** A real-mode harness, its modules loaded after the mode is set. */
async function realHarness(): Promise<TestConvex<Schema>> {
  const [{ default: schema }, { allConvexModules }] = await Promise.all([
    import('../../convex/schema'),
    import('./all-modules'),
  ]);
  return convexTest(schema, allConvexModules());
}

/** Bring one end about over both of Leo's cards. */
async function endBoth(
  harness: TestConvex<Schema>,
  leo: IssuedIdentities,
  end: (typeof ENDS)[number],
): Promise<void> {
  const cards = [leo.slack.surfaceId, leo.linear.surfaceId];
  const owner = harness.withIdentity(managerIdentity());
  switch (end) {
    case 'expiry':
      for (const surfaceId of cards) {
        await harness.run(async (ctx) => await ctx.db.patch(surfaceId, { expiresAt: 1 }));
        await harness.mutation(internal.surfaces.recordExpired, { surfaceId, now: Date.now() });
      }
      return;
    case 'disconnect':
      for (const surfaceId of cards) await owner.mutation(api.surfaces.disconnect, { surfaceId });
      return;
    case 'retire':
      await owner.mutation(api.reset.retire, { agentId: leo.agentId });
      return;
    case 'transfer': {
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
      await harness
        .withIdentity(managerIdentity('colleague'))
        .mutation(api.transferAcceptance.accept, { transferId });
      return;
    }
  }
}

describe('every end of access leaves one ledger line per system (cross-unit test 2)', (): void => {
  let network: VendorNetwork;

  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    vi.useFakeTimers();
    network = stubVendorNetwork();
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });
    network.answer('/api/apps.manifest.delete', { status: 200, body: SLACK_MANIFEST_DELETE_OK });
    network.answer('/api/apps.uninstall', { status: 200, body: SLACK_UNINSTALL_OK });
    network.answer('/oauth/revoke', { status: 200, body: '' });
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreSurfaceMode();
  });

  it.each(ENDS)('%s', async (end): Promise<void> => {
    const harness = await realHarness();
    // Without IT's connection, so the handover cuts both cards rather than keeping Slack's.
    const leo = await seedIssuedIdentities(harness, { connection: false });

    await endBoth(harness, leo, end);
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const lines = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect())
        .filter(
          (event) => event.agentId === leo.agentId && event.type === 'credential.revoked-at-source',
        )
        .map((event) => event.payload as { system: string; end: string; outcome: string }),
    );
    expect(lines.map((line) => line.system).sort()).toEqual(['linear', 'slack']);
    expect(lines.every((line) => line.end === end)).toBe(true);
    const tokens: Id<'credentials'>[] = [leo.slack.token, leo.linear.access, leo.linear.refresh];
    for (const credentialId of tokens) {
      await expect(harness.action(internal.credentials.decrypt, { credentialId })).rejects.toThrow(
        'Credential is unavailable.',
      );
    }
  });
});

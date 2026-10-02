/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schemaModule from '../../convex/schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { managerIdentity } from './fakes/manager-identity';
import { stubVendorNetwork, type VendorNetwork } from './fakes/vendor-revocation';
import {
  CONFIGURATION_TOKEN,
  LEO_APP_ID,
  LEO_BOT_TOKEN,
  LEO_LINEAR_ACCESS,
  LEO_LINEAR_REFRESH,
  seedIssuedIdentities,
} from './fakes/issued-identities';
import { SLACK_MANIFEST_DELETE_OK } from '../fixtures/revokers';

/*
 * The retire's revocation at the vendor (11-AR; the access plan, section 4.4, with the 1 October
 * correction): what Day0 obtained for the employee is revoked at its vendor, a pasted key never.
 * Split from `reset.test.ts`, which holds the retire itself, to keep each file under a thousand
 * lines.
 */

type Schema = typeof schemaModule;

/** A real-mode harness, its modules loaded after the mode is set. */
async function realHarness(): Promise<TestConvex<Schema>> {
  const [{ default: schema }, { allConvexModules }] = await Promise.all([
    import('../../convex/schema'),
    import('./all-modules'),
  ]);
  return convexTest(schema, allConvexModules());
}

/** The ledger lines on an employee's record, oldest first. */
async function lines(harness: TestConvex<Schema>, agentId: Id<'agents'>): Promise<unknown[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect())
      .filter((event) => event.agentId === agentId && event.type === 'credential.revoked-at-source')
      .map((event) => event.payload as unknown),
  );
}

/** Some credential rows, read back whole. */
async function credentialRows(
  harness: TestConvex<Schema>,
  ids: readonly Id<'credentials'>[],
): Promise<(Doc<'credentials'> | null)[]> {
  return await harness.run(async (ctx) => await Promise.all(ids.map((id) => ctx.db.get(id))));
}

describe('the retire revokes at the vendor what Day0 obtained (11-AR)', (): void => {
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

  it("retire revokes the employee's own Linear app token and deletes its Slack app", async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });
    network.answer('/api/apps.manifest.delete', { status: 200, body: SLACK_MANIFEST_DELETE_OK });
    network.answer('/oauth/revoke', { status: 200, body: '' });

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.reset.retire, { agentId: leo.agentId });
    // Unusable from the retire's own transaction, before any vendor answers.
    const held = await credentialRows(harness, [leo.slack.token, leo.linear.access]);
    expect(held.map((row) => [row?.revokedAt !== undefined, row?.sourceRevocation?.state])).toEqual(
      [
        [true, 'pending'],
        [true, 'pending'],
      ],
    );
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(
      network.calls
        .map((call) => ({
          path: new URL(call.url).pathname,
          authorization: call.authorization,
          form: call.form,
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    ).toEqual([
      {
        path: '/api/apps.manifest.delete',
        authorization: `Bearer ${CONFIGURATION_TOKEN}`,
        form: { app_id: LEO_APP_ID },
      },
      {
        path: '/oauth/revoke',
        authorization: undefined,
        form: { token: LEO_LINEAR_ACCESS, token_type_hint: 'access_token' },
      },
      {
        path: '/oauth/revoke',
        authorization: undefined,
        form: { token: LEO_LINEAR_REFRESH, token_type_hint: 'refresh_token' },
      },
    ]);
    // The bot token itself is never sent: deleting the app ends it.
    expect(JSON.stringify(network.calls)).not.toContain(LEO_BOT_TOKEN);
    const recorded = await lines(harness, leo.agentId);
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surfaceName: 'Slack',
          system: 'slack',
          end: 'retire',
          outcome: 'app-deleted',
        }),
        expect.objectContaining({
          surfaceName: 'Linear',
          system: 'linear',
          end: 'retire',
          outcome: 'token-revoked',
        }),
      ]),
    );
    expect(recorded).toHaveLength(2);
    const after = await credentialRows(harness, [
      leo.slack.token,
      leo.slack.secret,
      leo.linear.access,
      leo.linear.refresh,
    ]);
    expect(after.map((row) => [row?.sourceRevocation?.state, row?.ciphertext])).toEqual([
      ['done', undefined],
      ['done', undefined],
      ['done', undefined],
      ['done', undefined],
    ]);
    const [retirement] = await harness.run(
      async (ctx) => await ctx.db.query('retirements').collect(),
    );
    expect(retirement).toMatchObject({ revokedCredentials: 4, keptCredentials: 0 });
  });

  it("retire revokes the employee's own identity the organisation holds, as it does the owner's", async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true, heldBy: 'organisation' });
    network.answer('/api/apps.manifest.delete', { status: 200, body: SLACK_MANIFEST_DELETE_OK });
    network.answer('/oauth/revoke', { status: 200, body: '' });

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.reset.retire, { agentId: leo.agentId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls.map((call) => new URL(call.url).pathname).sort()).toEqual([
      '/api/apps.manifest.delete',
      '/oauth/revoke',
      '/oauth/revoke',
    ]);
    expect(await lines(harness, leo.agentId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: 'slack', end: 'retire', outcome: 'app-deleted' }),
        expect.objectContaining({ system: 'linear', end: 'retire', outcome: 'token-revoked' }),
      ]),
    );
    const after = await credentialRows(harness, [
      leo.slack.token,
      leo.slack.secret,
      leo.linear.access,
      leo.linear.refresh,
    ]);
    expect(after.map((row) => [row?.sourceRevocation?.state, row?.ciphertext])).toEqual([
      ['done', undefined],
      ['done', undefined],
      ['done', undefined],
      ['done', undefined],
    ]);
    const [retirement] = await harness.run(
      async (ctx) => await ctx.db.query('retirements').collect(),
    );
    expect(retirement).toMatchObject({ revokedCredentials: 4, keptCredentials: 0 });
  });

  it("leaves a pasted key's vendor alone and says so, deleting Day0's copy as before", async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: false });
    const pasted = await harness.run(async (ctx) => {
      const key = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Zendesk key',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId: leo.agentId,
        slug: 'zendesk',
        displayName: 'Zendesk',
        class: 'helpdesk',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        credentialId: key,
        credentialKind: 'value',
        createdAt: 1,
      });
      return key;
    });
    network.answer('/api/apps.uninstall', { status: 200, body: { ok: true } });
    network.answer('/oauth/revoke', { status: 200, body: '' });

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.reset.retire, { agentId: leo.agentId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(JSON.stringify(network.calls)).not.toContain('sealed');
    expect(network.calls.every((call) => !call.url.includes('zendesk'))).toBe(true);
    const [key] = await credentialRows(harness, [pasted]);
    expect(key).toMatchObject({ revokedAt: expect.any(Number) });
    expect(key?.ciphertext).toBeUndefined();
    expect(key?.sourceRevocation).toBeUndefined();
    expect(await lines(harness, leo.agentId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surfaceName: 'Zendesk', outcome: 'pasted-key', end: 'retire' }),
        expect.objectContaining({ system: 'slack', outcome: 'app-uninstalled' }),
      ]),
    );
  });
});

describe("the retire preview's per-credential outcome (11-AR; the retire dialog's sentence)", (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('says, per credential, what the retire will do at the vendor', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true });

    const preview = await harness
      .withIdentity(managerIdentity())
      .query(api.reset.retirePreview, { agentId: leo.agentId });

    expect(preview?.outcomes).toEqual([
      {
        slug: 'slack',
        displayName: 'Slack',
        system: 'slack',
        outcome: 'app-deleted',
      },
      {
        slug: 'linear',
        displayName: 'Linear',
        system: 'linear',
        outcome: 'token-revoked',
      },
    ]);
  });

  it('says the same of an identity the organisation holds', async (): Promise<void> => {
    const harness = await realHarness();
    const leo = await seedIssuedIdentities(harness, { connection: true, heldBy: 'organisation' });

    const preview = await harness
      .withIdentity(managerIdentity())
      .query(api.reset.retirePreview, { agentId: leo.agentId });

    expect(preview?.outcomes).toEqual([
      { slug: 'slack', displayName: 'Slack', system: 'slack', outcome: 'app-deleted' },
      { slug: 'linear', displayName: 'Linear', system: 'linear', outcome: 'token-revoked' },
    ]);
    expect(preview?.revoked).toEqual([
      { slug: 'slack', displayName: 'Slack' },
      { slug: 'linear', displayName: 'Linear' },
    ]);
  });

  it('says a pasted key is deleted from Day0 only, and one kept for a colleague is kept', async (): Promise<void> => {
    const harness = await realHarness();
    const owner = harness.withIdentity(managerIdentity());
    const { retiring } = await harness.run(async (ctx) => {
      const key = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Zendesk key',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
      const shared = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Notion key',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      });
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
      const card = {
        class: 'docs',
        verdict: 'connected' as const,
        whereFound: [],
        credentialLanded: true,
        createdAt: 1,
      };
      await ctx.db.insert('surfaces', {
        ...card,
        agentId: retiring,
        slug: 'zendesk',
        displayName: 'Zendesk',
        credentialId: key,
      });
      for (const agentId of [retiring, sibling]) {
        await ctx.db.insert('surfaces', {
          ...card,
          agentId,
          slug: 'notion',
          displayName: 'Notion',
          credentialId: shared,
        });
      }
      return { retiring };
    });

    const preview = await owner.query(api.reset.retirePreview, { agentId: retiring });

    expect(preview?.outcomes).toEqual([
      { slug: 'zendesk', displayName: 'Zendesk', system: 'Zendesk', outcome: 'pasted-key' },
      { slug: 'notion', displayName: 'Notion', system: 'Notion', outcome: 'kept' },
    ]);
  });
});

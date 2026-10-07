/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { CARD_HAS_APP, FORGET_NOT_ENDED, SPENT_REFRESH_REASON } from '../../convex/slackProvision';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * The transactions of Slack's identity issuer (11-AS): the rotation-safe write of the kept
 * configuration pair under its generation, a refused rotation, and the app a card is given. The
 * actions that call Slack are tested in `slackProvisionActions.connection.test.ts`.
 */

type Harness = TestConvex<typeof schema>;

const HOUR = 60 * 60 * 1000;

beforeEach((): void => {
  vi.useFakeTimers();
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

interface Landed {
  readonly connectionId: Id<'organisationConnections'>;
  readonly secretId: Id<'credentials'>;
  readonly refreshId: Id<'credentials'>;
}

async function land(harness: Harness): Promise<Landed> {
  const connectionId = await harness.action(internal.organisationConnections.landFromSetup, {
    system: 'slack',
    displayName: 'Slack',
    kind: 'slack-configuration',
    mode: 'per-employee',
    scopes: ['chat:write'],
    secret: 'xoxe.xoxp-1-cfg0',
    refreshToken: 'xoxe-1-ref0',
  });
  const connection = await harness.run(async (ctx) => await ctx.db.get(connectionId));
  const secretId = connection?.secretCredentialId;
  const secret = secretId ? await harness.run(async (ctx) => await ctx.db.get(secretId)) : null;
  if (!secretId || !secret?.refreshCredentialId) throw new Error('the landing stored no pair');
  return { connectionId, secretId, refreshId: secret.refreshCredentialId };
}

async function sealed(harness: Harness, plaintext: string) {
  return await harness.action(internal.credentialCryptoActions.seal, {
    plaintext,
    userId: ORGANISATION_OWNER_KEY,
  });
}

async function rotation(harness: Harness, landed: Landed, expectedGeneration: number) {
  return {
    organisationConnectionId: landed.connectionId,
    secretCredentialId: landed.secretId,
    expectedGeneration,
    token: await sealed(harness, `xoxe.xoxp-1-cfg${expectedGeneration + 1}`),
    refresh: await sealed(harness, `xoxe-1-ref${expectedGeneration + 1}`),
    expiresAt: Date.now() + 12 * HOUR,
    now: Date.now(),
  };
}

async function open(harness: Harness, credentialId: Id<'credentials'>): Promise<string> {
  return await harness.action(internal.credentials.decrypt, { credentialId });
}

describe('the rotation-safe write of the configuration pair (B9, S2)', (): void => {
  it('writes the new pair over the kept rows at the next generation and queues the renewal', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const landed = await land(harness);

    const outcome = await harness.mutation(
      internal.slackProvision.recordRotation,
      await rotation(harness, landed, 0),
    );

    expect(outcome).toEqual({ ok: true, generation: 1 });
    expect(await open(harness, landed.secretId)).toBe('xoxe.xoxp-1-cfg1');
    expect(await open(harness, landed.refreshId)).toBe('xoxe-1-ref1');
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    // The landing queued the first renewal (m9); the rotation queues the next, at the new generation.
    expect(scheduled.map((job) => [job.name, job.scheduledTime, job.args[0]])).toEqual([
      [
        'slackProvisionActions:keepConfigurationCurrent',
        Date.now() + HOUR / 4,
        {
          organisationConnectionId: landed.connectionId,
          secretCredentialId: landed.secretId,
          generation: 0,
        },
      ],
      [
        'slackProvisionActions:keepConfigurationCurrent',
        Date.now() + 11 * HOUR,
        {
          organisationConnectionId: landed.connectionId,
          secretCredentialId: landed.secretId,
          generation: 1,
        },
      ],
    ]);
  });

  it('refuses a rotation that read an earlier generation, and keeps the winner’s pair', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const landed = await land(harness);
    await harness.mutation(
      internal.slackProvision.recordRotation,
      await rotation(harness, landed, 0),
    );
    const loser = await rotation(harness, landed, 0);

    expect(await harness.mutation(internal.slackProvision.recordRotation, loser)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(await open(harness, landed.secretId)).toBe('xoxe.xoxp-1-cfg1');
    const lines = await harness.run(
      async (ctx) => await ctx.db.query('connectionEvents').collect(),
    );
    expect(lines.at(-1)?.payload).toMatchObject({
      method: 'tooling.tokens.rotate',
      outcome: 'superseded',
      reason: 'another renewal wrote its pair first',
    });
  });

  it('writes nothing over a connection IT revoked meanwhile', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const landed = await land(harness);
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: landed.connectionId,
      reason: 'IT is moving workspaces',
    });

    expect(
      await harness.mutation(
        internal.slackProvision.recordRotation,
        await rotation(harness, landed, 0),
      ),
    ).toEqual({ ok: false, reason: 'gone' });
    const secret = await harness.run(async (ctx) => await ctx.db.get(landed.secretId));
    expect(secret?.generation).toBeUndefined();
  });
});

describe('a rotation Slack refused', (): void => {
  it('marks the connection for IT when the refresh token is spent and the pair had not moved', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const landed = await land(harness);

    const refused = await harness.mutation(internal.slackProvision.recordRotationRefused, {
      organisationConnectionId: landed.connectionId,
      secretCredentialId: landed.secretId,
      expectedGeneration: 0,
      reason: 'Slack tooling.tokens.rotate failed: invalid_refresh_token',
      spent: true,
      now: Date.now(),
    });

    expect(refused).toEqual({ moved: false });
    const connection = await harness.run(async (ctx) => await ctx.db.get(landed.connectionId));
    expect(connection).toMatchObject({
      status: 'needs-attention',
      statusReason: SPENT_REFRESH_REASON,
    });
    await harness.mutation(
      internal.slackProvision.recordRotation,
      await rotation(harness, landed, 0),
    );
    expect(await harness.run(async (ctx) => await ctx.db.get(landed.connectionId))).toMatchObject({
      status: 'active',
    });
  });

  it('answers moved and marks nothing when another rotation wrote first', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const landed = await land(harness);
    await harness.mutation(
      internal.slackProvision.recordRotation,
      await rotation(harness, landed, 0),
    );

    const refused = await harness.mutation(internal.slackProvision.recordRotationRefused, {
      organisationConnectionId: landed.connectionId,
      secretCredentialId: landed.secretId,
      expectedGeneration: 0,
      reason: 'Slack tooling.tokens.rotate failed: invalid_refresh_token',
      spent: true,
      now: Date.now(),
    });

    expect(refused).toEqual({ moved: true });
    expect(await harness.run(async (ctx) => await ctx.db.get(landed.connectionId))).toMatchObject({
      status: 'active',
    });
  });
});

describe('the app a card is given', (): void => {
  async function card(harness: Harness): Promise<Id<'surfaces'>> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Leo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'approved',
        whereFound: [],
        managerApprovedAt: 1,
        credentialLanded: false,
        createdAt: 1,
      });
    });
  }

  /** The client secret's issuer, as the provisioning action stores it with the secret. */
  const SECRET_ISSUER = {
    system: 'slack',
    grant: 'app-created' as const,
    appId: 'A0APP1',
    clientId: '1234.1',
  };

  async function secret(
    harness: Harness,
    holder: 'organisation' | 'owner',
    issuedBy: typeof SECRET_ISSUER = SECRET_ISSUER,
  ) {
    return await harness.action(internal.credentials.store, {
      userId: holder === 'organisation' ? ORGANISATION_OWNER_KEY : 'owner',
      ...(holder === 'organisation' ? { holder: ORGANISATION_HOLDER } : {}),
      kind: 'oauth',
      label: 'Leo (Day0) client secret',
      plaintext: 'w11as-secret-1',
      source: 'oauth',
      issuedBy,
    });
  }

  function app(surfaceId: Id<'surfaces'>, clientSecretCredentialId: Id<'credentials'>) {
    return {
      surfaceId,
      appId: 'A0APP1',
      appName: 'Leo (Day0)',
      clientId: '1234.1',
      clientSecretCredentialId,
      redirectUrl: 'https://day0.example.test/api/oauth/slack',
      scopes: ['chat:write'],
      installUrl: 'https://slack.com/oauth/v2/authorize?client_id=1234.1',
      stateNonce: 'nonce-1',
      stateExpiresAt: Date.now() + 15 * 60 * 1000,
      startedUnder: 'owner',
      now: Date.now(),
    };
  }

  it("refuses an app created under the employee's previous owner, recording nothing (the review's m10)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await card(harness);
    const secretId = await secret(harness, 'organisation');
    const before = await harness.run(async (ctx) => await ctx.db.get(secretId));

    await expect(
      harness.mutation(internal.slackProvision.recordCreatedApp, {
        ...app(surfaceId, secretId),
        startedUnder: 'previous-owner',
      }),
    ).rejects.toThrow('changed hands');

    const after = await harness.run(async (ctx) => ({
      surface: await ctx.db.get(surfaceId),
      secret: await ctx.db.get(secretId),
    }));
    expect(after.surface?.provisioning).toBeUndefined();
    // The secret was stored with its issuer (the pre-tag's item 10); the refusal wrote nothing.
    expect(after.secret).toEqual(before);
  });

  it('refuses a client secret stored for another app, recording nothing (the pre-tag item 10)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await card(harness);
    const other = await secret(harness, 'organisation', { ...SECRET_ISSUER, appId: 'A0OTHER' });

    await expect(
      harness.mutation(internal.slackProvision.recordCreatedApp, app(surfaceId, other)),
    ).rejects.toThrow('not one the organisation holds for it');
    expect(
      (await harness.run(async (ctx) => await ctx.db.get(surfaceId)))?.provisioning,
    ).toBeUndefined();
  });

  it('records the app over a client secret stored with its issuer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await card(harness);
    const secretId = await secret(harness, 'organisation');

    await harness.mutation(internal.slackProvision.recordCreatedApp, app(surfaceId, secretId));

    const [row, stored] = await harness.run(
      async (ctx) => await Promise.all([ctx.db.get(surfaceId), ctx.db.get(secretId)]),
    );
    expect(row?.provisioning).toMatchObject({ appId: 'A0APP1', stateNonce: 'nonce-1' });
    expect(stored?.issuedBy).toEqual({
      system: 'slack',
      grant: 'app-created',
      appId: 'A0APP1',
      clientId: '1234.1',
    });
  });

  it('refuses a second app for a card that has one, and a secret its owner holds', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await card(harness);
    const first = await secret(harness, 'organisation');
    await harness.mutation(internal.slackProvision.recordCreatedApp, app(surfaceId, first));

    await expect(
      harness.mutation(
        internal.slackProvision.recordCreatedApp,
        app(surfaceId, await secret(harness, 'organisation')),
      ),
    ).rejects.toThrow(CARD_HAS_APP);
    const other = await card(harness);
    await expect(
      harness.mutation(
        internal.slackProvision.recordCreatedApp,
        app(other, await secret(harness, 'owner')),
      ),
    ).rejects.toThrow('not one the organisation holds');
  });

  it("files a fresh link for the card's kept app and keeps when it was installed", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await card(harness);
    await harness.mutation(
      internal.slackProvision.recordCreatedApp,
      app(surfaceId, await secret(harness, 'organisation')),
    );
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(surfaceId);
      if (row?.provisioning) {
        await ctx.db.patch(surfaceId, {
          provisioning: { ...row.provisioning, installedAt: 7, stateNonce: undefined },
        });
      }
    });

    await harness.mutation(internal.slackProvision.recordInstallLink, {
      surfaceId,
      appId: 'A0APP1',
      installUrl: 'https://slack.com/oauth/v2/authorize?client_id=1234.1&state=2',
      stateNonce: 'nonce-2',
      stateExpiresAt: Date.now() + 1,
      now: Date.now(),
    });

    const row = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(row?.provisioning).toMatchObject({
      appId: 'A0APP1',
      installedAt: 7,
      stateNonce: 'nonce-2',
    });
    await expect(
      harness.mutation(internal.slackProvision.recordInstallLink, {
        surfaceId,
        appId: 'A0OTHER',
        installUrl: 'https://slack.com/oauth/v2/authorize',
        stateNonce: 'nonce-3',
        stateExpiresAt: Date.now() + 1,
        now: Date.now(),
      }),
    ).rejects.toThrow("The card's app changed");
  });
});

describe("forgetting an app IT's revoke ended (W12X-4; 13-FS's design 2 (b))", (): void => {
  afterEach((): void => {
    restoreSurfaceMode();
  });

  /**
   * An approved Slack card whose own app, with its client secret and app-level token, was created
   * through a connection in the given state, holding no credential as IT's revoke left it.
   */
  async function endedCard(
    harness: Harness,
    status: 'active' | 'revoked',
  ): Promise<{
    surfaceId: Id<'surfaces'>;
    secretId: Id<'credentials'>;
    tokenId: Id<'credentials'>;
  }> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Leo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const organisationConnectionId = await ctx.db.insert('organisationConnections', {
        system: 'slack',
        displayName: 'Slack',
        kind: 'slack-configuration',
        mode: 'per-employee',
        scopes: ['chat:write'],
        registeredBy: { via: 'setup-cli', at: 1 },
        status,
        createdAt: 1,
      });
      const held = async (label: string) =>
        await ctx.db.insert('credentials', {
          userId: ORGANISATION_OWNER_KEY,
          holder: ORGANISATION_HOLDER,
          kind: 'oauth',
          label,
          ciphertext: 'ciphertext',
          iv: 'iv',
          source: 'oauth',
          createdAt: 1,
        });
      const secretId = await held('Leo (Day0) client secret');
      const tokenId = await held('Leo (Day0) app-level token');
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'approved',
        whereFound: [],
        path: 'documented-api',
        endpoint: 'https://slack.com/api/',
        managerApprovedAt: 2,
        credentialLanded: false,
        organisationConnectionId,
        providerIdentityId: 'U0LEOBOT',
        providerBotId: 'B0LEO',
        managerDmChannelId: 'D0LEO',
        channelsNotJoined: ['#revops'],
        provisioning: {
          appId: 'A0LEO',
          appName: 'Leo (Day0)',
          clientId: '1.2',
          clientSecretCredentialId: secretId,
          appLevelTokenCredentialId: tokenId,
          installUrl: 'https://slack.com/oauth/v2/authorize',
          redirectUrl: 'https://day0.example/api/oauth/slack',
          scopes: ['chat:write'],
          createdAt: 1,
          installedAt: 2,
          organisationConnectionId,
        },
        createdAt: 1,
      });
      return { surfaceId, secretId, tokenId };
    });
  }

  it("forgets the app with the old bot's identity, its DM and channels, and purges both its secrets", async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const card = await endedCard(harness, 'revoked');

    await harness
      .withIdentity(managerIdentity())
      .mutation(api.slackProvision.forgetEndedApp, { surfaceId: card.surfaceId });

    const row = await harness.run(async (ctx) => await ctx.db.get(card.surfaceId));
    expect(row).toMatchObject({ verdict: 'approved', managerApprovedAt: 2 });
    for (const field of [
      'provisioning',
      'providerIdentityId',
      'providerBotId',
      'managerDmChannelId',
      'channelsNotJoined',
    ] as const) {
      expect(row?.[field]).toBeUndefined();
    }
    for (const id of [card.secretId, card.tokenId]) {
      const secret = await harness.run(async (ctx) => await ctx.db.get(id));
      expect(secret).toMatchObject({ revokedAt: expect.any(Number) });
      expect(secret?.ciphertext).toBeUndefined();
      expect(secret?.iv).toBeUndefined();
    }
  });

  it('refuses an app whose connection IT has not revoked, and changes nothing', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const card = await endedCard(harness, 'active');
    await expect(
      harness
        .withIdentity(managerIdentity())
        .mutation(api.slackProvision.forgetEndedApp, { surfaceId: card.surfaceId }),
    ).rejects.toThrow(FORGET_NOT_ENDED);
    const row = await harness.run(async (ctx) => await ctx.db.get(card.surfaceId));
    expect(row?.provisioning?.appId).toBe('A0LEO');
  });

  it('is refused in mock mode, where the page drives every step', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const card = await endedCard(harness, 'revoked');
    await expect(
      harness
        .withIdentity(managerIdentity())
        .mutation(api.slackProvision.forgetEndedApp, { surfaceId: card.surfaceId }),
    ).rejects.toThrow('Forgetting an app is a local real-mode');
    const row = await harness.run(async (ctx) => await ctx.db.get(card.surfaceId));
    expect(row?.provisioning?.appId).toBe('A0LEO');
  });
});

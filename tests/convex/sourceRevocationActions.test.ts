/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { endAccessAtSource } from '../../convex/sourceRevocation';
import { allConvexModules } from './all-modules';
import { stubVendorNetwork, type VendorNetwork } from './fakes/vendor-revocation';
import {
  SLACK_AUTH_REVOKE_OK,
  SLACK_INVALID_AUTH,
  SLACK_MANIFEST_DELETE_OK,
  SLACK_UNINSTALL_OK,
} from '../fixtures/revokers';
import type { AccessEnd } from '../../src/surfaces/access-identity';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';

type Harness = TestConvex<typeof schema>;

const BOT_TOKEN = ['xoxb', '1234567890', 'abcdefghij'].join('-');
const CONFIGURATION_TOKEN = ['xoxe.xoxp', '1', 'abcdefghij'].join('-');
const CLIENT_SECRET = 'w11ar-client-secret-0123';

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.useFakeTimers();
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * Store a value under an owner, then write the given fields on its row. A value under the reserved
 * organisation key is stored with the organisation as its holder, as the store requires.
 */
async function stored(
  harness: Harness,
  userId: string,
  plaintext: string,
  fields: Partial<Doc<'credentials'>>,
): Promise<Id<'credentials'>> {
  const credentialId = await harness.action(internal.credentials.store, {
    userId,
    kind: 'oauth',
    label: 'Slack',
    plaintext,
    source: 'oauth',
    ...(userId === ORGANISATION_OWNER_KEY ? { holder: ORGANISATION_HOLDER } : {}),
  });
  await harness.run(async (ctx) => await ctx.db.patch(credentialId, fields));
  return credentialId;
}

/** Leo with his Slack card, his own app's bot token and client secret, and maybe IT's connection. */
async function leoWithOwnApp(
  harness: Harness,
  options: { readonly connection: boolean },
): Promise<{
  readonly agentId: Id<'agents'>;
  readonly surfaceId: Id<'surfaces'>;
  readonly token: Id<'credentials'>;
  readonly secret: Id<'credentials'>;
  readonly connectionId?: Id<'organisationConnections'>;
}> {
  let connectionId: Id<'organisationConnections'> | undefined;
  if (options.connection) {
    const configuration = await stored(harness, ORGANISATION_OWNER_KEY, CONFIGURATION_TOKEN, {});
    connectionId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('organisationConnections', {
          system: 'slack',
          displayName: 'Slack',
          kind: 'slack-configuration',
          mode: 'per-employee',
          scopes: ['chat:write'],
          registeredBy: { via: 'setup-cli', at: 1 },
          status: 'active',
          secretCredentialId: configuration,
          createdAt: 1,
        }),
    );
  }
  const app = {
    system: 'slack',
    appId: 'A0W11AR',
    clientId: '1234.5678',
    ...(connectionId !== undefined ? { organisationConnectionId: connectionId } : {}),
  };
  const secret = await stored(harness, 'owner', CLIENT_SECRET, {
    issuedBy: { ...app, grant: 'app-created' },
  });
  const token = await stored(harness, 'owner', BOT_TOKEN, {
    issuedBy: { ...app, grant: 'oauth-install', clientSecretCredentialId: secret },
  });
  const { agentId, surfaceId } = await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Leo',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      whereFound: [],
      credentialLanded: true,
      credentialId: token,
      credentialKind: 'oauth',
      createdAt: 1,
    });
    return { agentId, surfaceId };
  });
  return { agentId, surfaceId, token, secret, ...(connectionId ? { connectionId } : {}) };
}

/** End Leo's Slack access over the given rows, in one transaction, and run what it scheduled. */
async function endAndDrain(
  harness: Harness,
  leo: { readonly agentId: Id<'agents'>; readonly surfaceId: Id<'surfaces'> },
  credentialIds: readonly Id<'credentials'>[],
  accessEnd: AccessEnd,
): Promise<void> {
  await harness.run(async (ctx) => {
    const rows = await Promise.all(credentialIds.map(async (id) => await ctx.db.get(id)));
    await endAccessAtSource(ctx, {
      agentId: leo.agentId,
      surfaceId: leo.surfaceId,
      surfaceName: 'Slack',
      credentials: rows.filter((row): row is Doc<'credentials'> => row !== null),
      end: accessEnd,
      now: Date.now(),
    });
  });
  await harness.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Leo's ledger lines, oldest first. */
async function lines(harness: Harness, agentId: Id<'agents'>): Promise<unknown[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect())
      .filter((event) => event.agentId === agentId && event.type === 'credential.revoked-at-source')
      .map((event) => event.payload as unknown),
  );
}

describe("the RFC 7009 call after the administrator revoked the connection (the review's minor 6)", (): void => {
  let network: VendorNetwork;

  beforeEach((): void => {
    network = stubVendorNetwork();
  });

  it("still revokes at the endpoint the revoked connection advertised, and names a bad endpoint in Day0's words", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { connectionId, agentId, surfaceId } = await harness.run(async (ctx) => {
      const connectionId = await ctx.db.insert('organisationConnections', {
        system: 'mcp:mcp.example.com',
        displayName: 'Example MCP',
        kind: 'mcp-client',
        mode: 'per-employee',
        scopes: [],
        registeredBy: { via: 'setup-cli', at: 1 },
        status: 'revoked',
        clientId: 'day0-public',
        authorisationEndpoints: {
          authorisation: 'https://auth.example.com/authorize',
          token: 'https://auth.example.com/token',
          revocation: 'https://auth.example.com/revoke',
          discoveredAt: 1,
        },
        createdAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Leo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'example',
        displayName: 'Example',
        class: 'docs',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        createdAt: 1,
      });
      return { connectionId, agentId, surfaceId };
    });
    const credentialId = await stored(harness, 'owner', 'mcp-access-0123', {
      issuedBy: {
        system: 'mcp:mcp.example.com',
        grant: 'authorisation-code',
        clientId: 'day0-public',
        organisationConnectionId: connectionId,
      },
    });
    network.answer('/revoke', { status: 200, body: '' });

    await endAndDrain(harness, { agentId, surfaceId }, [credentialId], 'organisation-revoked');

    expect(network.calls).toEqual([
      {
        url: 'https://auth.example.com/revoke',
        form: {
          token: 'mcp-access-0123',
          token_type_hint: 'access_token',
          client_id: 'day0-public',
        },
      },
    ]);
    await harness.run(async (ctx) => {
      const connection = await ctx.db.get(connectionId);
      if (connection?.authorisationEndpoints === undefined) throw new Error('no endpoints');
      await ctx.db.patch(connectionId, {
        authorisationEndpoints: {
          ...connection.authorisationEndpoints,
          revocation: 'http://auth.example.com/revoke',
        },
      });
    });
    const second = await stored(harness, 'owner', 'mcp-access-4567', {
      issuedBy: {
        system: 'mcp:mcp.example.com',
        grant: 'authorisation-code',
        organisationConnectionId: connectionId,
      },
    });
    await endAndDrain(harness, { agentId, surfaceId }, [second], 'disconnect');
    const lines = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).map((event) => event.payload as { reason?: string }),
    );
    expect(lines.at(-1)?.reason).toBe(
      'Day0 refused the revocation endpoint: A revocation endpoint must be an https address.',
    );
  });
});

describe("Slack's two calls with their two meanings (S1, S4)", (): void => {
  let network: VendorNetwork;

  beforeEach((): void => {
    network = stubVendorNetwork();
  });

  it.each<AccessEnd>(['disconnect', 'expiry'])(
    'at %s revokes the bot token and keeps the app; the record says its channel memberships were removed',
    async (accessEnd): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const leo = await leoWithOwnApp(harness, { connection: true });
      network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });

      await endAndDrain(harness, leo, [leo.token], accessEnd);

      expect(network.calls).toEqual([
        {
          url: 'https://slack.com/api/auth.revoke',
          authorization: `Bearer ${BOT_TOKEN}`,
          form: {},
        },
      ]);
      expect(await lines(harness, leo.agentId)).toEqual([
        {
          credentialId: leo.token,
          surfaceId: leo.surfaceId,
          surfaceName: 'Slack',
          system: 'slack',
          end: accessEnd,
          outcome: 'token-revoked',
          attempt: 1,
          channelMembershipsRemoved: true,
        },
      ]);
      // The app stays: its client secret is untouched, for the renewal's install.
      const secret = await harness.run(async (ctx) => await ctx.db.get(leo.secret));
      expect(secret?.revokedAt).toBeUndefined();
      expect(secret?.ciphertext).toEqual(expect.any(String));
    },
  );

  it("at a retire deletes the employee's own app with IT's configuration token, and logs the call on the connection's ledger", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await leoWithOwnApp(harness, { connection: true });
    network.answer('/api/apps.manifest.delete', { status: 200, body: SLACK_MANIFEST_DELETE_OK });

    await endAndDrain(harness, leo, [leo.token, leo.secret], 'retire');

    expect(network.calls).toEqual([
      {
        url: 'https://slack.com/api/apps.manifest.delete',
        authorization: `Bearer ${CONFIGURATION_TOKEN}`,
        form: { app_id: 'A0W11AR' },
      },
    ]);
    expect(await lines(harness, leo.agentId)).toEqual([
      expect.objectContaining({ system: 'slack', end: 'retire', outcome: 'app-deleted' }),
    ]);
    const held = await harness.run(
      async (ctx) => await Promise.all([leo.token, leo.secret].map((id) => ctx.db.get(id))),
    );
    expect(held.map((row) => [row?.sourceRevocation?.state, row?.ciphertext])).toEqual([
      ['done', undefined],
      ['done', undefined],
    ]);
    const ledger = await harness.run(
      async (ctx) => await ctx.db.query('connectionEvents').collect(),
    );
    expect(ledger).toEqual([
      expect.objectContaining({
        organisationConnectionId: leo.connectionId,
        type: 'organisation.revoked-at-source',
        payload: expect.objectContaining({
          system: 'slack',
          end: 'retire',
          outcome: 'app-deleted',
        }),
      }),
    ]);
  });

  it('uninstalls the app where the configuration connection is gone, with the client secret kept for the call', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await leoWithOwnApp(harness, { connection: false });
    network.answer('/api/apps.uninstall', { status: 200, body: SLACK_UNINSTALL_OK });

    await endAndDrain(harness, leo, [leo.token, leo.secret], 'retire');

    expect(network.calls).toEqual([
      {
        url: 'https://slack.com/api/apps.uninstall',
        authorization: `Bearer ${BOT_TOKEN}`,
        form: { client_id: '1234.5678', client_secret: CLIENT_SECRET },
      },
    ]);
    expect(await lines(harness, leo.agentId)).toEqual([
      expect.objectContaining({ outcome: 'app-uninstalled' }),
    ]);
  });

  it('falls back to the uninstall when Slack refuses the deletion, in the same attempt', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await leoWithOwnApp(harness, { connection: true });
    network.answer('/api/apps.manifest.delete', { status: 200, body: SLACK_INVALID_AUTH });
    network.answer('/api/apps.uninstall', { status: 200, body: SLACK_UNINSTALL_OK });

    await endAndDrain(harness, leo, [leo.token, leo.secret], 'retire');

    expect(network.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/apps.manifest.delete',
      '/api/apps.uninstall',
    ]);
    expect(await lines(harness, leo.agentId)).toEqual([
      expect.objectContaining({ outcome: 'app-uninstalled', attempt: 1 }),
    ]);
  });

  it("opens only what the call needs: a disconnect reads neither IT's token nor the app's secret, and writes nothing on IT's ledger", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await leoWithOwnApp(harness, { connection: true });
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });

    await endAndDrain(harness, leo, [leo.token], 'disconnect');

    const [configuration, secret] = await harness.run(async (ctx) => {
      const connection = leo.connectionId ? await ctx.db.get(leo.connectionId) : null;
      return await Promise.all([
        connection?.secretCredentialId ? ctx.db.get(connection.secretCredentialId) : null,
        ctx.db.get(leo.secret),
      ]);
    });
    expect(configuration?.lastUsedAt).toBeUndefined();
    expect(secret?.lastUsedAt).toBeUndefined();
    expect(
      await harness.run(async (ctx) => await ctx.db.query('connectionEvents').collect()),
    ).toEqual([]);
  });

  it('never follows a redirect with a token in the body, and fails at once on one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await leoWithOwnApp(harness, { connection: false });
    network.answer('/api/auth.revoke', { status: 308, body: '' });

    await endAndDrain(harness, leo, [leo.token], 'disconnect');

    expect(network.calls.map((call) => new URL(call.url).pathname)).toEqual(['/api/auth.revoke']);
    expect(await lines(harness, leo.agentId)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        attempt: 1,
        reason: 'Slack auth.revoke returned HTTP 308.',
      }),
    ]);
  });

  it('reads a bot token Slack no longer knows as already revoked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await leoWithOwnApp(harness, { connection: false });
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_INVALID_AUTH });

    await endAndDrain(harness, leo, [leo.token], 'disconnect');

    expect(await lines(harness, leo.agentId)).toEqual([
      expect.objectContaining({ outcome: 'already-gone' }),
    ]);
  });
});

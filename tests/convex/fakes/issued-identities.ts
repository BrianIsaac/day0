import type { TestConvex } from 'convex-test';
import { internal } from '../../../convex/_generated/api';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../../src/lib/organisation-key';
import { MANAGER_ADDRESS } from './manager-identity';

/*
 * An employee whose identities Day0 itself obtained (wave 11, 11-AR): its own Slack app, created
 * through IT's configuration connection when one is asked for, with the bot token its install gave
 * and the app's client secret; and its own Linear app's access token with the refresh token paired
 * with it. Every value is sealed by the real store, so the revocation's decrypt opens it. The
 * tokens are fakes in the tree's short shapes.
 */

/** The Slack bot token the fixture's install gave. */
export const LEO_BOT_TOKEN = ['xoxb', '1234567890', 'abcdefghij'].join('-');

/** IT's Slack configuration token. */
export const CONFIGURATION_TOKEN = ['xoxe.xoxp', '1', 'abcdefghij'].join('-');

/** The client secret `apps.manifest.create` returned for Leo's app. */
export const LEO_CLIENT_SECRET = 'w11ar-client-secret-0123';

/** Leo's Linear access token and its refresh token. */
export const LEO_LINEAR_ACCESS = 'lin_oauth_w11ar_access';
export const LEO_LINEAR_REFRESH = 'lin_oauth_w11ar_refresh';

/** Leo's own Slack app's id and client id. */
export const LEO_APP_ID = 'A0W11AR';
export const LEO_CLIENT_ID = '1234.5678';

/** What {@link seedIssuedIdentities} made. */
export interface IssuedIdentities {
  readonly agentId: Id<'agents'>;
  readonly slack: {
    readonly surfaceId: Id<'surfaces'>;
    readonly token: Id<'credentials'>;
    readonly secret: Id<'credentials'>;
  };
  readonly linear: {
    readonly surfaceId: Id<'surfaces'>;
    readonly access: Id<'credentials'>;
    readonly refresh: Id<'credentials'>;
  };
  readonly connectionId?: Id<'organisationConnections'>;
}

/**
 * Store a value as the store seals it, then write the given fields on its row. A value under the
 * reserved organisation key is stored with the organisation as its holder, as the store requires.
 */
async function sealed(
  harness: TestConvex<typeof schema>,
  userId: string,
  plaintext: string,
  label: string,
  fields: Partial<Doc<'credentials'>>,
): Promise<Id<'credentials'>> {
  const credentialId = await harness.action(internal.credentials.store, {
    userId,
    kind: 'oauth',
    label,
    plaintext,
    source: 'oauth',
    ...(userId === ORGANISATION_OWNER_KEY ? { holder: ORGANISATION_HOLDER } : {}),
  });
  await harness.run(async (ctx) => await ctx.db.patch(credentialId, fields));
  return credentialId;
}

/**
 * Seed Leo, the owner's employee, with his own Slack app and his own Linear app, both connected.
 *
 * @param harness - A harness whose `DAY0_CREDENTIAL_KEY` is stubbed.
 * @param options - Whether IT's Slack configuration connection exists (and so created the app),
 *   whose employee Leo is, and who holds his identities' rows: his owner, as an issuer before
 *   v0.14.0 stored them, or the organisation, as the wave 11 common rules have every issuer
 *   store a per-employee identity's tokens (`holder: 'organisation'` under the reserved key).
 */
export async function seedIssuedIdentities(
  harness: TestConvex<typeof schema>,
  options: {
    readonly connection: boolean;
    readonly owner?: string;
    readonly heldBy?: 'owner' | 'organisation';
  },
): Promise<IssuedIdentities> {
  const owner = options.owner ?? 'owner';
  const heldUnder = options.heldBy === 'organisation' ? ORGANISATION_OWNER_KEY : owner;
  let connectionId: Id<'organisationConnections'> | undefined;
  if (options.connection) {
    const configuration = await sealed(
      harness,
      ORGANISATION_OWNER_KEY,
      CONFIGURATION_TOKEN,
      'Slack configuration token',
      {},
    );
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
    appId: LEO_APP_ID,
    clientId: LEO_CLIENT_ID,
    ...(connectionId !== undefined ? { organisationConnectionId: connectionId } : {}),
  };
  const secret = await sealed(harness, heldUnder, LEO_CLIENT_SECRET, 'Leo (Day0) client secret', {
    issuedBy: { ...app, grant: 'app-created' },
  });
  const token = await sealed(harness, heldUnder, LEO_BOT_TOKEN, 'Slack bot token', {
    issuedBy: { ...app, grant: 'oauth-install', clientSecretCredentialId: secret },
  });
  const linearIssuer = {
    system: 'linear',
    grant: 'authorisation-code' as const,
    clientId: 'lin-1',
  };
  const refresh = await sealed(harness, heldUnder, LEO_LINEAR_REFRESH, 'Linear refresh token', {
    issuedBy: linearIssuer,
  });
  const access = await sealed(harness, heldUnder, LEO_LINEAR_ACCESS, 'Linear access token', {
    issuedBy: linearIssuer,
    refreshCredentialId: refresh,
  });
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Leo',
      userId: owner,
      state: 'active',
      createdAt: 1,
    });
    const card = {
      agentId,
      verdict: 'connected' as const,
      whereFound: [],
      credentialLanded: true,
      managerApprovedAt: 1,
      createdAt: 1,
    };
    const slackSurface = await ctx.db.insert('surfaces', {
      ...card,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      credentialId: token,
      credentialKind: 'oauth',
      actsAs: { kind: 'own-app', label: 'Leo (Day0)' },
      ...(connectionId !== undefined ? { organisationConnectionId: connectionId } : {}),
      provisioning: {
        appId: LEO_APP_ID,
        appName: 'Leo (Day0)',
        clientId: LEO_CLIENT_ID,
        clientSecretCredentialId: secret,
        installUrl: 'https://slack.com/oauth/v2/authorize',
        redirectUrl: 'http://localhost:3000/api/oauth/slack',
        scopes: ['chat:write'],
        createdAt: 1,
        installedAt: 2,
        ...(connectionId !== undefined ? { organisationConnectionId: connectionId } : {}),
      },
    });
    const linearSurface = await ctx.db.insert('surfaces', {
      ...card,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      credentialId: access,
      credentialKind: 'oauth',
      actsAs: { kind: 'own-app', label: 'Leo' },
    });
    return {
      agentId,
      slack: { surfaceId: slackSurface, token, secret },
      linear: { surfaceId: linearSurface, access, refresh },
      ...(connectionId !== undefined ? { connectionId } : {}),
    };
  });
}

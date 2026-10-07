import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../convex/schema';
import {
  activeConnectionFor,
  activeSystemsAmong,
  endedByItsRevoke,
  revokeReasonsAmong,
  systemConnectionRevoked,
} from '../../convex/organisationConnectionReads';
import { allConvexModules } from './all-modules';

describe('reading an organisation connection', (): void => {
  it('answers the system’s active connection, never a revoked one or another system’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const active = await harness.run(async (ctx) => {
      const connection = (system: string, status: 'active' | 'revoked') => ({
        system,
        displayName: system,
        kind: 'oauth-app' as const,
        mode: 'shared' as const,
        scopes: ['read'],
        registeredBy: { via: 'setup-cli' as const, at: 1 },
        status,
        createdAt: 1,
      });
      await ctx.db.insert('organisationConnections', connection('linear', 'revoked'));
      await ctx.db.insert('organisationConnections', connection('notion', 'active'));
      return await ctx.db.insert('organisationConnections', connection('linear', 'active'));
    });

    await harness.run(async (ctx) => {
      expect((await activeConnectionFor(ctx, 'linear'))?._id).toBe(active);
      expect(await activeConnectionFor(ctx, 'github')).toBeNull();
    });
  });

  it('says a system was revoked only when IT revoked its connection and none is active since', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ids = await harness.run(async (ctx) => {
      const connection = (system: string, status: 'active' | 'revoked') => ({
        system,
        displayName: system,
        kind: 'oauth-app' as const,
        mode: 'shared' as const,
        scopes: ['read'],
        registeredBy: { via: 'setup-cli' as const, at: 1 },
        status,
        createdAt: 1,
        ...(status === 'revoked' ? { statusReason: `IT moved ${system}` } : {}),
      });
      return {
        linearRevoked: await ctx.db.insert(
          'organisationConnections',
          connection('linear', 'revoked'),
        ),
        linearActive: await ctx.db.insert(
          'organisationConnections',
          connection('linear', 'active'),
        ),
        notionRevoked: await ctx.db.insert(
          'organisationConnections',
          connection('notion', 'revoked'),
        ),
      };
    });

    await harness.run(async (ctx) => {
      expect(await systemConnectionRevoked(ctx, 'notion')).toBe(true);
      expect(await systemConnectionRevoked(ctx, 'linear')).toBe(false);
      expect(await systemConnectionRevoked(ctx, 'github')).toBe(false);
      // A newer connection that needs IT's attention is the system's latest: not a revoked one (m3).
      await ctx.db.insert('organisationConnections', {
        system: 'notion',
        displayName: 'notion',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: ['read'],
        registeredBy: { via: 'setup-cli', at: 2 },
        status: 'needs-attention',
        createdAt: 2,
      });
      expect(await systemConnectionRevoked(ctx, 'notion')).toBe(false);
      expect([...(await activeSystemsAmong(ctx, ['linear', 'notion', 'linear']))]).toEqual([
        'linear',
      ]);
      // Re-pinned for 13-S: the listing reads each revoked connection with IT's reason for it.
      const reasons = await revokeReasonsAmong(ctx, [
        ids.linearRevoked,
        ids.linearActive,
        ids.notionRevoked,
        ids.notionRevoked,
      ]);
      expect([...reasons.keys()].sort()).toEqual([ids.linearRevoked, ids.notionRevoked].sort());
      expect(reasons.get(ids.linearRevoked)).toBe('IT moved linear');
    });
  });

  it('says IT’s revoke ended a card for good when its own app was created through a revoked connection, and until IT connects again otherwise (13-FS)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx) => {
      const connection = (status: 'active' | 'revoked', at: number) =>
        ctx.db.insert('organisationConnections', {
          system: 'slack',
          displayName: 'Slack',
          kind: 'slack-configuration',
          mode: 'per-employee',
          scopes: [],
          registeredBy: { via: 'setup-cli', at },
          status,
          createdAt: at,
        });
      const revoked = await connection('revoked', 1);
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Dara',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const secret = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'oauth',
        label: 'Slack',
        source: 'oauth',
        createdAt: 1,
      });
      const card = async (ownApp: boolean) =>
        (await ctx.db.get(
          await ctx.db.insert('surfaces', {
            agentId,
            slug: ownApp ? 'slack' : 'slack-shared',
            displayName: 'Slack',
            class: 'chat',
            endpoint: 'https://slack.com/api/',
            verdict: 'approved',
            whereFound: [],
            credentialLanded: false,
            organisationConnectionId: revoked,
            ...(ownApp
              ? {
                  provisioning: {
                    appId: 'A-DARA',
                    appName: 'Dara (Day0)',
                    clientId: '1.2',
                    clientSecretCredentialId: secret,
                    installUrl: 'https://slack.com/oauth/v2/authorize',
                    redirectUrl: 'https://day0.test/api/oauth/slack',
                    scopes: [],
                    organisationConnectionId: revoked,
                    createdAt: 1,
                  },
                }
              : {}),
            createdAt: 1,
          }),
        ))!;
      const kept = await card(true);
      const shared = await card(false);
      expect(await endedByItsRevoke(ctx, kept)).toBe('kept-app-ended');
      expect(await endedByItsRevoke(ctx, shared)).toBe('connection-revoked');
      await connection('active', 2);
      expect(await endedByItsRevoke(ctx, kept)).toBe('kept-app-ended');
      expect(await endedByItsRevoke(ctx, shared)).toBeUndefined();
      expect(await endedByItsRevoke(ctx, { ...shared, credentialId: secret })).toBeUndefined();
    });
  });
});

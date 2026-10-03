import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../convex/schema';
import {
  activeConnectionFor,
  activeSystemsAmong,
  revokedConnectionsAmong,
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
      expect(
        [
          ...(await revokedConnectionsAmong(ctx, [
            ids.linearRevoked,
            ids.linearActive,
            ids.notionRevoked,
            ids.notionRevoked,
          ])),
        ].sort(),
      ).toEqual([ids.linearRevoked, ids.notionRevoked].sort());
    });
  });
});

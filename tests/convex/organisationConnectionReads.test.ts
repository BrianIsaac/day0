import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../convex/schema';
import { activeConnectionFor } from '../../convex/organisationConnectionReads';
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
});

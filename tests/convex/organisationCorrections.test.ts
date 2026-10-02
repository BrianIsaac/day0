/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import type { Landing } from '../../convex/organisationConnections';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';

/*
 * The wave 11 review's M12 (e): `check:access` compares a connection's recorded redirect and
 * scopes with what Day0 needs, and neither documented cure (register the address at the vendor;
 * rotate on the organisation page, whose dialog sends no scopes) changed the recorded row, so both
 * gaps survived their fix. The setup command now corrects the recorded redirect and scopes in
 * place, revoking nothing.
 */

type Harness = TestConvex<typeof schema>;

const LINEAR: Landing = {
  system: 'linear',
  displayName: 'Linear',
  kind: 'oauth-app',
  mode: 'shared',
  scopes: ['read'],
  clientCredentialsScopes: ['read', 'write'],
  clientId: 'lin-client-1',
  secret: 'lin_oauth_secret_0123456789',
  redirectUrl: 'https://day0.old.acme.test/api/oauth/linear',
};

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('DAY0_ADMINISTRATORS', 'ines@acme.test');
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** Land Linear as the administrator and answer the connection's id. */
async function landLinear(harness: Harness) {
  return await harness
    .withIdentity(managerIdentity('ines', { email: 'ines@acme.test' }))
    .action(api.organisationConnections.land, LINEAR);
}

describe("correcting a connection's recorded redirect and scopes (the wave 11 review's M12 e)", (): void => {
  it('records what IT registered, keeps the secret and the client-credentials set, and writes one ledger line', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landLinear(harness);
    const before = await harness.run(async (ctx) => await ctx.db.get(connectionId));

    await harness.mutation(internal.organisationCorrections.correctFromSetup, {
      system: 'linear',
      redirectUrl: 'https://day0.acme.test/api/oauth/linear',
      scopes: ['read', 'write'],
    });

    const after = await harness.run(async (ctx) => ({
      connection: await ctx.db.get(connectionId),
      ledger: await ctx.db.query('connectionEvents').collect(),
      credentials: await ctx.db.query('credentials').collect(),
    }));
    expect(after.connection).toMatchObject({
      status: 'active',
      redirectUrl: 'https://day0.acme.test/api/oauth/linear',
      scopes: ['read', 'write'],
      clientCredentialsScopes: ['read', 'write'],
      secretCredentialId: before?.secretCredentialId,
    });
    expect(after.credentials.every((row) => row.revokedAt === undefined)).toBe(true);
    expect(after.ledger.map((line) => [line.type, line.payload])).toEqual([
      ['organisation.connection-landed', expect.anything()],
      [
        'organisation.connection-corrected',
        {
          organisationConnectionId: connectionId,
          system: 'linear',
          displayName: 'Linear',
          via: 'setup-cli',
          redirectCorrected: true,
          scopes: ['read', 'write'],
          previousScopes: ['read'],
        },
      ],
    ]);
  });

  it('writes nothing when nothing differs, and refuses a system with no connection or a malformed value', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landLinear(harness);

    await expect(
      harness.mutation(internal.organisationCorrections.correctFromSetup, {
        system: 'linear',
        redirectUrl: LINEAR.redirectUrl,
        scopes: ['read'],
      }),
    ).resolves.toEqual({ changed: false });
    for (const correction of [
      { system: 'slack', scopes: ['chat:write'] },
      { system: 'linear', redirectUrl: 'not an address' },
      { system: 'linear', redirectUrl: 'http://day0.acme.test/api/oauth/linear' },
      { system: 'linear', scopes: ['read', ' '] },
    ]) {
      await expect(
        harness.mutation(internal.organisationCorrections.correctFromSetup, correction),
      ).rejects.toThrow();
    }
    const ledger = await harness.run(
      async (ctx) => await ctx.db.query('connectionEvents').collect(),
    );
    expect(ledger.map((line) => line.type)).toEqual(['organisation.connection-landed']);
  });
});

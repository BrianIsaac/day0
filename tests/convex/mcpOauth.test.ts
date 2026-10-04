import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import {
  MCP_MIN_REFRESH_INTERVAL_MS,
  MCP_REFRESH_LEAD_MS,
  refreshDueAt,
} from '../../convex/mcpOauth';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS } from './fakes/manager-identity';
import { goneRowOf, guardRefusal } from './fakes/anonymous-caller';

const SEALED = { ciphertext: 'sealed', iv: 'iv', keyId: 'key' };
const ISSUED_BY = { system: 'mcp:auth.acme.test', grant: 'authorisation-code' as const };
const ACTS_AS = { kind: 'delegated' as const, label: MANAGER_ADDRESS };

beforeEach((): void => {
  useSurfaceMode('real');
});

afterEach((): void => {
  restoreSurfaceMode();
});

async function liveApi(): Promise<typeof import('../../convex/_generated/api')> {
  return await import('../../convex/_generated/api');
}

async function seedCard(
  harness: TestConvex<typeof schema>,
  held?: 'pasted' | 'issued',
): Promise<{ agentId: Id<'agents'>; surfaceId: Id<'surfaces'>; heldIds: Id<'credentials'>[] }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Maya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const heldIds: Id<'credentials'>[] = [];
    if (held === 'pasted') {
      heldIds.push(
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: 'Docs key',
          ...SEALED,
          source: 'entered',
          createdAt: 1,
        }),
      );
    }
    if (held === 'issued') {
      const refresh = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'oauth',
        label: 'Acme docs refresh token',
        ...SEALED,
        source: 'oauth',
        createdAt: 1,
        issuedBy: ISSUED_BY,
      });
      heldIds.push(
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'oauth',
          label: 'Acme docs access token',
          ...SEALED,
          source: 'oauth',
          createdAt: 1,
          issuedBy: ISSUED_BY,
          refreshCredentialId: refresh,
          generation: 3,
        }),
        refresh,
      );
    }
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'docs',
      displayName: 'Acme docs',
      class: 'docs',
      verdict: 'ungranted',
      whereFound: [],
      path: 'mcp',
      endpoint: 'https://auth.acme.test/mcp',
      managerApprovedAt: 2,
      credentialLanded: true,
      ...(heldIds[0] ? { credentialId: heldIds[0], credentialKind: 'oauth' as const } : {}),
      createdAt: 1,
    });
    return { agentId, surfaceId, heldIds };
  });
}

async function land(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
  ownerKey = 'owner',
): Promise<Id<'credentials'>> {
  const { internal } = await liveApi();
  return await harness.mutation(internal.mcpOauth.landAuthorisedTokens, {
    surfaceId,
    ownerKey,
    access: SEALED,
    refresh: SEALED,
    expiresAt: 10_000_000,
    issuedBy: ISSUED_BY,
    actsAs: ACTS_AS,
    issuer: 'https://auth.acme.test',
    now: 1_000,
  });
}

describe('when the scheduled refresh runs', (): void => {
  it('runs five minutes before the expiry, or half way through a shorter life', (): void => {
    expect(refreshDueAt(1_000_000 + 3_600_000, 1_000_000)).toBe(
      1_000_000 + 3_600_000 - MCP_REFRESH_LEAD_MS,
    );
    expect(refreshDueAt(1_000_000 + 300_000, 1_000_000)).toBe(1_000_000 + 150_000);
  });

  it('never runs sooner than half a minute away, however short the life or late the clock', (): void => {
    expect(refreshDueAt(1_000_000 + 2_000, 1_000_000)).toBe(
      1_000_000 + MCP_MIN_REFRESH_INTERVAL_MS,
    );
    expect(refreshDueAt(500, 1_000)).toBe(1_000 + MCP_MIN_REFRESH_INTERVAL_MS);
  });
});

describe('landing an authorisation’s tokens', (): void => {
  it('binds the new pair, sends the card back to be probed and leaves a pasted key it held alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, heldIds } = await seedCard(harness, 'pasted');
    const credentialId = await land(harness, surfaceId);
    const after = await harness.run(async (ctx) => ({
      surface: await ctx.db.get(surfaceId),
      pasted: await ctx.db.get(heldIds[0]),
    }));
    expect(after.surface).toMatchObject({
      credentialId,
      credentialKind: 'oauth',
      credentialLanded: false,
      verdict: 'approved',
      actsAs: ACTS_AS,
    });
    expect(after.pasted?.revokedAt).toBeUndefined();
    expect(after.pasted?.sourceRevocation).toBeUndefined();
  });

  it('retires the pair Day0 obtained before, keeping its ciphertext for the revocation at the vendor', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, heldIds } = await seedCard(harness, 'issued');
    await land(harness, surfaceId);
    const replaced = await harness.run(
      async (ctx) => await Promise.all(heldIds.map(async (id) => await ctx.db.get(id))),
    );
    for (const row of replaced) {
      expect(row).toMatchObject({
        revokedAt: 1_000,
        ciphertext: 'sealed',
        sourceRevocation: { state: 'pending', attempts: 0, end: 'disconnect' },
      });
    }
  });

  it('ends the pair it replaces through the end of access, scheduling the revocation at the vendor (join 4)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, heldIds } = await seedCard(harness, 'issued');
    await land(harness, surfaceId);
    const attempts = await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name === 'sourceRevocationActions:attempt',
      ),
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.args[0]).toMatchObject({
      credentialId: heldIds[0],
      companionIds: [heldIds[1]],
      surfaceId,
    });
  });

  it('keeps a newer authorisation the manager started while the code was being exchanged', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    const newer = {
      stateNonce: 'nonce-2',
      stateExpiresAt: 50_000,
      clientId: 'day0-mcp',
      verifierCiphertext: 'c',
      verifierIv: 'i',
      issuer: 'https://auth.acme.test',
      resource: 'https://auth.acme.test/mcp',
      redirectUrl: 'https://day0.acme.test/api/oauth/mcp',
      startedAt: 2,
    };
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, { pendingAuthorisation: newer });
    });
    await land(harness, surfaceId);
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.pendingAuthorisation).toEqual(newer);
  });

  it('leaves alone an issued credential another card still holds', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId, heldIds } = await seedCard(harness, 'issued');
    await harness.run(async (ctx) => {
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'docs-two',
        displayName: 'Acme docs two',
        class: 'docs',
        verdict: 'connected',
        whereFound: [],
        path: 'mcp',
        endpoint: 'https://auth.acme.test/mcp',
        managerApprovedAt: 2,
        credentialLanded: true,
        credentialId: heldIds[0],
        credentialKind: 'oauth',
        createdAt: 1,
      });
    });
    await land(harness, surfaceId);
    const shared = await harness.run(async (ctx) => await ctx.db.get(heldIds[0]));
    expect(shared?.revokedAt).toBeUndefined();
    expect(shared?.sourceRevocation).toBeUndefined();
  });

  it('refuses tokens for an employee that changed hands since the authorisation started', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    await expect(land(harness, surfaceId, 'previous-owner')).rejects.toThrow('changed hands');
    const credentials = await harness.run(
      async (ctx) => await ctx.db.query('credentials').collect(),
    );
    expect(credentials).toEqual([]);
  });
});

describe('claiming a pending authorisation', (): void => {
  it('lets one of two redirects for the same nonce win', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, {
        pendingAuthorisation: {
          stateNonce: 'nonce-1',
          stateExpiresAt: 50_000,
          clientId: 'day0-mcp',
          verifierCiphertext: 'c',
          verifierIv: 'i',
          issuer: 'https://auth.acme.test',
          resource: 'https://auth.acme.test/mcp',
          redirectUrl: 'https://day0.acme.test/api/oauth/mcp',
          startedAt: 1,
        },
      });
    });
    const { internal } = await liveApi();
    const claim = async (): Promise<boolean> =>
      (
        await harness.mutation(internal.mcpOauth.claimPendingAuthorisation, {
          surfaceId,
          stateNonce: 'nonce-1',
          callerOwnerKey: 'owner',
          now: 2_000,
        })
      ).ok;
    const outcomes = await Promise.all([claim(), claim()]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.pendingAuthorisation).toBeUndefined();
  });

  it("leaves another flow's pending authorisation for its own redirect (the review's m3)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, {
        pendingAuthorisation: {
          stateNonce: 'nonce-linear',
          stateExpiresAt: 50_000,
          clientId: 'day0-leo',
          verifierCiphertext: 'c',
          verifierIv: 'i',
          issuer: 'https://linear.app',
          resource: 'https://mcp.linear.app/mcp',
          redirectUrl: 'https://day0.acme.test/api/oauth/linear',
          startedAt: 1,
        },
      });
    });
    const { internal } = await liveApi();

    const refused = await harness.mutation(internal.mcpOauth.claimPendingAuthorisation, {
      surfaceId,
      stateNonce: 'nonce-linear',
      callerOwnerKey: 'owner',
      now: 2_000,
    });

    expect(refused).toEqual({ ok: false, reason: 'none' });
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.pendingAuthorisation?.stateNonce).toBe('nonce-linear');
  });

  it('claims its own authorisation whose recorded redirect IT wrote with a trailing slash', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, {
        pendingAuthorisation: {
          stateNonce: 'nonce-slash',
          stateExpiresAt: 50_000,
          clientId: 'day0-mcp',
          verifierCiphertext: 'c',
          verifierIv: 'i',
          issuer: 'https://auth.acme.test',
          resource: 'https://auth.acme.test/mcp',
          redirectUrl: 'https://day0.acme.test/api/oauth/mcp/',
          startedAt: 1,
        },
      });
    });
    const { internal } = await liveApi();

    const claimed = await harness.mutation(internal.mcpOauth.claimPendingAuthorisation, {
      surfaceId,
      stateNonce: 'nonce-slash',
      callerOwnerKey: 'owner',
      now: 2_000,
    });

    expect(claimed.ok).toBe(true);
  });

  it("refuses a caller who is not the employee's owner before it claims anything (M2)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seedCard(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, {
        pendingAuthorisation: {
          stateNonce: 'nonce-1',
          stateExpiresAt: 50_000,
          clientId: 'day0-mcp',
          verifierCiphertext: 'c',
          verifierIv: 'i',
          issuer: 'https://auth.acme.test',
          resource: 'https://auth.acme.test/mcp',
          redirectUrl: 'https://day0.acme.test/api/oauth/mcp',
          startedAt: 1,
        },
      });
    });
    const { internal } = await liveApi();

    const refused = await harness.mutation(internal.mcpOauth.claimPendingAuthorisation, {
      surfaceId,
      stateNonce: 'nonce-1',
      callerOwnerKey: 'colleague',
      now: 2_000,
    });

    expect(refused).toEqual({ ok: false, reason: 'not-the-manager' });
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface?.pendingAuthorisation?.stateNonce).toBe('nonce-1');
  });
});

describe('writing a refresh’s rotation', (): void => {
  it('writes nothing over a refresh token an end of access revoked meanwhile (the review’s m12)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { heldIds } = await seedCard(harness, 'issued');
    const [accessId, refreshId] = heldIds as [Id<'credentials'>, Id<'credentials'>];
    await harness.run(async (ctx) => {
      await ctx.db.patch(refreshId, { revokedAt: 1_500, ciphertext: undefined, iv: undefined });
    });
    const { internal } = await liveApi();

    const outcome = await harness.mutation(internal.mcpOauth.rotateTokens, {
      credentialId: accessId,
      expectedGeneration: 3,
      access: { ...SEALED, ciphertext: 'renewed-access' },
      refresh: { ...SEALED, ciphertext: 'renewed-refresh' },
      expiresAt: 10_000_000,
      now: 2_000,
    });

    expect(outcome).toEqual({ ok: false, reason: 'gone' });
    const [access, refresh] = await harness.run(
      async (ctx) => await Promise.all([ctx.db.get(accessId), ctx.db.get(refreshId)]),
    );
    expect(refresh?.ciphertext).toBeUndefined();
    expect(access).toMatchObject({ ciphertext: 'sealed', generation: 3 });
  });
});

describe('the anonymous-caller guard before the first read (12-G)', (): void => {
  it('refuses a caller with no identity before it says whether the card exists', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const refusal = await guardRefusal();
    const surfaceId = await goneRowOf(harness, 'surfaces');
    await expect(
      harness.mutation(api.mcpOauth.cancelAuthorisation, { surfaceId }),
    ).rejects.toMatchObject(refusal);
  });
});

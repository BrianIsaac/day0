import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { REFRESH_LEASE_MS } from '../../src/surfaces/refresh-lease';
import { allConvexModules } from './all-modules';

const NOW = 1_800_000_000_000;

/** An access token and its paired refresh token, as an issuer's landing writes them. */
async function seedPair(
  harness: TestConvex<typeof schema>,
  access: {
    readonly generation?: number;
    readonly refreshingUntil?: number;
    readonly revokedAt?: number;
  } = {},
  refresh: { readonly revokedAt?: number } = {},
): Promise<{ accessId: Id<'credentials'>; refreshId: Id<'credentials'> }> {
  return await harness.run(async (ctx) => {
    const row = {
      userId: 'owner',
      kind: 'oauth' as const,
      source: 'oauth' as const,
      ciphertext: 'sealed',
      iv: 'iv',
      keyId: 'key-1',
      createdAt: 1,
      issuedBy: { system: 'linear', grant: 'authorisation-code' as const },
    };
    const refreshId = await ctx.db.insert('credentials', {
      ...row,
      label: 'Linear refresh token',
      ...refresh,
    });
    const accessId = await ctx.db.insert('credentials', {
      ...row,
      label: 'Linear access token',
      refreshCredentialId: refreshId,
      ...access,
    });
    return { accessId, refreshId };
  });
}

async function leaseOf(
  harness: TestConvex<typeof schema>,
  credentialId: Id<'credentials'>,
): Promise<number | null> {
  // A run's answer crosses a serialisation, which carries no undefined: an absent lease reads null.
  return await harness.run(
    async (ctx) => (await ctx.db.get(credentialId))?.refreshingUntil ?? null,
  );
}

describe('the refresh lease (R-S; the wave 11 review’s m11)', (): void => {
  it('takes the lease with the refresh token of the same snapshot, and a second claim waits', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { accessId, refreshId } = await seedPair(harness, { generation: 2 });
    const first = await harness.mutation(internal.refreshLease.claim, {
      credentialId: accessId,
      expectedGeneration: 2,
      now: NOW,
    });
    expect(first).toMatchObject({ kind: 'claimed', leaseUntil: NOW + REFRESH_LEASE_MS });
    expect(first.kind === 'claimed' ? first.refresh._id : undefined).toBe(refreshId);
    await expect(
      harness.mutation(internal.refreshLease.claim, {
        credentialId: accessId,
        expectedGeneration: 2,
        now: NOW + 1,
      }),
    ).resolves.toEqual({ kind: 'leased', until: NOW + REFRESH_LEASE_MS });
    expect(await leaseOf(harness, accessId)).toBe(NOW + REFRESH_LEASE_MS);
  });

  it('lets the next refresh take a lease that lapsed, and the old holder’s release leave it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { accessId } = await seedPair(harness, { refreshingUntil: NOW - 1 });
    const claimed = await harness.mutation(internal.refreshLease.claim, {
      credentialId: accessId,
      expectedGeneration: 0,
      now: NOW,
    });
    expect(claimed.kind).toBe('claimed');
    await harness.mutation(internal.refreshLease.release, {
      credentialId: accessId,
      leaseUntil: NOW - 1,
    });
    expect(await leaseOf(harness, accessId)).toBe(NOW + REFRESH_LEASE_MS);
    await harness.mutation(internal.refreshLease.release, {
      credentialId: accessId,
      leaseUntil: NOW + REFRESH_LEASE_MS,
    });
    expect(await leaseOf(harness, accessId)).toBeNull();
  });

  it('sends a refresh whose pair moved on to the winner, and writes nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { accessId } = await seedPair(harness, { generation: 3 });
    await expect(
      harness.mutation(internal.refreshLease.claim, {
        credentialId: accessId,
        expectedGeneration: 2,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: 'moved' });
    expect(await leaseOf(harness, accessId)).toBeNull();
  });

  it('takes no lease on a revoked access token, nor on one whose refresh token is revoked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const revoked = await seedPair(harness, { revokedAt: NOW - 5 });
    await expect(
      harness.mutation(internal.refreshLease.claim, {
        credentialId: revoked.accessId,
        expectedGeneration: 0,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: 'gone' });
    const spent = await seedPair(harness, {}, { revokedAt: NOW - 5 });
    await expect(
      harness.mutation(internal.refreshLease.claim, {
        credentialId: spent.accessId,
        expectedGeneration: 0,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: 'no-refresh-token' });
    expect(await leaseOf(harness, revoked.accessId)).toBeNull();
    expect(await leaseOf(harness, spent.accessId)).toBeNull();
  });

  it('is ended by the rotation the holder writes', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { accessId } = await seedPair(harness);
    await harness.mutation(internal.refreshLease.claim, {
      credentialId: accessId,
      expectedGeneration: 0,
      now: NOW,
    });
    await expect(
      harness.mutation(internal.mcpOauth.rotateTokens, {
        credentialId: accessId,
        expectedGeneration: 0,
        access: { ciphertext: 'next', iv: 'iv', keyId: 'key-1' },
        now: NOW,
      }),
    ).resolves.toEqual({ ok: true, generation: 1 });
    expect(await leaseOf(harness, accessId)).toBeNull();
  });
});

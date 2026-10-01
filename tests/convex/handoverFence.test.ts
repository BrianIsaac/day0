import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  CREDENTIAL_NOT_THE_OWNERS,
  credentialOwnerRefusal,
  handedOverSince,
  openTransferOf,
} from '../../convex/handoverFence';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/*
 * The fences a handover puts round an employee in real mode (the wave 9 review's M5, U3-m2,
 * U3-m3, U5-m4), each read the way its writers read it. The writers' own refusals are tested
 * beside them: `surfaces.credential-owner`, `work`, `intakeSeed`, `agents`, `skills`.
 */

type Harness = TestConvex<typeof schema>;

afterEach((): void => {
  vi.useRealTimers();
});

/** Seed Maya, owned by `userId` (or by nobody, for a row from before owners). */
async function seedMaya(harness: Harness, userId?: string): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        ...(userId === undefined ? {} : { userId }),
        state: 'active',
        createdAt: 1,
      }),
  );
}

/** A credential row of `userId`. */
async function seedCredential(harness: Harness, userId: string): Promise<Id<'credentials'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('credentials', {
        userId,
        kind: 'value',
        label: 'Linear token',
        ciphertext: 'sealed',
        iv: 'iv',
        source: 'entered',
        createdAt: 1,
      }),
  );
}

describe('credentialOwnerRefusal', (): void => {
  it('allows a credential of the employee’s current owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedMaya(harness, 'owner');
    const credentialId = await seedCredential(harness, 'owner');

    await expect(
      harness.run(async (ctx) => await credentialOwnerRefusal(ctx.db, agentId, credentialId)),
    ).resolves.toBeNull();
  });

  it('refuses another owner’s credential, one whose row is gone, and any for an employee with no owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owned = await seedMaya(harness, 'colleague');
    const unowned = await seedMaya(harness);
    const oldOwners = await seedCredential(harness, 'owner');
    const gone = await seedCredential(harness, 'colleague');
    await harness.run(async (ctx) => {
      await ctx.db.delete(gone);
    });

    const refusals = await harness.run(
      async (ctx) =>
        await Promise.all([
          credentialOwnerRefusal(ctx.db, owned, oldOwners),
          credentialOwnerRefusal(ctx.db, owned, gone),
          credentialOwnerRefusal(ctx.db, unowned, oldOwners),
        ]),
    );

    expect(refusals).toEqual([
      CREDENTIAL_NOT_THE_OWNERS,
      CREDENTIAL_NOT_THE_OWNERS,
      CREDENTIAL_NOT_THE_OWNERS,
    ]);
  });
});

describe('handedOverSince', (): void => {
  it('answers whether the move’s event was written after the instant', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 2, 9, 0));
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedMaya(harness, 'colleague');
    const before = Date.now() - 1;
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type: 'manager.transferred',
        payload: {},
        createdAt: Date.now(),
      });
    });
    vi.setSystemTime(Date.UTC(2026, 9, 2, 9, 5));
    const after = Date.now();

    const answers = await harness.run(
      async (ctx) =>
        await Promise.all([
          handedOverSince(ctx.db, agentId, before),
          handedOverSince(ctx.db, agentId, after),
        ]),
    );

    expect(answers).toEqual([true, false]);
  });
});

describe('openTransferOf', (): void => {
  it('reads an asked request before its expiry and an accepting one, never one past its expiry', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const asked = await seedMaya(harness, 'owner');
    const expired = await seedMaya(harness, 'owner');
    const accepting = await seedMaya(harness, 'owner');
    const now = Date.now();
    const request = (agentId: Id<'agents'>, state: 'asked' | 'accepting', expiresAt: number) => ({
      agentId,
      agentName: 'Maya',
      fromOwnerKey: 'owner',
      fromAddress: MANAGER_ADDRESS,
      toAddress: 'colleague@day0.local',
      state,
      requestedAt: 1,
      expiresAt,
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('managerTransfers', request(asked, 'asked', now + 60_000));
      await ctx.db.insert('managerTransfers', request(expired, 'asked', now - 1));
      await ctx.db.insert('managerTransfers', request(accepting, 'accepting', now - 1));
    });

    const open = await harness.run(
      async (ctx) =>
        await Promise.all(
          [asked, expired, accepting].map(
            async (agentId) => (await openTransferOf(ctx.db, agentId, now))?.state ?? null,
          ),
        ),
    );

    expect(open).toEqual(['asked', null, 'accepting']);
  });
});

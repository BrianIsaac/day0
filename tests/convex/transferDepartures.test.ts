/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import type { WithoutSystemFields } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { TRANSFER_EXPIRY_MS } from '../../src/agent/manager-transfer';
import { allConvexModules } from './all-modules';
import {
  fixtureAddressOf,
  MANAGER_ADDRESS,
  managerIdentity,
  OWNER_SUBJECT,
} from './fakes/manager-identity';

type Harness = TestConvex<typeof schema>;

/** The owner (A), who hands over; Priya (B), who takes on; Wei, a third account. */
const OWNER = managerIdentity();
const PRIYA = managerIdentity('priya');
const PRIYA_ADDRESS = fixtureAddressOf('priya');
const WEI = managerIdentity('wei');

afterEach((): void => {
  vi.useRealTimers();
});

/** An employee, the owner's unless the fields say whose. */
async function employee(
  harness: Harness,
  name = 'Maya',
  fields: Partial<WithoutSystemFields<Doc<'agents'>>> = {},
): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name,
        userId: OWNER_SUBJECT,
        state: 'active',
        zone: 'Europe/London',
        createdAt: 1,
        ...fields,
      }),
  );
}

/** A request inserted directly, as an ask and its answer would have written it. */
async function insertRequest(
  harness: Harness,
  fields: Partial<WithoutSystemFields<Doc<'managerTransfers'>>> & { agentId: Id<'agents'> },
): Promise<Id<'managerTransfers'>> {
  const requestedAt = fields.requestedAt ?? 1_000;
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('managerTransfers', {
        agentName: 'Maya',
        fromOwnerKey: OWNER_SUBJECT,
        fromAddress: MANAGER_ADDRESS,
        toAddress: PRIYA_ADDRESS,
        state: 'asked',
        requestedAt,
        expiresAt: requestedAt + TRANSFER_EXPIRY_MS,
        ...fields,
      }),
  );
}

describe('transferDepartures.employeePage', (): void => {
  it('opens the page on the caller’s own employee, and on no employee at all, for the page to say so', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const gone = await employee(harness, 'Wren');
    await harness.run(async (ctx) => await ctx.db.delete(gone));
    const asOwner = harness.withIdentity(OWNER);
    for (const agentId of [maya, gone, 'not-an-id', 'j57' as string]) {
      expect(await asOwner.query(api.transferDepartures.employeePage, { agentId })).toEqual({
        page: 'employee',
      });
    }
    // An anonymous caller is left to the page's own read, which the session gate sits before.
    expect(await harness.query(api.transferDepartures.employeePage, { agentId: maya })).toEqual({
      page: 'employee',
    });
  });

  it('says where a handed-over employee went, to the account that handed it over only, without a refusal', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness, 'Maya', { userId: 'priya' });
    const transferId = await insertRequest(harness, {
      agentId: maya,
      state: 'accepted',
      decidedAt: 7_000,
      toOwnerKey: 'priya',
    });
    expect(
      await harness
        .withIdentity(OWNER)
        .query(api.transferDepartures.employeePage, { agentId: maya }),
    ).toEqual({
      page: 'departed',
      departure: { transferId, agentName: 'Maya', toAddress: PRIYA_ADDRESS, decidedAt: 7_000 },
    });
    expect(
      await harness
        .withIdentity(PRIYA)
        .query(api.transferDepartures.employeePage, { agentId: maya }),
    ).toEqual({ page: 'employee' });
    expect(
      await harness.withIdentity(WEI).query(api.transferDepartures.employeePage, { agentId: maya }),
    ).toEqual({ page: 'not-yours' });
  });

  it('says an employee handed over has since been retired, or has moved on to another manager', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const wren = await employee(harness, 'Wren', { userId: 'priya' });
    const wes = await employee(harness, 'Wes', { userId: 'wei' });
    for (const agentId of [wren, wes]) {
      await insertRequest(harness, {
        agentId,
        state: 'accepted',
        decidedAt: 7_000,
        toOwnerKey: 'priya',
      });
    }
    await insertRequest(harness, {
      agentId: wes,
      fromOwnerKey: 'priya',
      fromAddress: PRIYA_ADDRESS,
      toAddress: fixtureAddressOf('wei'),
      state: 'accepted',
      decidedAt: 9_000,
      toOwnerKey: 'wei',
    });
    await harness.run(async (ctx) => await ctx.db.delete(wren));
    const asOwner = harness.withIdentity(OWNER);
    expect(await asOwner.query(api.transferDepartures.employeePage, { agentId: wren })).toEqual({
      page: 'departed',
      departure: expect.objectContaining({ afterwards: 'retired', toAddress: PRIYA_ADDRESS }),
    });
    expect(await asOwner.query(api.transferDepartures.employeePage, { agentId: wes })).toEqual({
      page: 'departed',
      departure: expect.objectContaining({ afterwards: 'moved-on', toAddress: PRIYA_ADDRESS }),
    });
  });

  it('opens the page on an employee handed back to the caller since, retired or not', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await insertRequest(harness, {
      agentId: maya,
      state: 'accepted',
      decidedAt: 7_000,
      toOwnerKey: 'priya',
    });
    await insertRequest(harness, {
      agentId: maya,
      fromOwnerKey: 'priya',
      fromAddress: PRIYA_ADDRESS,
      toAddress: MANAGER_ADDRESS,
      state: 'accepted',
      decidedAt: 9_000,
      toOwnerKey: OWNER_SUBJECT,
    });
    const asOwner = harness.withIdentity(OWNER);
    expect(await asOwner.query(api.transferDepartures.employeePage, { agentId: maya })).toEqual({
      page: 'employee',
    });
    await harness.run(async (ctx) => await ctx.db.delete(maya));
    expect(await asOwner.query(api.transferDepartures.employeePage, { agentId: maya })).toEqual({
      page: 'employee',
    });
  });
});

describe('transferDepartures.employeePage, the harder cases', (): void => {
  it('follows the reader’s last handover of an employee handed over twice, never an earlier one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness, 'Maya', { userId: 'wei' });
    const toPriya = await insertRequest(harness, {
      agentId: maya,
      state: 'accepted',
      decidedAt: 2_000,
      toOwnerKey: 'priya',
    });
    await insertRequest(harness, {
      agentId: maya,
      fromOwnerKey: 'priya',
      fromAddress: PRIYA_ADDRESS,
      toAddress: MANAGER_ADDRESS,
      state: 'accepted',
      decidedAt: 3_000,
      toOwnerKey: OWNER_SUBJECT,
    });
    const toWei = await insertRequest(harness, {
      agentId: maya,
      toAddress: fixtureAddressOf('wei'),
      state: 'accepted',
      decidedAt: 4_000,
      toOwnerKey: 'wei',
    });
    const page = await harness
      .withIdentity(OWNER)
      .query(api.transferDepartures.employeePage, { agentId: maya });
    expect(page).toEqual({
      page: 'departed',
      departure: expect.objectContaining({ transferId: toWei, decidedAt: 4_000 }),
    });
    expect(page).not.toEqual(
      expect.objectContaining({ departure: expect.objectContaining({ transferId: toPriya }) }),
    );
  });

  it('opens the page while a handover is accepting: the employee is the reader’s until it moves', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await insertRequest(harness, {
      agentId: maya,
      state: 'accepting',
      decidedAt: 2_000,
      toOwnerKey: 'priya',
      settleBy: 9_000,
    });
    expect(
      await harness
        .withIdentity(OWNER)
        .query(api.transferDepartures.employeePage, { agentId: maya }),
    ).toEqual({ page: 'employee' });
  });

  it('calls an employee with no owner not the reader’s, as the page’s own read refuses it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const orphan = await employee(harness, 'Orphan', { userId: undefined });
    expect(
      await harness
        .withIdentity(OWNER)
        .query(api.transferDepartures.employeePage, { agentId: orphan }),
    ).toEqual({ page: 'not-yours' });
  });
});

describe('transferDepartures.keptAtRetire', (): void => {
  it('counts the handover requests a retire keeps, in every state, to the owner only', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const wes = await employee(harness, 'Wes');
    expect(
      await harness
        .withIdentity(OWNER)
        .query(api.transferDepartures.keptAtRetire, { agentId: maya }),
    ).toEqual({ requests: 0 });
    for (const state of ['asked', 'declined', 'cancelled'] as const) {
      await insertRequest(harness, { agentId: maya, state, decidedAt: 2_000 });
    }
    await insertRequest(harness, { agentId: wes, state: 'declined', decidedAt: 2_000 });
    expect(
      await harness
        .withIdentity(OWNER)
        .query(api.transferDepartures.keptAtRetire, { agentId: maya }),
    ).toEqual({ requests: 3 });
    await expect(
      harness.withIdentity(WEI).query(api.transferDepartures.keptAtRetire, { agentId: maya }),
    ).rejects.toThrow();
  });
});

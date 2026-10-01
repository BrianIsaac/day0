/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import type { WithoutSystemFields } from 'convex/server';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { MANAGER_ADDRESS_REFUSAL } from '../../src/agent/manager-address';
import {
  addressBoundRefusal,
  DECLINE_REASON_TOO_LONG,
  EVALUATION_ADDRESS_TRANSFER_REFUSAL,
  EVALUATION_EMPLOYEE_TRANSFER_REFUSAL,
  LOCAL_DEV_TRANSFER_REFUSAL,
  NOTE_TOO_LONG,
  openTransferRefusal,
  ownAddressRefusal,
  OWNER_DAILY_BOUND_REFUSAL,
  OWNER_OPEN_BOUND_REFUSAL,
  sameAddressRefusal,
  TRANSFER_DEPARTURES_WINDOW_MS,
  TRANSFER_EXPIRY_MS,
  TRANSFER_NOT_FOUND,
  transferStateRefusal,
  UNVERIFIED_FOR_ASK,
  UNVERIFIED_FOR_TRANSFER,
} from '../../src/agent/manager-transfer';
import { credentialOwnerBinding, encrypt } from '../../src/lib/credential-crypto';
import { allConvexModules } from './all-modules';
import {
  fixtureAddressOf,
  localIssuerIdentity,
  MANAGER_ADDRESS,
  managerIdentity,
  OWNER_SUBJECT,
} from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

type Harness = TestConvex<typeof schema>;

/** The owner (A), who asks; Priya (B), whom the request names; Wei, a third account. */
const OWNER = managerIdentity();
const PRIYA = managerIdentity('priya');
const PRIYA_ADDRESS = fixtureAddressOf('priya');
const WEI = managerIdentity('wei');

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** An employee of an owner's, with nothing waiting. */
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

/** The request row as stored. */
async function request(
  harness: Harness,
  transferId: Id<'managerTransfers'>,
): Promise<Doc<'managerTransfers'> | null> {
  return await harness.run(async (ctx) => await ctx.db.get(transferId));
}

/** The employee's handover events, oldest first, as type and payload. */
async function handoverEvents(
  harness: Harness,
  agentId: Id<'agents'>,
): Promise<Array<{ type: string; payload: unknown }>> {
  return await harness.run(async (ctx) =>
    (
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect()
    )
      .filter((event) => event.type.startsWith('manager.transfer-'))
      .map(({ type, payload }) => ({ type, payload: payload as unknown })),
  );
}

/** The words a call was refused with, or a note that it was not refused. */
async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error instanceof ConvexError ? error.data : `not a ConvexError: ${String(error)}`;
  }
  return 'not refused';
}

/** An asked request inserted directly, as an earlier ask would have written it. */
async function insertRequest(
  harness: Harness,
  fields: Partial<WithoutSystemFields<Doc<'managerTransfers'>>> & { agentId: Id<'agents'> },
): Promise<Id<'managerTransfers'>> {
  const requestedAt = fields.requestedAt ?? Date.now();
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

describe('managerTransfers.ask', (): void => {
  it('writes an asked request naming the address as one spelling, expiring in 14 days, and changes nothing about the employee', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 9));
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const before = await harness.run(async (ctx) => await ctx.db.get(maya));

    const transferId = await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: '  Priya@Day0.Local ',
      note: '  Owns the close checklist; the Linear key is with finance.  ',
    });

    expect(await request(harness, transferId)).toMatchObject({
      agentId: maya,
      agentName: 'Maya',
      fromOwnerKey: OWNER_SUBJECT,
      fromAddress: MANAGER_ADDRESS,
      toAddress: PRIYA_ADDRESS,
      note: 'Owns the close checklist; the Linear key is with finance.',
      state: 'asked',
      requestedAt: Date.UTC(2026, 9, 1, 9),
      expiresAt: Date.UTC(2026, 9, 15, 9),
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(maya))).toEqual(before);
    expect(await handoverEvents(harness, maya)).toEqual([
      {
        type: 'manager.transfer-asked',
        payload: {
          transferId,
          fromAddress: MANAGER_ADDRESS,
          toAddress: PRIYA_ADDRESS,
          hasNote: true,
        },
      },
    ]);
  });

  it('stores the note with every recognisable secret shape replaced', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: 'The bot token is xoxb-1234567890-abcdefghij for now.',
    });
    const stored = (await request(harness, transferId))?.note;
    expect(stored).toContain('<redacted>');
    expect(stored).not.toContain('xoxb-1234567890');
  });

  it('stores no note for a blank one and says so on the event', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: '   ',
    });
    expect((await request(harness, transferId))?.note).toBeUndefined();
    expect((await handoverEvents(harness, maya))[0]?.payload).toMatchObject({ hasNote: false });
  });

  it('refuses the employee of another account and an anonymous caller', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await expect(
      harness
        .withIdentity(WEI)
        .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS }),
    ).rejects.toThrow('forbidden');
    await expect(
      harness.mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS }),
    ).rejects.toThrow();
  });

  it('refuses on an installation that signs everyone in as one manager, with the words People shows', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness, 'Maya', { userId: localIssuerIdentity().subject });
    expect(
      await refusal(
        harness
          .withIdentity(localIssuerIdentity())
          .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS }),
      ),
    ).toBe(LOCAL_DEV_TRANSFER_REFUSAL);
  });

  it('lets the local account hand over under the customer-local profile, where it is one manager among several', async (): Promise<void> => {
    vi.stubEnv('DAY0_PROFILE', 'customer-local');
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness, 'Maya', { userId: localIssuerIdentity().subject });
    const transferId = await harness
      .withIdentity(localIssuerIdentity())
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    expect((await request(harness, transferId))?.state).toBe('asked');
  });

  it('refuses an evaluation employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const evaluation = await employee(harness, 'Day0 evaluation 1', {
      bossEmail: 'eval-day0-r1-1789588800000@day0.local',
    });
    expect(
      await refusal(
        harness
          .withIdentity(OWNER)
          .mutation(api.managerTransfers.ask, { agentId: evaluation, toAddress: PRIYA_ADDRESS }),
      ),
    ).toBe(EVALUATION_EMPLOYEE_TRANSFER_REFUSAL);
  });

  it('refuses a caller whose sign-in asserts no verified address, since the request names who asked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    for (const unverified of [
      managerIdentity(OWNER_SUBJECT, { emailVerified: false }),
      managerIdentity(OWNER_SUBJECT, { email: undefined }),
    ]) {
      expect(
        await refusal(
          harness
            .withIdentity(unverified)
            .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS }),
        ),
      ).toBe(UNVERIFIED_FOR_ASK);
    }
  });

  it('refuses a malformed address, an evaluation-shaped one and the caller’s own, in any case', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const ask = (toAddress: string): Promise<unknown> =>
      refusal(
        harness
          .withIdentity(OWNER)
          .mutation(api.managerTransfers.ask, { agentId: maya, toAddress }),
      );
    expect(await ask('priya at day0')).toBe(MANAGER_ADDRESS_REFUSAL);
    expect(await ask('eval-day0-r1-1789588800000@day0.local')).toBe(
      EVALUATION_ADDRESS_TRANSFER_REFUSAL,
    );
    expect(await ask(' BOSS@day0.LOCAL ')).toBe(ownAddressRefusal('Maya'));
    expect(
      await harness.run(async (ctx) => await ctx.db.query('managerTransfers').collect()),
    ).toEqual([]);
  });

  it('refuses a note past 1,000 characters', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    expect(
      await refusal(
        harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
          agentId: maya,
          toAddress: PRIYA_ADDRESS,
          note: 'x'.repeat(1_001),
        }),
      ),
    ).toBe(NOTE_TOO_LONG);
    expect(NOTE_TOO_LONG).toBe('The note can be at most 1,000 characters.');
  });

  it('refuses a second request while one is open, naming the address it is open to', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    expect(
      await refusal(
        harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
          agentId: maya,
          toAddress: fixtureAddressOf('wei'),
        }),
      ),
    ).toBe(openTransferRefusal('Maya', PRIYA_ADDRESS, 'asked'));
    expect(openTransferRefusal('Maya', PRIYA_ADDRESS, 'asked')).toBe(
      'Maya already has a handover open to priya@day0.local. Change the address or cancel it first.',
    );
  });

  it('refuses a second request while one is accepting, in the words of an accepted handover rather than ones that offer a change (U2-m1)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await insertRequest(harness, { agentId: maya, state: 'accepting' });
    const refused = await refusal(
      harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
        agentId: maya,
        toAddress: fixtureAddressOf('wei'),
      }),
    );
    expect(refused).toBe(openTransferRefusal('Maya', PRIYA_ADDRESS, 'accepting'));
    expect(refused).toBe(
      `Maya's handover to ${PRIYA_ADDRESS} was already accepted: Maya becomes theirs when its runs end.`,
    );
    expect(openTransferRefusal('Maya', PRIYA_ADDRESS, 'asked')).toBe(
      `Maya already has a handover open to ${PRIYA_ADDRESS}. Change the address or cancel it first.`,
    );
  });

  it('expires an open request past its expiry in the ask, so it holds nothing, and asks again', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 9));
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const stale = await insertRequest(harness, {
      agentId: maya,
      requestedAt: Date.UTC(2026, 8, 1),
      expiresAt: Date.UTC(2026, 8, 15),
    });
    const fresh = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    expect(await request(harness, stale)).toMatchObject({
      state: 'expired',
      decidedAt: Date.UTC(2026, 8, 15),
    });
    expect((await request(harness, fresh))?.state).toBe('asked');
    expect((await handoverEvents(harness, maya)).map(({ type }) => type)).toEqual([
      'manager.transfer-expired',
      'manager.transfer-asked',
    ]);
  });

  it('refuses a sixth open request of one owner’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    for (const name of ['Ana', 'Ben', 'Cai', 'Dee', 'Eli']) {
      const agentId = await employee(harness, name);
      await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
        agentId,
        toAddress: fixtureAddressOf(name),
      });
    }
    const sixth = await employee(harness, 'Fay');
    expect(
      await refusal(
        harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
          agentId: sixth,
          toAddress: PRIYA_ADDRESS,
        }),
      ),
    ).toBe(OWNER_OPEN_BOUND_REFUSAL);
    expect(OWNER_OPEN_BOUND_REFUSAL).toBe(
      'You have 5 handovers waiting for an answer. Cancel one, or wait for an answer, before you ask for another.',
    );
  });

  it('refuses a twenty-first ask of one owner’s in a rolling day, cancelled ones counted, and counts none older than the day', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 9));
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const askAndCancel = async (): Promise<void> => {
      const transferId = await harness
        .withIdentity(OWNER)
        .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
      await harness.withIdentity(OWNER).mutation(api.managerTransfers.cancel, { transferId });
    };
    await askAndCancel();
    vi.setSystemTime(Date.UTC(2026, 9, 2, 8));
    for (let ask = 0; ask < 19; ask += 1) await askAndCancel();
    expect(
      await refusal(
        harness
          .withIdentity(OWNER)
          .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS }),
      ),
    ).toBe(OWNER_DAILY_BOUND_REFUSAL);
    expect(OWNER_DAILY_BOUND_REFUSAL).toBe(
      'You have asked for 20 handovers in the last 24 hours. Try again later.',
    );

    // The first ask leaves the window a day after it was made.
    vi.setSystemTime(Date.UTC(2026, 9, 2, 9));
    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS }),
    ).resolves.toBeDefined();
  });

  it('refuses an eleventh open request naming one address from all owners together, saying nothing of who asked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    for (let owner = 0; owner < 10; owner += 1) {
      const subject = `owner-${owner}`;
      const agentId = await employee(harness, `Maya ${owner}`, { userId: subject });
      await harness
        .withIdentity(managerIdentity(subject))
        .mutation(api.managerTransfers.ask, { agentId, toAddress: PRIYA_ADDRESS });
    }
    const maya = await employee(harness);
    expect(
      await refusal(
        harness
          .withIdentity(OWNER)
          .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS }),
      ),
    ).toBe(addressBoundRefusal(PRIYA_ADDRESS));
    expect(addressBoundRefusal(PRIYA_ADDRESS)).toBe(
      'priya@day0.local has too many handovers waiting. Try again once they have answered some.',
    );
  });
});

describe('managerTransfers and a long or hidden text', (): void => {
  it('clips the employee’s name at the ask, for an employee stored before the deploy bounded it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness, `Maya\u200B ${'y'.repeat(100_000)}`);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    expect((await request(harness, transferId))?.agentName).toBe(`Maya ${'y'.repeat(75)}`);
  });

  it('keeps the named account’s inbox to names of 80 characters when two accounts ask ten times over long names', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const longName = (index: number): string => `${index}${'n'.repeat(900_000)}`;
    for (const [index, asker] of [OWNER, WEI].entries()) {
      for (let count = 0; count < 5; count += 1) {
        const agentId = await employee(harness, longName(index * 5 + count), {
          userId: asker.subject,
        });
        await harness
          .withIdentity(asker)
          .mutation(api.managerTransfers.ask, { agentId, toAddress: PRIYA_ADDRESS });
      }
    }

    const incoming = await harness.withIdentity(PRIYA).query(api.managerTransfers.incoming, {});
    const inbox = await harness.withIdentity(PRIYA).query(api.work.needsYou, {});
    expect(incoming).toHaveLength(10);
    expect(inbox.entries.filter((entry) => entry.kind === 'transfer')).toHaveLength(10);
    expect(Math.max(...incoming.map((entry) => Array.from(entry.employeeName).length))).toBe(80);
    expect(Math.max(...inbox.entries.map((entry) => Array.from(entry.employeeName).length))).toBe(
      80,
    );
    expect(JSON.stringify(incoming).length + JSON.stringify(inbox).length).toBeLessThan(20_000);
  });

  it('measures the note by character after redaction, and stores none of its hidden characters', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ask = async (agentId: Id<'agents'>, note: string): Promise<unknown> => {
      const transferId = await harness
        .withIdentity(OWNER)
        .mutation(api.managerTransfers.ask, { agentId, toAddress: PRIYA_ADDRESS, note });
      return (await request(harness, transferId))?.note;
    };
    const emoji = '\u{1F431}'.repeat(1_000);
    expect(await ask(await employee(harness, 'Maya'), emoji)).toBe(emoji);
    expect(
      await ask(await employee(harness, 'Tomas'), 'Read\u200B the\u202E list\u0007.\r\nThanks'),
    ).toBe('Read the list.\nThanks');
    expect(await ask(await employee(harness, 'Aiko'), '\u200B\u200B\u2060')).toBeUndefined();
    expect(
      await refusal(
        harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
          agentId: await employee(harness, 'Wes'),
          toAddress: PRIYA_ADDRESS,
          // 1,000 characters as typed; the redacted password makes the stored text 1,009.
          note: `${'x'.repeat(974)} https://ops:p@crm.example`,
        }),
      ),
    ).toBe(NOTE_TOO_LONG);
  });

  it('measures the decline reason by character after redaction, and stores none of its hidden characters', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const decline = async (reason: string): Promise<unknown> => {
      const transferId = await insertRequest(harness, { agentId: maya });
      const outcome = await refusal(
        harness.withIdentity(PRIYA).mutation(api.managerTransfers.decline, { transferId, reason }),
      );
      return outcome === 'not refused'
        ? (await request(harness, transferId))?.declineReason
        : outcome;
    };
    expect(await decline('\u{1F431}'.repeat(500))).toBe('\u{1F431}'.repeat(500));
    expect(await decline('Not\u200B this\u202E quarter')).toBe('Not this quarter');
    expect(await decline('\u200B\uFEFF')).toBeUndefined();
    // 500 characters as typed; the redacted password makes the stored text 509.
    expect(await decline(`${'x'.repeat(474)} https://ops:p@crm.example`)).toBe(
      DECLINE_REASON_TOO_LONG,
    );
  });
});

describe('managerTransfers.cancel', (): void => {
  it('cancels an asked request for the owner, with its reason and event, and takes it out of the named inbox', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    expect(await harness.withIdentity(PRIYA).query(api.managerTransfers.incoming, {})).toHaveLength(
      1,
    );

    await harness.withIdentity(OWNER).mutation(api.managerTransfers.cancel, { transferId });

    expect(await request(harness, transferId)).toMatchObject({
      state: 'cancelled',
      cancelReason: 'owner',
      decidedAt: expect.any(Number),
    });
    expect((await handoverEvents(harness, maya))[1]).toEqual({
      type: 'manager.transfer-cancelled',
      payload: {
        transferId,
        fromAddress: MANAGER_ADDRESS,
        toAddress: PRIYA_ADDRESS,
        reason: 'owner',
      },
    });
    expect(await harness.withIdentity(PRIYA).query(api.managerTransfers.incoming, {})).toEqual([]);
  });

  it('reads another account’s request, the named one’s included, as one that does not exist', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    for (const other of [PRIYA, WEI]) {
      expect(
        await refusal(
          harness.withIdentity(other).mutation(api.managerTransfers.cancel, { transferId }),
        ),
      ).toBe(TRANSFER_NOT_FOUND);
    }
    expect((await request(harness, transferId))?.state).toBe('asked');
  });

  it('refuses a request that is no longer asked, in the words of its state', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    for (const state of ['accepting', 'accepted', 'declined', 'cancelled', 'expired'] as const) {
      const transferId = await insertRequest(harness, { agentId: maya, state });
      expect(
        await refusal(
          harness.withIdentity(OWNER).mutation(api.managerTransfers.cancel, { transferId }),
        ),
      ).toBe(transferStateRefusal(state));
    }
    expect(transferStateRefusal('accepted')).toBe('This handover was already accepted.');
    expect(transferStateRefusal('accepting')).toBe('This handover was already accepted.');
  });

  it('refuses an asked request past its expiry as expired, before the sweep has written it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await insertRequest(harness, {
      agentId: maya,
      requestedAt: Date.now() - TRANSFER_EXPIRY_MS - 1,
    });
    expect(
      await refusal(
        harness.withIdentity(OWNER).mutation(api.managerTransfers.cancel, { transferId }),
      ),
    ).toBe('This handover expired before it was answered.');
  });
});

describe('managerTransfers.changeAddress', (): void => {
  it('cancels the request for another address and asks again in one transaction, keeping the note', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const first = await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: 'Read the close checklist first.',
    });

    const second = await harness.withIdentity(OWNER).mutation(api.managerTransfers.changeAddress, {
      transferId: first,
      toAddress: 'Wei@Day0.local',
    });

    expect(await request(harness, first)).toMatchObject({
      state: 'cancelled',
      cancelReason: 'address-changed',
    });
    expect(await request(harness, second)).toMatchObject({
      state: 'asked',
      toAddress: fixtureAddressOf('wei'),
      note: 'Read the close checklist first.',
    });
    expect((await handoverEvents(harness, maya)).map(({ type }) => type)).toEqual([
      'manager.transfer-asked',
      'manager.transfer-cancelled',
      'manager.transfer-asked',
    ]);
    expect(await harness.withIdentity(PRIYA).query(api.managerTransfers.incoming, {})).toEqual([]);
    expect(await harness.withIdentity(WEI).query(api.managerTransfers.incoming, {})).toHaveLength(
      1,
    );
  });

  it('removes the note when given an empty one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const first = await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: 'Read the close checklist first.',
    });
    const second = await harness.withIdentity(OWNER).mutation(api.managerTransfers.changeAddress, {
      transferId: first,
      toAddress: fixtureAddressOf('wei'),
      note: '',
    });
    expect((await request(harness, second))?.note).toBeUndefined();
  });

  it('refuses the address the request already names, and leaves the request as it was when the new ask is refused', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    const change = (toAddress: string): Promise<unknown> =>
      refusal(
        harness
          .withIdentity(OWNER)
          .mutation(api.managerTransfers.changeAddress, { transferId, toAddress }),
      );
    expect(await change('PRIYA@day0.local')).toBe(sameAddressRefusal(PRIYA_ADDRESS));
    expect(await change(MANAGER_ADDRESS)).toBe(ownAddressRefusal('Maya'));
    expect(await request(harness, transferId)).toMatchObject({ state: 'asked' });
    expect(await handoverEvents(harness, maya)).toHaveLength(1);
  });

  it('refuses another account and a request no longer asked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const declined = await insertRequest(harness, { agentId: maya, state: 'declined' });
    expect(
      await refusal(
        harness.withIdentity(WEI).mutation(api.managerTransfers.changeAddress, {
          transferId: declined,
          toAddress: fixtureAddressOf('wei'),
        }),
      ),
    ).toBe(TRANSFER_NOT_FOUND);
    expect(
      await refusal(
        harness.withIdentity(OWNER).mutation(api.managerTransfers.changeAddress, {
          transferId: declined,
          toAddress: fixtureAddressOf('wei'),
        }),
      ),
    ).toBe(transferStateRefusal('declined'));
  });
});

describe('managerTransfers.changeAddress under the bounds', (): void => {
  it('rolls the cancel back when the new address has too many handovers waiting', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    const full = fixtureAddressOf('wei');
    for (let owner = 0; owner < 10; owner += 1) {
      const subject = `owner-${owner}`;
      const agentId = await employee(harness, `Aiko ${owner}`, { userId: subject });
      await harness
        .withIdentity(managerIdentity(subject))
        .mutation(api.managerTransfers.ask, { agentId, toAddress: full });
    }
    expect(
      await refusal(
        harness
          .withIdentity(OWNER)
          .mutation(api.managerTransfers.changeAddress, { transferId, toAddress: full }),
      ),
    ).toBe(addressBoundRefusal(full));
    expect(await request(harness, transferId)).toMatchObject({ state: 'asked' });
    expect(await handoverEvents(harness, maya)).toHaveLength(1);
  });
});

describe('managerTransfers.decline', (): void => {
  it('declines for the named account, keeps the reason for the old manager, and changes nothing about the employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const before = await harness.run(async (ctx) => await ctx.db.get(maya));
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });

    await harness.withIdentity(PRIYA).mutation(api.managerTransfers.decline, {
      transferId,
      reason: '  I am on leave until November.  ',
    });

    expect(await request(harness, transferId)).toMatchObject({
      state: 'declined',
      declineReason: 'I am on leave until November.',
      decidedAt: expect.any(Number),
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(maya))).toEqual(before);
    expect((await handoverEvents(harness, maya))[1]).toEqual({
      type: 'manager.transfer-declined',
      payload: {
        transferId,
        fromAddress: MANAGER_ADDRESS,
        toAddress: PRIYA_ADDRESS,
        hasReason: true,
      },
    });
  });

  it('declines without a reason', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    await harness.withIdentity(PRIYA).mutation(api.managerTransfers.decline, { transferId });
    expect((await request(harness, transferId))?.declineReason).toBeUndefined();
    expect((await handoverEvents(harness, maya))[1]?.payload).toMatchObject({ hasReason: false });
  });

  it('refuses every account but the named one, an unverified one with the right address included', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    const decline = (identity: ReturnType<typeof managerIdentity>): Promise<unknown> =>
      refusal(
        harness.withIdentity(identity).mutation(api.managerTransfers.decline, { transferId }),
      );
    expect(await decline(WEI)).toBe(TRANSFER_NOT_FOUND);
    expect(await decline(OWNER)).toBe(TRANSFER_NOT_FOUND);
    expect(await decline(managerIdentity('priya', { emailVerified: false }))).toBe(
      UNVERIFIED_FOR_TRANSFER,
    );
    expect((await request(harness, transferId))?.state).toBe('asked');
  });

  it('refuses a request no longer asked, one past its expiry, and a reason past 500 characters', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const cancelled = await insertRequest(harness, { agentId: maya, state: 'cancelled' });
    const lapsed = await insertRequest(harness, {
      agentId: maya,
      requestedAt: Date.now() - TRANSFER_EXPIRY_MS - 1,
    });
    const asked = await insertRequest(harness, { agentId: maya });
    const decline = (transferId: Id<'managerTransfers'>, reason?: string): Promise<unknown> =>
      refusal(
        harness.withIdentity(PRIYA).mutation(api.managerTransfers.decline, { transferId, reason }),
      );
    expect(await decline(cancelled)).toBe(transferStateRefusal('cancelled'));
    expect(await decline(lapsed)).toBe(transferStateRefusal('expired'));
    expect(await decline(asked, 'x'.repeat(501))).toBe(DECLINE_REASON_TOO_LONG);
    expect(DECLINE_REASON_TOO_LONG).toBe('The reason can be at most 500 characters.');
  });
});

describe('managerTransfers.expireDue', (): void => {
  it('expires the asked requests past their expiry, and no accepting or unexpired one, writing each event', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 20));
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const lapsed = await insertRequest(harness, {
      agentId: maya,
      requestedAt: Date.UTC(2026, 9, 1),
    });
    const accepting = await insertRequest(harness, {
      agentId: maya,
      state: 'accepting',
      requestedAt: Date.UTC(2026, 9, 1),
    });
    const waiting = await insertRequest(harness, {
      agentId: maya,
      requestedAt: Date.UTC(2026, 9, 10),
    });

    await expect(harness.mutation(internal.managerTransfers.expireDue, {})).resolves.toEqual({
      expired: 1,
    });

    expect(await request(harness, lapsed)).toMatchObject({
      state: 'expired',
      decidedAt: Date.UTC(2026, 9, 15),
    });
    expect((await request(harness, accepting))?.state).toBe('accepting');
    expect((await request(harness, waiting))?.state).toBe('asked');
    expect(await handoverEvents(harness, maya)).toEqual([
      {
        type: 'manager.transfer-expired',
        payload: { transferId: lapsed, fromAddress: MANAGER_ADDRESS, toAddress: PRIYA_ADDRESS },
      },
    ]);
  });

  it('expires a request whose employee is gone without writing an event for it, which no reset could reach (U2-m6)', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 20));
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const lapsed = await insertRequest(harness, {
      agentId: maya,
      requestedAt: Date.UTC(2026, 9, 1),
    });
    await harness.run(async (ctx) => {
      await ctx.db.delete(maya);
    });

    await expect(harness.mutation(internal.managerTransfers.expireDue, {})).resolves.toEqual({
      expired: 1,
    });

    expect(await request(harness, lapsed)).toMatchObject({ state: 'expired' });
    expect(await handoverEvents(harness, maya)).toEqual([]);
  });

  it('pages a long backlog, scheduling the next page until none is left', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await harness.run(async (ctx): Promise<void> => {
      for (let row = 0; row < 130; row += 1) {
        await ctx.db.insert('managerTransfers', {
          agentId: maya,
          agentName: 'Maya',
          fromOwnerKey: OWNER_SUBJECT,
          fromAddress: MANAGER_ADDRESS,
          toAddress: PRIYA_ADDRESS,
          state: 'asked',
          requestedAt: 1,
          expiresAt: 1 + row,
        });
      }
    });
    await expect(harness.mutation(internal.managerTransfers.expireDue, {})).resolves.toEqual({
      expired: 100,
    });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    const states = await harness.run(async (ctx) =>
      (await ctx.db.query('managerTransfers').collect()).map((row) => row.state),
    );
    expect(new Set(states)).toEqual(new Set(['expired']));
  });
});

describe('managerTransfers.openForAgent', (): void => {
  it('answers the open request for the owner, and null once it is cancelled or past its expiry', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 9));
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const owner = harness.withIdentity(OWNER);
    expect(await owner.query(api.managerTransfers.openForAgent, { agentId: maya })).toBeNull();
    const transferId = await owner.mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: 'Read the checklist.',
    });
    expect(await owner.query(api.managerTransfers.openForAgent, { agentId: maya })).toEqual({
      transferId,
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: 'Read the checklist.',
      state: 'asked',
      requestedAt: Date.UTC(2026, 9, 1, 9),
      expiresAt: Date.UTC(2026, 9, 15, 9),
    });

    vi.setSystemTime(Date.UTC(2026, 9, 15, 9));
    expect(await owner.query(api.managerTransfers.openForAgent, { agentId: maya })).toBeNull();
  });

  it('answers an accepting request with its deadline and the runs the move waits for, counted as the move counts them (U4-m4)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await insertRequest(harness, {
      agentId: maya,
      state: 'accepting',
      settleBy: 5_000,
    });
    await harness.run(async (ctx) => {
      const item = {
        agentId: maya,
        sourceCategory: 'ticket-queue' as const,
        sourceSystem: 'linear',
        contentSummary: 'Close it',
        contentRefs: [],
        observedAt: 1,
        createdAt: 1,
      };
      await ctx.db.insert('workItems', {
        ...item,
        externalId: 'REVOPS-1',
        externalClaimKey: 'linear:REVOPS-1',
        title: 'Close REVOPS-1',
        state: 'executing',
      });
      // Approved and not yet applied: kept from its apply while accepting, so not a run.
      await ctx.db.insert('workItems', {
        ...item,
        externalId: 'REVOPS-2',
        externalClaimKey: 'linear:REVOPS-2',
        title: 'Close REVOPS-2',
        state: 'actions-pending',
        approvedIndexes: [0],
      });
    });
    expect(
      await harness.withIdentity(OWNER).query(api.managerTransfers.openForAgent, { agentId: maya }),
    ).toMatchObject({ transferId, state: 'accepting', settleBy: 5_000, runsInFlight: 1 });
  });

  it('refuses another account', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await expect(
      harness.withIdentity(PRIYA).query(api.managerTransfers.openForAgent, { agentId: maya }),
    ).rejects.toThrow('forbidden');
  });
});

describe('managerTransfers.incoming', (): void => {
  it('lists the asked requests naming the caller’s verified address, oldest first, with the employee’s name and zone', async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 9));
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const tomas = await employee(harness, 'Tomas', { userId: 'wei', zone: 'Asia/Singapore' });
    const first = await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: 'Read the checklist.',
    });
    vi.setSystemTime(Date.UTC(2026, 9, 1, 10));
    const second = await harness
      .withIdentity(WEI)
      .mutation(api.managerTransfers.ask, { agentId: tomas, toAddress: 'PRIYA@day0.local' });

    expect(await harness.withIdentity(PRIYA).query(api.managerTransfers.incoming, {})).toEqual([
      {
        transferId: first,
        agentId: maya,
        employeeName: 'Maya',
        zone: 'Europe/London',
        fromAddress: MANAGER_ADDRESS,
        note: 'Read the checklist.',
        requestedAt: Date.UTC(2026, 9, 1, 9),
        expiresAt: Date.UTC(2026, 9, 15, 9),
      },
      {
        transferId: second,
        agentId: tomas,
        employeeName: 'Tomas',
        zone: 'Asia/Singapore',
        fromAddress: fixtureAddressOf('wei'),
        requestedAt: Date.UTC(2026, 9, 1, 10),
        expiresAt: Date.UTC(2026, 9, 15, 10),
      },
    ]);
  });

  it('names nobody else, nobody unverified, nobody anonymous, and nothing past its expiry or already answered', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await insertRequest(harness, { agentId: maya, requestedAt: Date.now() - TRANSFER_EXPIRY_MS });
    await insertRequest(harness, { agentId: maya, state: 'declined' });
    const aiko = await employee(harness, 'Aiko');
    await insertRequest(harness, { agentId: aiko, state: 'accepting' });
    expect(await harness.withIdentity(PRIYA).query(api.managerTransfers.incoming, {})).toEqual([]);

    await harness
      .withIdentity(OWNER)
      .mutation(api.managerTransfers.ask, { agentId: maya, toAddress: PRIYA_ADDRESS });
    expect(await harness.withIdentity(WEI).query(api.managerTransfers.incoming, {})).toEqual([]);
    expect(await harness.withIdentity(OWNER).query(api.managerTransfers.incoming, {})).toEqual([]);
    expect(
      await harness
        .withIdentity(managerIdentity('priya', { emailVerified: false }))
        .query(api.managerTransfers.incoming, {}),
    ).toEqual([]);
    expect(await harness.query(api.managerTransfers.incoming, {})).toEqual([]);
  });

  it('leaves out a request whose employee is gone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await insertRequest(harness, { agentId: maya });
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.delete(maya);
    });
    expect(await harness.withIdentity(PRIYA).query(api.managerTransfers.incoming, {})).toEqual([]);
  });
});

describe('managerTransfers.arriving', (): void => {
  it('lists the requests the caller accepted that wait for the employee’s runs, with the runs, to the acceptor only', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const tomas = await employee(harness, 'Tomas');
    const settleBy = Date.now() + 15 * 60_000;
    const accepting = await insertRequest(harness, {
      agentId: maya,
      state: 'accepting',
      decidedAt: Date.now(),
      toOwnerKey: 'priya',
      settleBy,
    });
    // Another account signed in with the same address took this one on: it is not the caller's.
    await insertRequest(harness, {
      agentId: tomas,
      state: 'accepting',
      decidedAt: Date.now(),
      toOwnerKey: 'another-priya',
      settleBy,
    });
    await harness.run(async (ctx) => {
      await ctx.db.insert('workItems', {
        agentId: maya,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        externalClaimKey: 'linear:REVOPS-1',
        title: 'Close REVOPS-1',
        contentSummary: 'Close REVOPS-1',
        contentRefs: [],
        observedAt: 1,
        createdAt: 1,
        state: 'executing',
      });
    });

    await expect(
      harness.withIdentity(PRIYA).query(api.managerTransfers.arriving, {}),
    ).resolves.toEqual([
      {
        transferId: accepting,
        agentId: maya,
        agentName: 'Maya',
        fromAddress: MANAGER_ADDRESS,
        settleBy,
        runsInFlight: 1,
      },
    ]);
    await expect(
      harness.withIdentity(OWNER).query(api.managerTransfers.arriving, {}),
    ).resolves.toEqual([]);
    await expect(harness.query(api.managerTransfers.arriving, {})).resolves.toEqual([]);
    await expect(
      harness
        .withIdentity(managerIdentity('priya', { emailVerified: false }))
        .query(api.managerTransfers.arriving, {}),
    ).resolves.toEqual([]);
  });

  it('lists nothing once the request is accepted and the employee has arrived', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness, 'Maya', { userId: 'priya' });
    await insertRequest(harness, {
      agentId: maya,
      state: 'accepted',
      decidedAt: Date.now(),
      toOwnerKey: 'priya',
    });
    await expect(
      harness.withIdentity(PRIYA).query(api.managerTransfers.arriving, {}),
    ).resolves.toEqual([]);
  });
});

describe('managerTransfers.earlierManagers', (): void => {
  it('lists who handed the employee over and when, oldest first, to its owner only', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness, 'Maya', { userId: 'priya' });
    await insertRequest(harness, {
      agentId: maya,
      state: 'accepted',
      decidedAt: 9_000,
      toOwnerKey: 'priya',
    });
    await insertRequest(harness, {
      agentId: maya,
      state: 'accepted',
      fromAddress: 'wei@day0.local',
      decidedAt: 5_000,
      toOwnerKey: 'owner',
    });
    await insertRequest(harness, { agentId: maya, state: 'declined', decidedAt: 7_000 });

    await expect(
      harness.withIdentity(PRIYA).query(api.managerTransfers.earlierManagers, { agentId: maya }),
    ).resolves.toEqual([
      { fromAddress: 'wei@day0.local', decidedAt: 5_000 },
      { fromAddress: MANAGER_ADDRESS, decidedAt: 9_000 },
    ]);
    await expect(
      harness.withIdentity(OWNER).query(api.managerTransfers.earlierManagers, { agentId: maya }),
    ).rejects.toThrow();
  });
});

describe('managerTransfers.departures', (): void => {
  it('lists the asker’s requests answered in the last 30 days, newest first, and none cancelled, older or another account’s', async (): Promise<void> => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 10, 1);
    vi.setSystemTime(now);
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const accepted = await insertRequest(harness, {
      agentId: maya,
      state: 'accepted',
      requestedAt: now - 3 * DAY_MS,
      decidedAt: now - 2 * DAY_MS,
      toOwnerKey: 'priya',
    });
    const declined = await insertRequest(harness, {
      agentId: maya,
      state: 'declined',
      requestedAt: now - 6 * DAY_MS,
      decidedAt: now - 5 * DAY_MS,
      declineReason: 'On leave.',
    });
    const lapsed = await insertRequest(harness, {
      agentId: maya,
      requestedAt: now - TRANSFER_EXPIRY_MS - DAY_MS,
    });
    await insertRequest(harness, {
      agentId: maya,
      state: 'cancelled',
      requestedAt: now - DAY_MS,
      decidedAt: now - DAY_MS,
    });
    await insertRequest(harness, {
      agentId: maya,
      state: 'declined',
      requestedAt: now - TRANSFER_DEPARTURES_WINDOW_MS - 2 * DAY_MS,
      decidedAt: now - TRANSFER_DEPARTURES_WINDOW_MS - DAY_MS,
    });
    await insertRequest(harness, {
      agentId: maya,
      fromOwnerKey: 'wei',
      state: 'declined',
      requestedAt: now - DAY_MS,
      decidedAt: now - DAY_MS,
    });

    expect(await harness.withIdentity(OWNER).query(api.managerTransfers.departures, {})).toEqual([
      {
        transferId: lapsed,
        agentId: maya,
        agentName: 'Maya',
        toAddress: PRIYA_ADDRESS,
        state: 'expired',
        decidedAt: now - DAY_MS,
      },
      {
        transferId: accepted,
        agentId: maya,
        agentName: 'Maya',
        toAddress: PRIYA_ADDRESS,
        state: 'accepted',
        decidedAt: now - 2 * DAY_MS,
      },
      {
        transferId: declined,
        agentId: maya,
        agentName: 'Maya',
        toAddress: PRIYA_ADDRESS,
        state: 'declined',
        decidedAt: now - 5 * DAY_MS,
        declineReason: 'On leave.',
      },
    ]);
    expect(await harness.query(api.managerTransfers.departures, {})).toEqual([]);
  });

  it('says what became of an employee another manager took on: retired, moved on, or with them still (the v0.12.0 walk)', async (): Promise<void> => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 10, 1);
    vi.setSystemTime(now);
    const harness = convexTest(schema, allConvexModules());
    const accepted = async (agentId: Id<'agents'>, daysAgo: number) =>
      await insertRequest(harness, {
        agentId,
        state: 'accepted',
        requestedAt: now - (daysAgo + 1) * DAY_MS,
        decidedAt: now - daysAgo * DAY_MS,
        toOwnerKey: 'priya',
      });
    const stays = await employee(harness, 'Maya', { userId: 'priya' });
    const movedOn = await employee(harness, 'Wes', { userId: 'wei' });
    const retired = await employee(harness, 'Wren', { userId: 'priya' });
    const staysId = await accepted(stays, 1);
    const movedOnId = await accepted(movedOn, 2);
    const retiredId = await accepted(retired, 3);
    await harness.run(async (ctx) => await ctx.db.delete(retired));

    const departures = await harness.withIdentity(OWNER).query(api.managerTransfers.departures, {});
    expect(departures.map(({ transferId, afterwards }) => ({ transferId, afterwards }))).toEqual([
      { transferId: staysId, afterwards: undefined },
      { transferId: movedOnId, afterwards: 'moved-on' },
      { transferId: retiredId, afterwards: 'retired' },
    ]);
  });
});

describe('the handover note in real mode', (): void => {
  afterEach((): void => {
    restoreSurfaceMode();
  });

  /** One credential of the owner's, sealed to the owner as a landed credential is. */
  async function ownerCredential(harness: Harness, value: string): Promise<void> {
    const key = process.env.DAY0_CREDENTIAL_KEY ?? '';
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('credentials', {
        userId: OWNER_SUBJECT,
        kind: 'value',
        label: 'Finance wiki password',
        source: 'entered',
        createdAt: 1,
        ...encrypt(value, key, credentialOwnerBinding(OWNER_SUBJECT)),
      });
    });
  }

  it('removes every credential value of the owner’s from the stored note after the ask', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    await ownerCredential(harness, 'plain-words-password-77');

    const transferId = await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: 'The finance wiki takes plain-words-password-77 until it moves.',
    });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const note = (await request(harness, transferId))?.note;
    expect(note).not.toContain('plain-words-password-77');
    expect(note).toContain('The finance wiki takes');
  });

  it('withholds the note when the owner’s values cannot be read, rather than keep it unchecked', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    // Past the exact layer's cap, the source refuses to answer.
    await harness.run(async (ctx): Promise<void> => {
      for (let row = 0; row <= 1_000; row += 1) {
        await ctx.db.insert('credentials', {
          userId: OWNER_SUBJECT,
          kind: 'value',
          label: `Key ${row}`,
          source: 'entered',
          ciphertext: 'c',
          iv: 'i',
          createdAt: 1,
        });
      }
    });
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);

    const transferId = await harness.withIdentity(OWNER).mutation(api.managerTransfers.ask, {
      agentId: maya,
      toAddress: PRIYA_ADDRESS,
      note: 'Read the checklist.',
    });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await request(harness, transferId))?.note).toBeUndefined();
    expect((await request(harness, transferId))?.state).toBe('asked');
  });
});

describe('managerTransfers.replaceNote', (): void => {
  it('writes the scrubbed note only over the note it scrubbed, never over a later one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const maya = await employee(harness);
    const transferId = await insertRequest(harness, { agentId: maya, note: 'the later note' });
    await harness.mutation(internal.managerTransfers.replaceNote, {
      transferId,
      scrubbedFrom: 'the earlier note',
      note: 'the <redacted> note',
    });
    expect((await request(harness, transferId))?.note).toBe('the later note');
    await harness.mutation(internal.managerTransfers.replaceNote, {
      transferId,
      scrubbedFrom: 'the later note',
    });
    expect((await request(harness, transferId))?.note).toBeUndefined();
  });
});

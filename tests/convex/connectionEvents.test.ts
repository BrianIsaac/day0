/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as connectionEvents from '../../convex/connectionEvents';
import { NOT_AN_ADMINISTRATOR } from '../../src/lib/administrators';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';

const CLERK_ISSUER = 'https://demo.clerk.accounts.dev';
const INES = managerIdentity('ines', { issuer: CLERK_ISSUER, email: 'ines@acme.test' });
const SAM = managerIdentity('sam', { issuer: CLERK_ISSUER, email: 'sam@acme.test' });

beforeEach((): void => {
  vi.stubEnv('DAY0_ADMINISTRATORS', 'ines@acme.test');
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** A connection row, as `organisationConnections.land` would leave it, with its ledger appended through the helper. */
async function seedLedger(
  harness: ReturnType<typeof convexTest>,
  lines: number,
): Promise<Id<'organisationConnections'>> {
  return await harness.run(async (ctx) => {
    const organisationConnectionId = await ctx.db.insert('organisationConnections', {
      system: 'linear',
      displayName: 'Linear',
      kind: 'oauth-app',
      mode: 'shared',
      scopes: ['read'],
      registeredBy: { via: 'setup-cli', at: 1 },
      status: 'active',
      createdAt: 1,
    });
    for (let line = 0; line < lines; line += 1) {
      await connectionEvents.appendConnectionEvent(ctx, {
        organisationConnectionId,
        type: 'organisation.connection-rotated',
        payload: {
          organisationConnectionId,
          system: 'linear',
          displayName: 'Linear',
          via: 'setup-cli',
          scopes: ['read'],
        },
        createdAt: 10 + line,
      });
    }
    return organisationConnectionId;
  });
}

describe('the organisation connections ledger (AC11)', (): void => {
  it('appends one row per event, in the caller’s transaction, owner-less', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await seedLedger(harness, 2);
    const rows = await harness.run(async (ctx) => await ctx.db.query('connectionEvents').collect());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      organisationConnectionId: connectionId,
      type: 'organisation.connection-rotated',
      createdAt: 10,
    });
    expect(rows[0]).not.toHaveProperty('agentId');
  });

  it('shows the administrator one connection’s ledger, newest first, and the whole ledger without one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await seedLedger(harness, 3);
    const ines = harness.withIdentity(INES);
    const one = await ines.query(api.connectionEvents.forAdministrator, {
      organisationConnectionId: connectionId,
    });
    expect(one.map((row) => row.createdAt)).toEqual([12, 11, 10]);
    const all = await ines.query(api.connectionEvents.forAdministrator, {});
    expect(all.map((row) => row.createdAt)).toEqual([12, 11, 10]);
  });

  it("reads each row by the contract's type, leaving out a row whose type it does not list (the wave 11 review's m17)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await seedLedger(harness, 1);
    await harness.run(async (ctx) => {
      await ctx.db.insert('connectionEvents', {
        organisationConnectionId: connectionId,
        type: 'organisation.something-a-later-release-writes',
        payload: { organisationConnectionId: connectionId },
        createdAt: 20,
      });
    });

    const read = await harness.withIdentity(INES).query(api.connectionEvents.forAdministrator, {});
    expect(read.map((row) => [row.type, row.createdAt])).toEqual([
      ['organisation.connection-rotated', 10],
    ]);
  });

  it('bounds the read to the newest lines', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedLedger(harness, connectionEvents.LEDGER_READ_LIMIT + 2);
    const read = await harness.withIdentity(INES).query(api.connectionEvents.forAdministrator, {});
    expect(read).toHaveLength(connectionEvents.LEDGER_READ_LIMIT);
    expect(read[0].createdAt).toBe(10 + connectionEvents.LEDGER_READ_LIMIT + 1);
  });

  it('refuses a manager who is not an administrator', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await seedLedger(harness, 1);
    await expect(
      harness.withIdentity(SAM).query(api.connectionEvents.forAdministrator, {}),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ConvexError && error.data === NOT_AN_ADMINISTRATOR,
    );
  });
});

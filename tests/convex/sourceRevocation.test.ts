/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  endAccessAtSource,
  NO_VALUE_WORDS,
  plannedAtSource,
  SOURCE_REVOCATION_ATTEMPT_OFFSETS_MS,
  SOURCE_REVOCATION_KEEP_MS,
  TOKEN_STORE_WORDS,
} from '../../convex/sourceRevocation';
import { allConvexModules } from './all-modules';
import { stubVendorNetwork, type VendorNetwork } from './fakes/vendor-revocation';
import type { AccessEnd } from '../../src/surfaces/access-identity';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { LINEAR_REVOKE_ALREADY_REVOKED } from '../fixtures/real-vendor-walk-2026-10-03';

type Harness = TestConvex<typeof schema>;

const LINEAR_ACCESS = 'lin_oauth_w11ar_access';
const LINEAR_REFRESH = 'lin_oauth_w11ar_refresh';
const PASTED_KEY = 'lin_api_w11ar_pasted';

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.useFakeTimers();
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** An employee and one card of it. */
async function employeeWithCard(harness: Harness): Promise<{
  readonly agentId: Id<'agents'>;
  readonly surfaceId: Id<'surfaces'>;
}> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Maya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      whereFound: [],
      credentialLanded: true,
      createdAt: 1,
    });
    return { agentId, surfaceId };
  });
}

/** Store a value as the store does, then say how Day0 obtained it, when it did. */
async function stored(
  harness: Harness,
  plaintext: string,
  fields: Partial<Doc<'credentials'>> = {},
): Promise<Id<'credentials'>> {
  const credentialId = await harness.action(internal.credentials.store, {
    userId: 'owner',
    kind: fields.issuedBy === undefined ? 'value' : 'oauth',
    label: 'Linear',
    plaintext,
    source: fields.issuedBy === undefined ? 'entered' : 'oauth',
  });
  await harness.run(async (ctx) => await ctx.db.patch(credentialId, fields));
  return credentialId;
}

/** A Linear access token and its refresh token, as a per-employee authorisation leaves them. */
async function linearPair(harness: Harness): Promise<{
  readonly access: Id<'credentials'>;
  readonly refresh: Id<'credentials'>;
}> {
  const issuedBy = { system: 'linear', grant: 'authorisation-code' as const, clientId: 'lin-1' };
  const refresh = await stored(harness, LINEAR_REFRESH, { issuedBy });
  const access = await stored(harness, LINEAR_ACCESS, { issuedBy, refreshCredentialId: refresh });
  return { access, refresh };
}

/**
 * A Linear access token and its refresh token for one employee, held by the organisation under
 * the reserved key, as the wave 11 common rules have an issuer store a per-employee identity.
 */
async function organisationHeldLinearPair(harness: Harness): Promise<{
  readonly access: Id<'credentials'>;
  readonly refresh: Id<'credentials'>;
}> {
  const issuedBy = { system: 'linear', grant: 'authorisation-code' as const, clientId: 'lin-1' };
  const held = async (plaintext: string, label: string): Promise<Id<'credentials'>> =>
    await harness.action(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'oauth',
      label,
      plaintext,
      source: 'oauth',
    });
  const refresh = await held(LINEAR_REFRESH, 'Linear refresh token');
  const access = await held(LINEAR_ACCESS, 'Linear access token');
  await harness.run(async (ctx) => {
    await ctx.db.patch(refresh, { issuedBy });
    await ctx.db.patch(access, { issuedBy, refreshCredentialId: refresh });
  });
  return { access, refresh };
}

/** End the card's access over the given rows, in one transaction. */
async function end(
  harness: Harness,
  card: { readonly agentId: Id<'agents'>; readonly surfaceId: Id<'surfaces'> },
  credentialIds: readonly Id<'credentials'>[],
  accessEnd: AccessEnd,
): Promise<void> {
  await harness.run(async (ctx) => {
    const rows = await Promise.all(credentialIds.map(async (id) => await ctx.db.get(id)));
    await endAccessAtSource(ctx, {
      ...card,
      surfaceName: 'Linear',
      credentials: rows.filter((row): row is Doc<'credentials'> => row !== null),
      end: accessEnd,
      now: Date.now(),
    });
  });
}

/** The ledger lines on the employee's record, oldest first. */
async function lines(harness: Harness, agentId: Id<'agents'>): Promise<unknown[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect())
      .filter((event) => event.agentId === agentId && event.type === 'credential.revoked-at-source')
      .map((event) => event.payload as unknown),
  );
}

/** Every credential row, read back whole. */
async function rows(harness: Harness): Promise<Doc<'credentials'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('credentials').collect());
}

describe('ending access at the vendor (11-AR; the access plan, section 4.4)', (): void => {
  let network: VendorNetwork;

  beforeEach((): void => {
    network = stubVendorNetwork();
  });

  it('makes an issued credential unusable at once and revokes it at source within its attempts', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await linearPair(harness);
    network.answer('/oauth/revoke', { status: 503, body: '' }, { status: 200, body: '' });

    await end(harness, card, [access, refresh], 'disconnect');
    // Unusable from the ending transaction on, before any vendor call.
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: access }),
    ).rejects.toThrow('Credential is unavailable.');
    expect((await rows(harness)).map((row) => row.sourceRevocation?.state)).toEqual([
      'pending',
      'pending',
    ]);

    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    // The first attempt met a 503 and the second, an hour on, revoked both tokens of the pair.
    expect(network.calls.map((call) => call.form)).toEqual([
      { token: LINEAR_REFRESH, token_type_hint: 'refresh_token' },
      { token: LINEAR_REFRESH, token_type_hint: 'refresh_token' },
      { token: LINEAR_ACCESS, token_type_hint: 'access_token' },
    ]);
    expect(network.calls.every((call) => call.url === 'https://api.linear.app/oauth/revoke')).toBe(
      true,
    );
    const after = await rows(harness);
    expect(after.map((row) => [row.sourceRevocation?.state, row.ciphertext])).toEqual([
      ['done', undefined],
      ['done', undefined],
    ]);
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({
        credentialId: access,
        system: 'linear',
        end: 'disconnect',
        outcome: 'retrying',
        attempt: 1,
        reason: 'Linear answered HTTP 503.',
      }),
      expect.objectContaining({
        credentialId: access,
        system: 'linear',
        end: 'disconnect',
        outcome: 'token-revoked',
        attempt: 2,
      }),
    ]);
  });

  it("records a failed revocation in the vendor's words and deletes the ciphertext after the last attempt", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await linearPair(harness);
    network.answer('/oauth/revoke', { status: 503, body: '' });
    const endedAt = Date.now();

    await end(harness, card, [access, refresh], 'expiry');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toHaveLength(SOURCE_REVOCATION_ATTEMPT_OFFSETS_MS.length);
    const after = await rows(harness);
    expect(after.map((row) => row.sourceRevocation)).toEqual([
      expect.objectContaining({ state: 'failed', lastError: 'Linear answered HTTP 503.' }),
      expect.objectContaining({ state: 'failed', attempts: 3, end: 'expiry' }),
    ]);
    expect(after.every((row) => row.ciphertext === undefined && row.iv === undefined)).toBe(true);
    // The last attempt is twelve hours on, inside the 24 hours the ciphertext may be kept.
    expect(after[1]?.sourceRevocation?.at).toBeLessThan(endedAt + SOURCE_REVOCATION_KEEP_MS);
    expect(
      (await lines(harness, card.agentId)).map(
        (line) => (line as { outcome: string; attempt: number }).outcome,
      ),
    ).toEqual(['retrying', 'retrying', 'failed']);
  });

  it('fails at once, with the words, on a refusal another attempt cannot change', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await linearPair(harness);
    network.answer('/oauth/revoke', { status: 400, body: { error: 'invalid_request' } });

    await end(harness, card, [access, refresh], 'disconnect');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toHaveLength(1);
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        attempt: 1,
        reason: 'Linear refused: invalid_request',
      }),
    ]);
    expect((await rows(harness)).map((row) => row.ciphertext)).toEqual([undefined, undefined]);
  });

  it.each(['disconnect', 'expiry', 'retire'] as const)(
    'records a %s of an employee’s own Linear app as revoked when the pair’s second revoke meets "Token has already been revoked." (R41V-8)',
    async (accessEnd): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const card = await employeeWithCard(harness);
      const { access, refresh } = await organisationHeldLinearPair(harness);
      // Linear, 3 October: the first revoke of the pair ends the whole grant, so the second meets it.
      network.answer('/oauth/revoke', { status: 200, body: '' }, LINEAR_REVOKE_ALREADY_REVOKED);

      await end(harness, card, [access, refresh], accessEnd);
      await harness.finishAllScheduledFunctions(vi.runAllTimers);

      expect(network.calls).toHaveLength(2);
      expect((await rows(harness)).map((row) => row.sourceRevocation?.state)).toEqual([
        'done',
        'done',
      ]);
      const recorded = await lines(harness, card.agentId);
      expect(recorded).toEqual([
        expect.objectContaining({
          credentialId: access,
          end: accessEnd,
          outcome: 'token-revoked',
        }),
      ]);
      expect(JSON.stringify(recorded)).not.toContain('already been revoked');
    },
  );

  it("never sends a pasted key to a vendor's revocation endpoint", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const pasted = await stored(harness, PASTED_KEY);

    for (const accessEnd of ['disconnect', 'expiry', 'retire', 'reject'] as const) {
      await end(harness, card, [pasted], accessEnd);
    }
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([]);
    const [row] = await rows(harness);
    expect(row?.sourceRevocation).toBeUndefined();
    expect(
      (await lines(harness, card.agentId)).map((line) => (line as { outcome: string }).outcome),
    ).toEqual(['pasted-key', 'pasted-key', 'pasted-key', 'pasted-key']);
  });

  it("revokes a handover's cut at the vendor as a Disconnect does (the wave 11 review's M1, decision 2 (a))", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await linearPair(harness);
    network.answer('/oauth/revoke', { status: 200, body: '' });

    await end(harness, card, [access, refresh], 'transfer');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls.map((call) => [call.url, call.form])).toEqual([
      [
        'https://api.linear.app/oauth/revoke',
        { token: LINEAR_REFRESH, token_type_hint: 'refresh_token' },
      ],
      [
        'https://api.linear.app/oauth/revoke',
        { token: LINEAR_ACCESS, token_type_hint: 'access_token' },
      ],
    ]);
    const after = await rows(harness);
    expect(after.map((row) => [row.sourceRevocation?.state, row.ciphertext])).toEqual([
      ['done', undefined],
      ['done', undefined],
    ]);
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({ credentialId: access, end: 'transfer', outcome: 'token-revoked' }),
    ]);
  });

  it('never revokes a token the organisation holds, and says so', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const shared = await stored(harness, LINEAR_ACCESS, {
      issuedBy: { system: 'linear', grant: 'client-credentials' },
      holder: 'organisation',
      userId: 'day0:organisation',
    });

    await end(harness, card, [shared], 'retire');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([]);
    const [row] = await rows(harness);
    expect(row?.revokedAt).toBeUndefined();
    expect(row?.ciphertext).toEqual(expect.any(String));
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({ system: 'linear', outcome: 'shared' }),
    ]);
  });

  it("revokes an employee's own identity the organisation holds, by how Day0 obtained it", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await organisationHeldLinearPair(harness);
    network.answer('/oauth/revoke', { status: 200, body: '' });

    await end(harness, card, [access, refresh], 'retire');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls.map((call) => call.form)).toEqual([
      { token: LINEAR_REFRESH, token_type_hint: 'refresh_token' },
      { token: LINEAR_ACCESS, token_type_hint: 'access_token' },
    ]);
    expect(
      (await rows(harness)).map((row) => [row.sourceRevocation?.state, row.ciphertext]),
    ).toEqual([
      ['done', undefined],
      ['done', undefined],
    ]);
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({ system: 'linear', end: 'retire', outcome: 'token-revoked' }),
    ]);
  });

  it("never revokes an organisation connection's own secret a card binds, and says so", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const secret = await harness.action(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label: 'Linear client secret',
      plaintext: PASTED_KEY,
      source: 'entered',
    });

    await end(harness, card, [secret], 'retire');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([]);
    const [row] = await rows(harness);
    expect(row?.revokedAt).toBeUndefined();
    expect(row?.ciphertext).toEqual(expect.any(String));
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({ system: 'Linear', outcome: 'shared' }),
    ]);
  });

  it('keeps a row an earlier end already holds on its own attempts, scheduling none again', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await linearPair(harness);
    network.answer('/oauth/revoke', { status: 200, body: '' });

    await end(harness, card, [access, refresh], 'expiry');
    await end(harness, card, [access, refresh], 'retire');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    // One revocation of the pair, by the end that held it first.
    expect(network.calls).toHaveLength(2);
    expect((await rows(harness)).map((row) => row.sourceRevocation?.end)).toEqual([
      'expiry',
      'expiry',
    ]);
  });
});

describe('what the hold anchors, and the rows it cannot hold', (): void => {
  let network: VendorNetwork;

  beforeEach((): void => {
    network = stubVendorNetwork();
  });

  it('counts the 24 hours and the attempts from the hold, not from an earlier revoke by a person', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await linearPair(harness);
    // A person revoked the token two days ago; Day0 stopped using it and kept its value.
    const twoDaysAgo = Date.now() - 2 * SOURCE_REVOCATION_KEEP_MS;
    await harness.run(async (ctx) => await ctx.db.patch(access, { revokedAt: twoDaysAgo }));
    network.answer('/oauth/revoke', { status: 503, body: '' });
    const heldAt = Date.now();

    await end(harness, card, [access, refresh], 'disconnect');
    await expect(
      harness.query(internal.sourceRevocation.overdue, { now: Date.now() }),
    ).resolves.toEqual([]);
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const row = (await rows(harness)).find((candidate) => candidate._id === access);
    expect(row?.revokedAt).toBe(heldAt);
    // The third attempt ran twelve hours after the hold, not at once.
    expect(row?.sourceRevocation?.at).toBeGreaterThanOrEqual(
      heldAt + (SOURCE_REVOCATION_ATTEMPT_OFFSETS_MS.at(-1) ?? 0),
    );
  });

  it('holds no row whose value is gone, and says it could not be revoked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access } = await linearPair(harness);
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(access, { ciphertext: undefined, iv: undefined, revokedAt: 5 }),
    );

    await end(harness, card, [access], 'disconnect');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([]);
    const row = (await rows(harness)).find((candidate) => candidate._id === access);
    expect(row?.sourceRevocation).toBeUndefined();
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({
        system: 'linear',
        outcome: 'failed',
        reason:
          "Day0 no longer held the credential's value, so it could not be revoked at the vendor.",
      }),
    ]);
  });

  it('revokes a refresh token held alone with its own hint', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await linearPair(harness);
    network.answer('/oauth/revoke', { status: 200, body: '' });
    // The access token's end came first and held it; the refresh token is ended afterwards.
    await end(harness, card, [access], 'disconnect');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    network.calls.length = 0;

    await end(harness, card, [access, refresh], 'retire');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls.map((call) => call.form)).toEqual([
      { token: LINEAR_REFRESH, token_type_hint: 'refresh_token' },
    ]);
  });

  it("keeps the vendor's words short and free of any token it echoed", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access, refresh } = await linearPair(harness);
    network.answer('/oauth/revoke', {
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: `bad token ${LINEAR_REFRESH} ${'x'.repeat(600)}`,
      },
    });

    await end(harness, card, [access, refresh], 'disconnect');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const [recorded] = (await lines(harness, card.agentId)) as { reason: string }[];
    expect(recorded?.reason).not.toContain(LINEAR_REFRESH);
    expect(recorded?.reason.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(await rows(harness))).not.toContain(LINEAR_REFRESH);
  });

  it('never opens a token the token store holds, and stops using it at once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access } = await linearPair(harness);
    await harness.run(async (ctx) => await ctx.db.patch(access, { tokenStore: 'nango' }));

    const ended = await harness.run(async (ctx) =>
      endAccessAtSource(ctx, {
        ...card,
        surfaceName: 'Linear',
        credentials: [(await ctx.db.get(access))!],
        end: 'disconnect',
        now: Date.now(),
      }),
    );
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(ended.stopped).toEqual([access]);
    expect(network.calls).toEqual([]);
    const row = (await rows(harness)).find((candidate) => candidate._id === access);
    expect(row?.sourceRevocation).toBeUndefined();
    expect(row?.revokedAt).toEqual(expect.any(Number));
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({ outcome: 'not-supported' }),
    ]);
  });

  it("says a handover's cut could not revoke a row whose value is gone, as a Disconnect says it (M1)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const card = await employeeWithCard(harness);
    const { access } = await linearPair(harness);
    await harness.run(
      async (ctx) => await ctx.db.patch(access, { ciphertext: undefined, iv: undefined }),
    );

    await end(harness, card, [access], 'transfer');

    expect(network.calls).toEqual([]);
    expect(await lines(harness, card.agentId)).toEqual([
      expect.objectContaining({ end: 'transfer', outcome: 'failed' }),
    ]);
  });

  it('plans for the retire dialog exactly what the end will do with such rows', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { access } = await linearPair(harness);
    const planned = await harness.run(async (ctx) => {
      const live = (await ctx.db.get(access))!;
      return await Promise.all([
        plannedAtSource(ctx.db, { surfaceName: 'Linear', ended: [live], kept: [] }, 'retire'),
        plannedAtSource(
          ctx.db,
          { surfaceName: 'Linear', ended: [{ ...live, tokenStore: 'nango' }], kept: [] },
          'retire',
        ),
        plannedAtSource(
          ctx.db,
          { surfaceName: 'Linear', ended: [{ ...live, ciphertext: undefined }], kept: [] },
          'retire',
        ),
      ]);
    });
    expect(planned).toEqual([
      { system: 'linear', outcome: 'token-revoked' },
      { system: 'linear', outcome: 'not-supported', reason: TOKEN_STORE_WORDS },
      { system: 'linear', outcome: 'failed', reason: NO_VALUE_WORDS },
    ]);
  });
});

describe("the retire dialog's words for what stays at the vendor (R41V-11)", (): void => {
  it("gives the plan's own words where Day0 holds no configuration token to delete the employee's Slack app", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    // The walk's Wren: the app's client secret, after the connection whose token made the app was revoked.
    const secret = await stored(harness, 'w11ar-client-secret', {
      issuedBy: { system: 'slack', grant: 'app-created', appId: 'A0WREN', clientId: '1234.5' },
    });
    const planned = await harness.run(async (ctx) => {
      const row = (await ctx.db.get(secret))!;
      return await plannedAtSource(
        ctx.db,
        { surfaceName: 'Slack', ended: [row], kept: [] },
        'retire',
      );
    });
    expect(planned).toEqual({
      system: 'slack',
      outcome: 'not-supported',
      reason:
        "Day0 holds no configuration token to delete the app; delete it in Slack's app settings.",
    });
  });
});

describe('the 24-hour bound, read by the nested-field index (11-AK, AK7)', (): void => {
  it('finds a revocation left pending past the bound and closes it, deleting its ciphertext', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { access } = await linearPair(harness);
    const long = Date.now() - SOURCE_REVOCATION_KEEP_MS - 1;
    await harness.run(async (ctx) => {
      await ctx.db.patch(access, {
        revokedAt: long,
        sourceRevocation: { state: 'pending', attempts: 1, at: long, end: 'disconnect' },
      });
    });

    await expect(
      harness.query(internal.sourceRevocation.overdue, { now: Date.now() }),
    ).resolves.toEqual([access]);
    await expect(harness.mutation(internal.sourceRevocation.expireOverdue, {})).resolves.toBe(1);

    const row = (await rows(harness)).find((candidate) => candidate._id === access);
    expect(row?.sourceRevocation).toMatchObject({ state: 'failed' });
    expect(row?.ciphertext).toBeUndefined();
    await expect(
      harness.query(internal.sourceRevocation.overdue, { now: Date.now() }),
    ).resolves.toEqual([]);
  });
});

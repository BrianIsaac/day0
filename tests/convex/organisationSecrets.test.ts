/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { Landing } from '../../convex/organisationConnections';
import { ORGANISATION_SECRET_HOLD_MS } from '../../convex/organisationSecrets';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';
import { stubVendorNetwork, type VendorNetwork } from './fakes/vendor-revocation';
import { SLACK_AUTH_REVOKE_OK } from '../fixtures/revokers';

/*
 * The wave 11 review's M6: a revoked or rotated organisation secret kept its ciphertext for ever
 * and nothing ended it at the vendor, so Slack's configuration token (which can create and delete
 * apps in the workspace) stayed live at Slack and sealed in Day0. A revoke and a rotation now end
 * what they take out of use by the connection's kind: the Slack configuration token revoked at
 * Slack and the pair's values deleted; an MCP client's secret kept for 24 hours for the card
 * revocations that need it (AJ6) and then deleted; anything else deleted at once.
 */

type Harness = TestConvex<typeof schema>;

/** Ines, the administrator IT named at install. */
const INES = managerIdentity('ines', { email: 'ines@acme.test' });

const CONFIGURATION_TOKEN = 'xoxe.xoxp-1234567890-abcdefghij';
const REFRESH_TOKEN = 'xoxe-1234567890-abcdefghij';
const CLIENT_SECRET = 'lin_oauth_secret_0123456789';
const MCP_SECRET = 'mcp-client-secret-0123';

const SLACK: Landing = {
  system: 'slack',
  displayName: 'Slack',
  kind: 'slack-configuration',
  mode: 'per-employee',
  scopes: ['chat:write'],
  secret: CONFIGURATION_TOKEN,
  refreshToken: REFRESH_TOKEN,
};

const LINEAR: Landing = {
  system: 'linear',
  displayName: 'Linear',
  kind: 'oauth-app',
  mode: 'shared',
  scopes: ['read', 'write'],
  clientCredentialsScopes: ['read', 'write'],
  clientId: 'lin-client-1',
  secret: CLIENT_SECRET,
};

const DOCS_MCP: Landing = {
  system: 'mcp:docs.acme.test',
  displayName: 'Acme docs',
  kind: 'mcp-client',
  mode: 'per-employee',
  scopes: [],
  clientId: 'day0-docs',
  issuer: 'https://auth.acme.test',
  secret: MCP_SECRET,
};

let network: VendorNetwork;

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('DAY0_ADMINISTRATORS', 'ines@acme.test');
  vi.useFakeTimers();
  network = stubVendorNetwork();
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every organisation credential and ledger line, as stored. */
async function rows(harness: Harness): Promise<{
  credentials: Doc<'credentials'>[];
  ledger: Doc<'connectionEvents'>[];
}> {
  return await harness.run(async (ctx) => ({
    credentials: await ctx.db.query('credentials').collect(),
    ledger: await ctx.db.query('connectionEvents').collect(),
  }));
}

/**
 * Run what a revoke or a rotation scheduled to run now (the call at Slack), and nothing it
 * scheduled for later: the 24-hour purge is the backstop of a lost call, not its race.
 */
async function runDueNow(harness: Harness): Promise<void> {
  vi.advanceTimersByTime(1);
  await harness.finishInProgressScheduledFunctions();
}

/** Revoke a connection as Ines, with a reason. */
async function revoke(
  harness: Harness,
  connectionId: Id<'organisationConnections'>,
): Promise<void> {
  await harness.withIdentity(INES).mutation(api.organisationConnections.revoke, {
    organisationConnectionId: connectionId,
    reason: 'the workspace moved',
  });
}

describe("ending an organisation secret a revoke or a rotation took out of use (the wave 11 review's M6)", (): void => {
  it("revokes a revoked connection's Slack configuration token at Slack and deletes both values of the pair", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });
    const connectionId = await harness
      .withIdentity(INES)
      .action(api.organisationConnections.land, SLACK);

    await revoke(harness, connectionId);
    await runDueNow(harness);

    expect(network.calls).toEqual([
      {
        url: 'https://slack.com/api/auth.revoke',
        authorization: `Bearer ${CONFIGURATION_TOKEN}`,
        form: {},
      },
    ]);
    const { credentials, ledger } = await rows(harness);
    expect(credentials).toHaveLength(2);
    for (const row of credentials) {
      expect(row.revokedAt).toEqual(expect.any(Number));
      expect(row.ciphertext).toBeUndefined();
    }
    expect(ledger.map((line) => [line.type, (line.payload as { method?: string }).method])).toEqual(
      expect.arrayContaining([['organisation.configuration-used', 'auth.revoke']]),
    );
    expect(
      ledger.find((line) => (line.payload as { method?: string }).method === 'auth.revoke')
        ?.payload,
    ).toMatchObject({ outcome: 'done' });
  });

  it('revokes the old configuration token at Slack when IT rotates the pair, and keeps the new one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    network.answer('/api/auth.revoke', { status: 200, body: SLACK_AUTH_REVOKE_OK });
    const ines = harness.withIdentity(INES);
    const connectionId = await ines.action(api.organisationConnections.land, SLACK);
    const before = (await rows(harness)).credentials.map((row) => row._id);

    await ines.action(api.organisationConnections.rotate, {
      organisationConnectionId: connectionId,
      secret: 'xoxe.xoxp-2222222222-abcdefghij',
      refreshToken: 'xoxe-2222222222-abcdefghij',
    });
    await runDueNow(harness);

    expect(network.calls).toEqual([
      {
        url: 'https://slack.com/api/auth.revoke',
        authorization: `Bearer ${CONFIGURATION_TOKEN}`,
        form: {},
      },
    ]);
    const { credentials } = await rows(harness);
    for (const row of credentials.filter((candidate) => before.includes(candidate._id))) {
      expect(row.ciphertext).toBeUndefined();
    }
    const connection = await harness.run(async (ctx) => await ctx.db.get(connectionId));
    await expect(
      harness.action(internal.credentials.decrypt, {
        credentialId: connection!.secretCredentialId!,
      }),
    ).resolves.toBe('xoxe.xoxp-2222222222-abcdefghij');
  });

  it("deletes a revoked Linear app's client secret at once and sends it nowhere", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await harness
      .withIdentity(INES)
      .action(api.organisationConnections.land, LINEAR);

    await revoke(harness, connectionId);
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(network.calls).toEqual([]);
    const { credentials } = await rows(harness);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.revokedAt).toEqual(expect.any(Number));
    expect(credentials[0]?.ciphertext).toBeUndefined();
  });

  it("keeps a revoked MCP client's secret for the card revocations that need it, and deletes it after 24 hours", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await harness
      .withIdentity(INES)
      .action(api.organisationConnections.land, DOCS_MCP);

    await revoke(harness, connectionId);

    const [held] = (await rows(harness)).credentials;
    expect(held?.revokedAt).toEqual(expect.any(Number));
    expect(held?.ciphertext).toEqual(expect.any(String));
    vi.advanceTimersByTime(ORGANISATION_SECRET_HOLD_MS - 60_000);
    await harness.finishInProgressScheduledFunctions();
    expect((await rows(harness)).credentials[0]?.ciphertext).toEqual(expect.any(String));

    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await rows(harness)).credentials[0]?.ciphertext).toBeUndefined();
    expect(network.calls).toEqual([]);
  });

  it('deletes the pair even when Slack refuses the revoke, and says so on the ledger', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    network.answer('/api/auth.revoke', {
      status: 200,
      body: { ok: false, error: 'not_allowed_token_type' },
    });
    const connectionId = await harness
      .withIdentity(INES)
      .action(api.organisationConnections.land, SLACK);

    await revoke(harness, connectionId);
    await runDueNow(harness);

    const { credentials, ledger } = await rows(harness);
    for (const row of credentials) expect(row.ciphertext).toBeUndefined();
    expect(
      ledger.find((line) => (line.payload as { method?: string }).method === 'auth.revoke')
        ?.payload,
    ).toMatchObject({
      outcome: 'failed',
      reason: 'Slack auth.revoke refused: not_allowed_token_type',
    });
    expect(JSON.stringify(ledger)).not.toContain(CONFIGURATION_TOKEN);
  });
});

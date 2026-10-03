/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { endAccessAtSource } from '../../convex/sourceRevocation';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { SLACK_KIT_BOT_SCOPES } from '../../src/surfaces/access-kit/slack';
import { KEPT_APP_CONNECTION_REVOKED } from '../../src/surfaces/identity-issuers/slack';
import { LEASE_POLL_MS } from '../../src/surfaces/refresh-lease';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import {
  LANDED_CONFIGURATION_TOKEN,
  LANDED_REFRESH_TOKEN,
  callsOf,
  slackDouble,
  type SlackDouble,
} from './fakes/slack-api';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * An employee's own Slack app through the organisation's configuration connection (wave 11,
 * 11-AS; the access plan, sections 4.2 and 4.9, and its 11-AS acceptance list): created with no
 * pasted token, the configuration token rotated with its kept refresh token and the new pair
 * written before it is used, a revoked connection falling back to the card's field, every use on
 * the connection's ledger, the renewal's one click over the kept app with the re-join of the
 * public intake channels (RM4), and the retire 13 hours after the connection landed deleting the
 * app (11-AR's re-check). Slack is the in-memory double at the network seam.
 */

type Harness = TestConvex<typeof schema>;

const POLICY = readFileSync(
  resolve(__dirname, '../fixtures/notion-pages/slack-day0-app.md'),
  'utf8',
);
const PUBLIC_URL = 'https://day0.example.test';
const HOUR = 60 * 60 * 1000;

/** Documentation that carries no manifest template, so the app is built from the kit's. */
const KIT_ONLY = '# RevOps handbook\n\nThe team works in Slack.';

let slack: SlackDouble;

beforeEach((): void => {
  vi.useFakeTimers();
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  slack = slackDouble();
  vi.stubGlobal('fetch', vi.fn(slack.fetch));
});

afterEach((): void => {
  restoreSurfaceMode();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** IT lands Slack for the organisation with the configuration token and its refresh token. */
async function landSlack(harness: Harness): Promise<Id<'organisationConnections'>> {
  return await harness.action(internal.organisationConnections.landFromSetup, {
    system: 'slack',
    displayName: 'Slack',
    kind: 'slack-configuration',
    mode: 'per-employee',
    scopes: [...SLACK_KIT_BOT_SCOPES],
    redirectUrl: `${PUBLIC_URL}/api/oauth/slack`,
    secret: LANDED_CONFIGURATION_TOKEN,
    refreshToken: LANDED_REFRESH_TOKEN,
  });
}

interface Employee {
  readonly agentId: Id<'agents'>;
  readonly surfaceId: Id<'surfaces'>;
}

/**
 * An approved Slack card of one of the owner's employees, its documentation carrying the team's
 * manifest unless told otherwise, and its approved intake scope naming the given channels.
 */
async function employee(
  harness: Harness,
  name: string,
  options: { readonly documentation?: string; readonly channels?: readonly string[] } = {},
): Promise<Employee> {
  return await harness.run(async (ctx): Promise<Employee> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name,
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const sourceId = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: `${name} handbook`,
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'slack.md',
      title: 'Slack automation policy',
      markdown: options.documentation ?? POLICY,
      updatedAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'approved',
      whereFound: [],
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      request: { credential: { found: 'none', method: 'oauth', label: 'Slack bot token' } },
      managerApprovedAt: 2,
      credentialLanded: false,
      ...(options.channels
        ? {
            intakeScope: {
              channels: options.channels.map((value) => ({ value, ref: 'slack.md', quote: value })),
            },
          }
        : {}),
      createdAt: 1,
    });
    return { agentId, surfaceId };
  });
}

/** The manager's "Provision a dedicated app", with no token pasted unless one is given. */
async function provision(
  harness: Harness,
  surfaceId: Id<'surfaces'>,
  configurationToken?: string,
): Promise<{ appId: string; installUrl: string }> {
  return await harness
    .withIdentity(managerIdentity())
    .action(api.slackProvisionActions.provisionApp, {
      surfaceId,
      ...(configurationToken === undefined ? {} : { configurationToken }),
    });
}

/** The administrator's install click: Slack redirects back with the app's code. */
async function install(
  harness: Harness,
  provisioned: { appId: string; installUrl: string },
): Promise<void> {
  const state = new URL(provisioned.installUrl).searchParams.get('state') ?? '';
  const app = slack.apps.find((candidate) => candidate.appId === provisioned.appId);
  const outcome = await harness.action(internal.slackProvisionActions.completeInstallInternal, {
    state,
    code: app?.code ?? 'no-such-app',
  });
  expect(outcome).toMatchObject({ ok: true });
}

async function card(harness: Harness, surfaceId: Id<'surfaces'>): Promise<Doc<'surfaces'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
  if (row === null) throw new Error('the card is gone');
  return row;
}

async function credential(harness: Harness, id: Id<'credentials'>): Promise<Doc<'credentials'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(id));
  if (row === null) throw new Error('the credential is gone');
  return row;
}

async function ledger(harness: Harness): Promise<Doc<'connectionEvents'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('connectionEvents').collect());
}

async function configurationRow(
  harness: Harness,
  connectionId: Id<'organisationConnections'>,
): Promise<Doc<'credentials'>> {
  const connection = await harness.run(async (ctx) => await ctx.db.get(connectionId));
  if (!connection?.secretCredentialId) throw new Error('the connection holds no token');
  return await credential(harness, connection.secretCredentialId);
}

async function opened(harness: Harness, id: Id<'credentials'>): Promise<string> {
  return await harness.action(internal.credentials.decrypt, { credentialId: id });
}

/** Run what is due now, and what that schedules for now, without moving the clock. */
async function settle(harness: Harness): Promise<void> {
  vi.advanceTimersByTime(0);
  await harness.finishInProgressScheduledFunctions();
}

/** Move the clock an hour at a time, running each scheduled function as it falls due. */
async function passHours(harness: Harness, hours: number): Promise<void> {
  for (let hour = 0; hour < hours; hour += 1) {
    vi.advanceTimersByTime(HOUR);
    await harness.finishInProgressScheduledFunctions();
  }
}

describe("an employee's own app through the organisation's connection (B9)", (): void => {
  it("creates a second employee's app with no pasted token, each its own, its secret held by the organisation", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const leo = await employee(harness, 'Leo');

    const first = await provision(harness, maya.surfaceId);
    const second = await provision(harness, leo.surfaceId);

    expect(first.appId).not.toBe(second.appId);
    expect(callsOf(slack, 'apps.manifest.create')).toHaveLength(2);
    for (const [who, made] of [
      [maya, first],
      [leo, second],
    ] as const) {
      const row = await card(harness, who.surfaceId);
      expect(row.provisioning).toMatchObject({
        appId: made.appId,
        organisationConnectionId: connectionId,
      });
      const secretId = row.provisioning?.clientSecretCredentialId;
      if (!secretId) throw new Error('no client secret');
      expect(await credential(harness, secretId)).toMatchObject({
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        issuedBy: {
          system: 'slack',
          grant: 'app-created',
          appId: made.appId,
          clientId: row.provisioning?.clientId,
          organisationConnectionId: connectionId,
        },
      });
    }
    const owners = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('credentials')
          .withIndex('by_userId', (index) => index.eq('userId', 'owner'))
          .collect(),
    );
    expect(owners).toEqual([]);
  });

  it("builds the access kit's app where the documentation carries no manifest template", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const ana = await employee(harness, 'Ana', { documentation: '# Handbook\n\nNo manifest.' });

    await provision(harness, ana.surfaceId);

    const [created] = callsOf(slack, 'apps.manifest.create');
    const manifest = JSON.parse(created?.form.manifest ?? '{}') as {
      oauth_config: { scopes: { bot: string[] } };
    };
    expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_KIT_BOT_SCOPES]);
  });

  it('writes the rotated pair before it uses the new token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const seenAtCreate: Array<{ generation?: number; token: string; refresh: string }> = [];
    const answer = slack.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith('/apps.manifest.create')) {
          const row = await configurationRow(harness, connectionId);
          if (!row.refreshCredentialId) throw new Error('no refresh token row');
          seenAtCreate.push({
            ...(row.generation === undefined ? {} : { generation: row.generation }),
            token: await opened(harness, row._id),
            refresh: await opened(harness, row.refreshCredentialId),
          });
        }
        return await answer(input, init);
      }),
    );

    await provision(harness, maya.surfaceId);

    const [create] = callsOf(slack, 'apps.manifest.create');
    expect(callsOf(slack, 'tooling.tokens.rotate')).toEqual([
      { method: 'tooling.tokens.rotate', form: { refresh_token: LANDED_REFRESH_TOKEN } },
    ]);
    expect(seenAtCreate).toEqual([
      {
        generation: 1,
        token: slack.configuration.token,
        refresh: slack.configuration.refreshToken,
      },
    ]);
    expect(create?.bearer).toBe(slack.configuration.token);
    // Slack states the expiry in whole seconds (`exp`), which the row keeps as it was stated.
    expect((await configurationRow(harness, connectionId)).expiresAt).toBe(
      Math.floor(Date.now() / 1000) * 1000 + 12 * HOUR,
    );
  });

  it('uses a token with time left as it is, and rotates one past its renewal margin', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const leo = await employee(harness, 'Leo');
    const ana = await employee(harness, 'Ana');

    await provision(harness, maya.surfaceId);
    await provision(harness, leo.surfaceId);
    expect(callsOf(slack, 'tooling.tokens.rotate')).toHaveLength(1);

    vi.setSystemTime(Date.now() + 11 * HOUR + 45 * 60 * 1000);
    await provision(harness, ana.surfaceId);
    expect(callsOf(slack, 'tooling.tokens.rotate')).toHaveLength(2);
    expect(callsOf(slack, 'apps.manifest.create').map((call) => call.bearer)).toEqual([
      'xoxe.xoxp-1-cfg1',
      'xoxe.xoxp-1-cfg1',
      'xoxe.xoxp-1-cfg2',
    ]);
  });

  it('rotates and tries once more when Slack refuses a token Day0 holds as current', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const leo = await employee(harness, 'Leo');
    await provision(harness, maya.surfaceId);
    // Slack ends the token early (an administrator revoked it, or Slack's clock is ahead).
    slack.configuration.issuedAt = Date.now() - 12 * HOUR;

    const made = await provision(harness, leo.surfaceId);

    expect(made.appId).toBe('A0APP2');
    expect(callsOf(slack, 'apps.manifest.create').map((call) => call.bearer)).toEqual([
      'xoxe.xoxp-1-cfg1',
      'xoxe.xoxp-1-cfg1',
      'xoxe.xoxp-1-cfg2',
    ]);
  });

  it("loses a concurrent rotation, re-reads, and uses the winner's token", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const winner = { token: 'xoxe.xoxp-1-winner', refresh: 'xoxe-1-winner' };
    slack.beforeRotationAnswers = async (): Promise<void> => {
      slack.beforeRotationAnswers = undefined;
      // Another rotation, from the same refresh token, wrote its pair first; Slack keeps only
      // the newest token live.
      const row = await configurationRow(harness, connectionId);
      const seal = async (plaintext: string) =>
        await harness.action(internal.credentialCryptoActions.seal, {
          plaintext,
          userId: ORGANISATION_OWNER_KEY,
        });
      const outcome = await harness.mutation(internal.slackProvision.recordRotation, {
        organisationConnectionId: connectionId,
        secretCredentialId: row._id,
        expectedGeneration: 0,
        token: await seal(winner.token),
        refresh: await seal(winner.refresh),
        expiresAt: Date.now() + 12 * HOUR,
        now: Date.now(),
      });
      expect(outcome).toEqual({ ok: true, generation: 1 });
      slack.configuration.token = winner.token;
      slack.configuration.refreshToken = winner.refresh;
    };

    await provision(harness, maya.surfaceId);

    expect(callsOf(slack, 'apps.manifest.create').map((call) => call.bearer)).toEqual([
      winner.token,
    ]);
    const row = await configurationRow(harness, connectionId);
    expect(row.generation).toBe(1);
    expect(await opened(harness, row._id)).toBe(winner.token);
    expect(
      (await ledger(harness))
        .filter((line) => line.type === 'organisation.configuration-used')
        .map((line) => [line.payload.method, line.payload.outcome]),
    ).toEqual([
      ['tooling.tokens.rotate', 'done'],
      ['tooling.tokens.rotate', 'superseded'],
      ['apps.manifest.create', 'done'],
    ]);
  });

  it('presents the refresh token to Slack once when two provisionings rotate at once, under the refresh lease (R-S)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const leo = await employee(harness, 'Leo');
    // On the real timer: the second rotation sleeps on the first's lease between its reads.
    vi.useRealTimers();

    await Promise.all([provision(harness, maya.surfaceId), provision(harness, leo.surfaceId)]);

    expect(callsOf(slack, 'tooling.tokens.rotate')).toEqual([
      { method: 'tooling.tokens.rotate', form: { refresh_token: LANDED_REFRESH_TOKEN } },
    ]);
    expect(callsOf(slack, 'apps.manifest.create').map((call) => call.bearer)).toEqual([
      slack.configuration.token,
      slack.configuration.token,
    ]);
    const connection = await harness.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection?.status).toBe('active');
    const row = await configurationRow(harness, connectionId);
    expect(row.generation).toBe(1);
    expect(row).not.toHaveProperty('refreshingUntil');
  });

  it("uses the configuration token that still lives after five seconds behind a dead renewal's lease, not a whole lease (the round review's m7)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    // Inside its renew margin but alive, behind the lease of a renewal whose action died.
    const row = await configurationRow(harness, connectionId);
    await harness.run(async (ctx) => {
      await ctx.db.patch(row._id, {
        expiresAt: Date.now() + 10 * 60 * 1000,
        refreshingUntil: Date.now() + 80_000,
      });
    });
    let done = false;
    const made = provision(harness, maya.surfaceId).finally((): void => {
      done = true;
    });
    // A full event-loop turn per step, so the action's own imports and reads run between ticks.
    const turn = async (): Promise<void> =>
      await new Promise<void>((resolve): void => {
        const { port1, port2 } = new MessageChannel();
        port2.onmessage = (): void => resolve();
        port1.postMessage(null);
      });
    try {
      for (let step = 0; step < 24 && !done; step += 1) {
        await vi.advanceTimersByTimeAsync(LEASE_POLL_MS);
        await turn();
      }
      expect(done).toBe(true);
    } finally {
      // Let a waiter that outlived the bound finish before the test ends, whatever it answers.
      for (let step = 0; step < 800 && !done; step += 1) {
        await vi.advanceTimersByTimeAsync(LEASE_POLL_MS);
        await turn();
      }
    }
    await expect(made).resolves.toMatchObject({ appId: expect.any(String) });
    expect(callsOf(slack, 'tooling.tokens.rotate')).toEqual([]);
    expect(callsOf(slack, 'apps.manifest.create').map((call) => call.bearer)).toEqual([
      LANDED_CONFIGURATION_TOKEN,
    ]);
  });

  it("uses a token pasted on the card when the organisation's connection cannot renew its own, and revokes it after", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    slack.refusals.set('tooling.tokens.rotate', 'invalid_refresh_token');
    // IT's own pair is spent, so the manager pastes a configuration token generated by hand;
    // Slack's newest token is the one the manager pasted.
    const pasted = 'xoxe.xoxp-1-pasted';
    slack.configuration.token = pasted;

    const made = await provision(harness, maya.surfaceId, pasted);

    expect(made.appId).toBe('A0APP1');
    expect(callsOf(slack, 'apps.manifest.create').map((call) => call.bearer)).toEqual([pasted]);
    expect(callsOf(slack, 'auth.revoke').map((call) => call.bearer)).toEqual([pasted]);
    const index = (method: string): number =>
      slack.calls.findIndex((call) => call.method === method);
    expect(index('auth.revoke')).toBeGreaterThan(index('apps.manifest.create'));
  });

  it('revokes the client secret and names the app when the card was given an app meanwhile', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const answer = slack.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
        const response = await answer(input, init);
        if (String(input).endsWith('/apps.manifest.create')) {
          // A second click's app was recorded first.
          await harness.run(async (ctx) => {
            const secret = await ctx.db.insert('credentials', {
              userId: ORGANISATION_OWNER_KEY,
              holder: ORGANISATION_HOLDER,
              kind: 'oauth',
              label: 'other',
              source: 'oauth',
              createdAt: 1,
            });
            await ctx.db.patch(maya.surfaceId, {
              provisioning: {
                appId: 'A0OTHER',
                appName: 'Maya (Day0)',
                clientId: '1234.0',
                clientSecretCredentialId: secret,
                installUrl: 'https://slack.com/oauth/v2/authorize',
                redirectUrl: `${PUBLIC_URL}/api/oauth/slack`,
                scopes: ['chat:write'],
                createdAt: 1,
              },
            });
          });
        }
        return response;
      }),
    );

    await expect(provision(harness, maya.surfaceId)).rejects.toThrow('delete app A0APP1');

    const secrets = await harness.run(async (ctx) =>
      (await ctx.db.query('credentials').collect()).filter(
        (row) => row.label === 'Maya (Day0) client secret',
      ),
    );
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.revokedAt).toBeDefined();
    // Stored with the app's issuer (the pre-tag's item 10), and revoked once the record refused it.
    expect(secrets[0]?.issuedBy).toMatchObject({
      system: 'slack',
      grant: 'app-created',
      appId: 'A0APP1',
    });
  });

  it("falls back to the card's field when the organisation's Slack connection is revoked", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'IT is moving workspaces',
    });
    const maya = await employee(harness, 'Maya');

    await expect(provision(harness, maya.surfaceId)).rejects.toThrow(
      'Paste an app configuration token',
    );
    expect(slack.calls).toEqual([]);

    const pasted = await provision(harness, maya.surfaceId, LANDED_CONFIGURATION_TOKEN);

    expect(callsOf(slack, 'tooling.tokens.rotate')).toEqual([]);
    expect(callsOf(slack, 'apps.manifest.create').map((call) => call.bearer)).toEqual([
      LANDED_CONFIGURATION_TOKEN,
    ]);
    const row = await card(harness, maya.surfaceId);
    expect(row.provisioning?.appId).toBe(pasted.appId);
    expect(row.provisioning?.organisationConnectionId).toBeUndefined();
    const secretId = row.provisioning?.clientSecretCredentialId;
    if (!secretId) throw new Error('no client secret');
    const secret = await credential(harness, secretId);
    expect(secret).toMatchObject({ holder: ORGANISATION_HOLDER, userId: ORGANISATION_OWNER_KEY });
    expect(secret.issuedBy).toEqual({
      system: 'slack',
      grant: 'app-created',
      appId: pasted.appId,
      clientId: row.provisioning?.clientId,
    });
  });
});

describe("the move off a pasted bot token onto the employee's own app (R41V-7)", (): void => {
  it("puts the employee's skills on the connected card due a re-check, since it now acts as another identity", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const pasted = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Slack bot token',
      plaintext: 'xoxb-1234567890-pasted',
      source: 'entered',
    });
    const skillId = await harness.run(async (ctx) => {
      await ctx.db.patch(maya.surfaceId, {
        verdict: 'connected',
        credentialId: pasted,
        credentialKind: 'value',
        credentialLanded: true,
        actsAs: {
          kind: 'shared-key',
          label: 'a key someone pasted',
          providerIdentityId: 'U0SHARED',
        },
      });
      return await ctx.db.insert('skills', {
        agentId: maya.agentId,
        name: 'chat-thread-reply',
        description: 'Reply in the thread',
        body: '# Procedure',
        sourceType: 'agent-authored',
        state: 'registered',
        targetSurface: 'slack',
        registeredAt: 1,
        createdAt: 1,
      });
    });

    await install(harness, await provision(harness, maya.surfaceId));

    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill).toMatchObject({
      recheckDueAt: expect.any(Number),
      recheckReason: 'its connection to slack now acts as another identity',
    });
  });
});

describe("a Slack connection's revoke as real Slack answers it (R41V-10)", (): void => {
  /** Revoke the connection from the setup verb and run the call at Slack it schedules. */
  async function revokeConnection(
    harness: Harness,
    connectionId: Id<'organisationConnections'>,
  ): Promise<void> {
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'IT is moving workspaces',
    });
    await settle(harness);
  }

  /** The `auth.revoke` lines on the connection's ledger. */
  async function revokeLines(harness: Harness): Promise<unknown[]> {
    return (await ledger(harness))
      .filter((line) => line.payload.method === 'auth.revoke')
      .map((line) => line.payload as unknown);
  }

  it("revokes the token Day0 holds as current at the revoke, after the walk's rotation at first use, and Slack leaves its refresh token", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    // The walk: the landed pair, rotated at the first app Day0 created with it (generation 1).
    await provision(harness, leo.surfaceId);
    const row = await configurationRow(harness, connectionId);
    expect(row.generation).toBe(1);
    const current = await opened(harness, row._id);

    await revokeConnection(harness, connectionId);

    expect(callsOf(slack, 'auth.revoke').map((call) => call.bearer)).toEqual([current]);
    expect(slack.configuration.revoked.has(current)).toBe(true);
    expect(await revokeLines(harness)).toEqual([expect.objectContaining({ outcome: 'done' })]);
    // Slack ended the token alone: its refresh token still rotates, which only IT can end.
    const rotated = await slack.fetch('https://slack.com/api/tooling.tokens.rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: slack.configuration.refreshToken }).toString(),
    });
    expect(await rotated.json()).toMatchObject({ ok: true });
  });

  it("says on the ledger that a revoke was not checked when Slack's auth.test could not be asked (the round review's m2)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    await provision(harness, leo.surfaceId);
    slack.refusals.set('auth.test', 'ratelimited');

    await revokeConnection(harness, connectionId);

    expect(callsOf(slack, 'auth.test')).toHaveLength(1);
    expect(await revokeLines(harness)).toEqual([
      expect.objectContaining({ outcome: 'done', unchecked: true }),
    ]);
  });

  it('records a revoke Slack answered but did not carry out as failed, after asking Slack whether the token still works', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    await provision(harness, leo.surfaceId);
    // The walk's anomaly: the ledger said done, and the token Day0 held still worked at Slack.
    slack.refusals.set('auth.revoke', 'token_revoked');

    await revokeConnection(harness, connectionId);

    expect(callsOf(slack, 'auth.test')).toHaveLength(1);
    expect(await revokeLines(harness)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        reason:
          'Slack answered token_revoked to auth.revoke, yet still accepted the token at auth.test',
      }),
    ]);
  });

  it('records a token Slack had already revoked as already revoked, never as revoked by Day0', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    await provision(harness, leo.surfaceId);
    // IT deleted the token's row on api.slack.com, which ends it under Day0.
    slack.configuration.revoked.add(slack.configuration.token);

    await revokeConnection(harness, connectionId);

    expect(await revokeLines(harness)).toEqual([
      expect.objectContaining({ outcome: 'already-revoked' }),
    ]);
  });

  it("records a token Slack does not know as not recognised, never as one Slack had ended (the round review's m3)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    await provision(harness, leo.surfaceId);
    // Bed 1: the fake was restarted, so the token Day0 holds is one Slack never issued.
    slack.configuration.token = 'xoxe.xoxp-9999999999-zyxwvutsrq';

    await revokeConnection(harness, connectionId);

    expect(await revokeLines(harness)).toEqual([
      expect.objectContaining({ outcome: 'unrecognised', reason: 'Slack answered invalid_auth' }),
    ]);
  });

  it('revokes the token a rotation in flight was issued when the revoke lands before the rotation is written', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    let issued = '';
    slack.beforeRotationAnswers = async (): Promise<void> => {
      slack.beforeRotationAnswers = undefined;
      issued = slack.configuration.token;
      await harness.mutation(internal.organisationConnections.revokeFromSetup, {
        organisationConnectionId: connectionId,
        reason: 'IT is moving workspaces',
      });
    };

    await expect(provision(harness, leo.surfaceId)).rejects.toThrow(
      'the organisation has no active Slack connection',
    );
    await settle(harness);

    expect(issued).toBe('xoxe.xoxp-1-cfg1');
    expect(callsOf(slack, 'auth.revoke').map((call) => call.bearer)).toEqual(
      expect.arrayContaining([LANDED_CONFIGURATION_TOKEN, issued]),
    );
    expect(slack.configuration.revoked.has(issued)).toBe(true);
    expect(await revokeLines(harness)).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'done', unkept: true })]),
    );
    expect(JSON.stringify(await ledger(harness))).not.toContain('xoxe');
  });
});

describe("the connection's ledger (AC11)", (): void => {
  it('writes a line for every use of the configuration token and its refresh token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    const leo = await employee(harness, 'Leo');

    const made = await provision(harness, maya.surfaceId);
    slack.refusals.set('apps.manifest.create', 'ratelimited');
    await expect(provision(harness, leo.surfaceId)).rejects.toThrow('ratelimited');

    const lines = await ledger(harness);
    expect(lines.map((line) => [line.type, line.payload.method, line.payload.outcome])).toEqual([
      ['organisation.connection-landed', undefined, undefined],
      ['organisation.configuration-used', 'tooling.tokens.rotate', 'done'],
      ['organisation.configuration-used', 'apps.manifest.create', 'done'],
      ['organisation.configuration-used', 'apps.manifest.create', 'failed'],
    ]);
    expect(lines[2]?.payload).toMatchObject({
      organisationConnectionId: connectionId,
      system: 'slack',
      displayName: 'Slack',
      appId: made.appId,
    });
    expect(lines[3]?.payload).toMatchObject({
      reason: 'Slack apps.manifest.create failed: ratelimited',
    });
    expect(JSON.stringify(lines)).not.toContain('xoxe');
  });

  it("marks the connection for IT's attention when Slack refuses the refresh token, and creates nothing", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    slack.refusals.set('tooling.tokens.rotate', 'invalid_refresh_token');

    await expect(provision(harness, maya.surfaceId)).rejects.toThrow('invalid_refresh_token');

    expect(callsOf(slack, 'apps.manifest.create')).toEqual([]);
    const connection = await harness.run(async (ctx) => await ctx.db.get(connectionId));
    expect(connection).toMatchObject({ status: 'needs-attention' });
    expect(connection?.statusReason).toContain('generate a new configuration token');
    expect((await ledger(harness)).at(-1)?.payload).toMatchObject({
      method: 'tooling.tokens.rotate',
      outcome: 'failed',
    });
  });
});

describe('keeping the configuration token current (B9; 11-AR re-check)', (): void => {
  it('renews the kept token an hour before it lapses though nothing uses it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    await provision(harness, maya.surfaceId);
    const firstExpiry = (await configurationRow(harness, connectionId)).expiresAt ?? 0;

    await passHours(harness, 11);

    expect(callsOf(slack, 'tooling.tokens.rotate')).toHaveLength(2);
    const row = await configurationRow(harness, connectionId);
    expect(row.generation).toBe(2);
    expect(row.expiresAt).toBeGreaterThan(firstExpiry);
    expect(await opened(harness, row._id)).toBe(slack.configuration.token);
  });

  it('renews nothing while the deployment is paused, and renews once it is not', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    await provision(harness, maya.surfaceId);
    vi.stubEnv('DAY0_CRONS_PAUSED', 'upgrade');

    await passHours(harness, 12);
    expect(callsOf(slack, 'tooling.tokens.rotate')).toHaveLength(1);

    vi.stubEnv('DAY0_CRONS_PAUSED', '');
    await passHours(harness, 1);
    expect(callsOf(slack, 'tooling.tokens.rotate')).toHaveLength(2);
  });

  it('stops when IT revokes the connection', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    await provision(harness, maya.surfaceId);
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'IT is moving workspaces',
    });

    await passHours(harness, 24);

    expect(callsOf(slack, 'tooling.tokens.rotate')).toHaveLength(1);
  });

  it("keeps trying a renewal Slack could not answer, past the token's twelve hours, and renews once Slack answers", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    await provision(harness, maya.surfaceId);
    slack.refusals.set('tooling.tokens.rotate', 'service_unavailable');

    // One renewal a step: the clock moves an hour at a time. The old cap stopped at five tries.
    await passHours(harness, 18);
    const tries = callsOf(slack, 'tooling.tokens.rotate').length;
    expect(tries).toBeGreaterThan(5);
    slack.refusals.delete('tooling.tokens.rotate');
    await passHours(harness, 1);

    expect(callsOf(slack, 'tooling.tokens.rotate').length).toBe(tries + 1);
    const row = await configurationRow(harness, connectionId);
    expect(row.generation).toBe(2);
    expect(await opened(harness, row._id)).toBe(slack.configuration.token);
    expect(await harness.run(async (ctx) => await ctx.db.get(connectionId))).toMatchObject({
      status: 'active',
    });
  });

  it('stops renewing once Slack refuses the refresh token, leaving the connection for IT', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const maya = await employee(harness, 'Maya');
    await provision(harness, maya.surfaceId);
    slack.refusals.set('tooling.tokens.rotate', 'invalid_refresh_token');

    await passHours(harness, 24);

    expect(callsOf(slack, 'tooling.tokens.rotate')).toHaveLength(2);
    expect(await harness.run(async (ctx) => await ctx.db.get(connectionId))).toMatchObject({
      status: 'needs-attention',
    });
  });

  it('records app-deleted for a retire on a connection landed 13 hours earlier', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    const made = await provision(harness, leo.surfaceId);
    await install(harness, made);
    await settle(harness);

    await passHours(harness, 13);
    const row = await card(harness, leo.surfaceId);
    const secretId = row.provisioning?.clientSecretCredentialId;
    if (!row.credentialId || !secretId) throw new Error('Leo holds no identity');
    await harness.run(async (ctx) => {
      const rows = await Promise.all([row.credentialId, secretId].map((id) => ctx.db.get(id!)));
      await endAccessAtSource(ctx, {
        agentId: leo.agentId,
        surfaceId: leo.surfaceId,
        surfaceName: 'Slack',
        credentials: rows.filter((held): held is Doc<'credentials'> => held !== null),
        end: 'retire',
        now: Date.now(),
      });
    });
    await settle(harness);

    const lines = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect())
        .filter((event) => event.type === 'credential.revoked-at-source')
        .map((event) => event.payload as { outcome: string }),
    );
    expect(lines).toEqual([expect.objectContaining({ end: 'retire', outcome: 'app-deleted' })]);
    expect(slack.apps.find((app) => app.appId === made.appId)?.deleted).toBe(true);
    expect((await ledger(harness)).at(-1)).toMatchObject({
      organisationConnectionId: connectionId,
      type: 'organisation.revoked-at-source',
      payload: { outcome: 'app-deleted' },
    });
  });
});

describe('the renewal and the re-join (A26, RM4)', (): void => {
  /**
   * Leo with his own app installed, then his access expired: Slack revoked his bot token. His
   * documentation carries no manifest template unless one is given, so his app is the kit's,
   * which asks for `channels:join`.
   */
  async function expiredLeo(
    harness: Harness,
    documentation = KIT_ONLY,
  ): Promise<Employee & { appId: string }> {
    await landSlack(harness);
    const leo = await employee(harness, 'Leo', {
      documentation,
      channels: ['#revops', 'revops-leads'],
    });
    const made = await provision(harness, leo.surfaceId);
    await install(harness, made);
    await settle(harness);
    const app = slack.apps.find((candidate) => candidate.appId === made.appId);
    if (!app) throw new Error('no app');
    slack.memberships.set(app.botUserId, new Set(['C_REVOPS']));
    await harness.run(async (ctx) => await ctx.db.patch(leo.surfaceId, { expiresAt: Date.now() }));
    await harness.mutation(internal.surfaces.recordExpired, {
      surfaceId: leo.surfaceId,
      now: Date.now() + 1,
    });
    await settle(harness);
    expect(slack.memberships.get(app.botUserId)).toBeUndefined();
    return { ...leo, appId: made.appId };
  }

  it("issues the kept app's install link again with no configuration token, and creates no second app", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await expiredLeo(harness);
    const renewed = await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.setAccessDays, { surfaceId: leo.surfaceId, days: 30 });
    expect(renewed.reissue).toBe('install');
    const before = slack.calls.length;

    const again = await provision(harness, leo.surfaceId);

    expect(again.appId).toBe(leo.appId);
    expect(slack.calls.slice(before)).toEqual([]);
    expect(slack.apps).toHaveLength(1);
  });

  it('after a renewal the employee is back in its public intake channels and the private ones are named as needing a person', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await expiredLeo(harness);
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.setAccessDays, { surfaceId: leo.surfaceId, days: 30 });

    await install(harness, await provision(harness, leo.surfaceId));

    const app = slack.apps.find((candidate) => candidate.appId === leo.appId);
    expect([...(slack.memberships.get(app?.botUserId ?? '') ?? [])]).toEqual(['C_REVOPS']);
    expect(callsOf(slack, 'conversations.join').map((call) => call.form.channel)).toEqual([
      'C_REVOPS',
    ]);
    const rejoined = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'surface.channels-rejoined',
      ),
    );
    expect(rejoined.map((event) => event.payload)).toEqual([
      { surfaceId: leo.surfaceId, joined: ['#revops'], needsPerson: ['#revops-leads'] },
    ]);
  });

  it('does not install again an app whose connection IT revoked, and names what IT does next', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await expiredLeo(harness);
    const [connection] = await harness.run(
      async (ctx) => await ctx.db.query('organisationConnections').collect(),
    );
    if (!connection) throw new Error('no connection');
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connection._id,
      reason: 'IT is moving workspaces',
    });

    await expect(provision(harness, leo.surfaceId)).rejects.toThrow(KEPT_APP_CONNECTION_REVOKED);
    expect(callsOf(slack, 'apps.manifest.create')).toHaveLength(1);
  });

  it('joins nothing on a first install: the administrator invites a new app', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await landSlack(harness);
    const leo = await employee(harness, 'Leo', { channels: ['revops'] });

    await install(harness, await provision(harness, leo.surfaceId));

    expect(callsOf(slack, 'conversations.join')).toEqual([]);
  });

  it("names every channel as needing a person when the documentation's template did not ask for channels:join, and keeps the install", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const leo = await expiredLeo(harness, POLICY);
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.setAccessDays, { surfaceId: leo.surfaceId, days: 30 });

    await install(harness, await provision(harness, leo.surfaceId));

    expect((await card(harness, leo.surfaceId)).credentialId).toBeDefined();
    const rejoined = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'surface.channels-rejoined',
      ),
    );
    expect(rejoined.map((event) => event.payload)).toEqual([
      {
        surfaceId: leo.surfaceId,
        joined: [],
        needsPerson: ['#revops', '#revops-leads'],
        reason: 'missing_scope',
      },
    ]);
  });
});

describe('the install through the connection (the cockpit: recordInstalledApp)', (): void => {
  it("installs an app while its connection needs IT's attention, since the install uses no configuration token", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    const ana = await employee(harness, 'Ana');
    await provision(harness, leo.surfaceId);
    vi.setSystemTime(Date.now() + 12 * HOUR);
    slack.refusals.set('tooling.tokens.rotate', 'invalid_refresh_token');
    await expect(provision(harness, ana.surfaceId)).rejects.toThrow('invalid_refresh_token');
    expect(await harness.run(async (ctx) => await ctx.db.get(connectionId))).toMatchObject({
      status: 'needs-attention',
    });

    await install(harness, await provision(harness, leo.surfaceId));

    const row = await card(harness, leo.surfaceId);
    expect(row.credentialId).toBeDefined();
    expect(row.organisationConnectionId).toBe(connectionId);
  });

  it('takes back a bot token whose install could not be recorded, in Day0 and at Slack', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    const made = await provision(harness, leo.surfaceId);
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'IT is moving workspaces',
    });
    const app = slack.apps.find((candidate) => candidate.appId === made.appId);
    const state = new URL(made.installUrl).searchParams.get('state') ?? '';

    const outcome = await harness.action(internal.slackProvisionActions.completeInstallInternal, {
      state,
      code: app?.code ?? '',
    });

    expect(outcome).toMatchObject({ ok: false, reason: KEPT_APP_CONNECTION_REVOKED });
    expect(callsOf(slack, 'auth.revoke').map((call) => call.bearer)).toEqual([app?.botToken]);
    const bots = await harness.run(async (ctx) =>
      (await ctx.db.query('credentials').collect()).filter((row) =>
        row.label.startsWith('Slack bot token'),
      ),
    );
    // Stored with the install's issuer (the pre-tag's item 10), and taken back when the record failed.
    expect(
      bots.map((row) => [row.holder, row.revokedAt !== undefined, row.issuedBy?.grant]),
    ).toEqual([[ORGANISATION_HOLDER, true, 'oauth-install']]);
    expect((await card(harness, leo.surfaceId)).credentialId).toBeUndefined();
  });

  it("refuses to bind a row the organisation holds that no install just landed, such as IT's configuration token", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    await provision(harness, leo.surfaceId);
    const configuration = await configurationRow(harness, connectionId);

    await expect(
      harness.mutation(internal.surfaces.recordInstalledApp, {
        surfaceId: leo.surfaceId,
        credentialId: configuration._id,
        now: Date.now(),
      }),
    ).rejects.toThrow('not one an install just landed');
    const row = await card(harness, leo.surfaceId);
    expect(row.credentialId).toBeUndefined();
    expect((await configurationRow(harness, connectionId)).issuedBy).toBeUndefined();
  });

  it('lands the bot token held by the organisation with issuedBy, acts as the app and links the card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await landSlack(harness);
    const leo = await employee(harness, 'Leo');
    const made = await provision(harness, leo.surfaceId);

    await install(harness, made);

    const row = await card(harness, leo.surfaceId);
    expect(row.organisationConnectionId).toBe(connectionId);
    expect(row.actsAs).toEqual({
      kind: 'own-app',
      label: 'Leo (Day0)',
      providerIdentityId: 'U0BOT1',
    });
    if (!row.credentialId || !row.provisioning) throw new Error('no identity');
    expect(await credential(harness, row.credentialId)).toMatchObject({
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      issuedBy: {
        system: 'slack',
        grant: 'oauth-install',
        appId: made.appId,
        clientId: row.provisioning.clientId,
        clientSecretCredentialId: row.provisioning.clientSecretCredentialId,
        organisationConnectionId: connectionId,
      },
    });
  });
});

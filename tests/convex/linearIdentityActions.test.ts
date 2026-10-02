import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { sealForOwner } from '../../src/lib/credential-crypto';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { applyProvenance, parseSurfaceAction } from '../../src/surfaces/policy';
import { toSurfaceRecord } from '../../src/surfaces/records';
import type { MockAction } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { fakeLinear, type FakeLinear } from './fakes/linear-oauth';
import { managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const PUBLIC_URL = 'https://day0.acme.test';
const REDIRECT = `${PUBLIC_URL}/api/oauth/linear`;
const SHARED_CLIENT = 'day0-shared';
const SHARED_SECRET = 'shared-client-secret';
const LEO_CLIENT = 'day0-leo';
const LEO_SECRET = 'leo-client-secret';
const SCOPE_SET = ['read', 'write', 'app:assignable'];
const ADMINISTRATOR = 'ines@acme.test';
const DAY = 24 * 60 * 60 * 1_000;

let clock: number;
let credentialKey: string;
let linear: FakeLinear;

beforeEach(async (): Promise<void> => {
  useSurfaceMode('real');
  credentialKey = randomBytes(32).toString('base64');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', credentialKey);
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  vi.stubEnv('DAY0_ADMINISTRATORS', ADMINISTRATOR);
  clock = 1_800_000_000_000;
  linear = fakeLinear(
    [
      {
        clientId: SHARED_CLIENT,
        clientSecret: SHARED_SECRET,
        clientCredentials: true,
        appUser: { id: 'app-user-day0-shared', name: 'Day0' },
        redirectUris: [REDIRECT],
      },
      {
        clientId: LEO_CLIENT,
        clientSecret: LEO_SECRET,
        clientCredentials: false,
        appUser: { id: 'app-user-day0-leo', name: 'Day0 Leo' },
        redirectUris: [REDIRECT],
      },
    ],
    () => clock,
  );
  const actions = await import('../../convex/linearIdentityActions');
  actions.__setLinearIdentityDepsForTest({ fetch: linear.fetch, now: () => clock });
});

afterEach(async (): Promise<void> => {
  const actions = await import('../../convex/linearIdentityActions');
  actions.__setLinearIdentityDepsForTest(undefined);
  restoreSurfaceMode();
  vi.unstubAllEnvs();
});

/** The generated API as the reset module registry evaluates it. */
async function liveApi(): Promise<typeof import('../../convex/_generated/api')> {
  return await import('../../convex/_generated/api');
}

interface Seeded {
  readonly agentId: Id<'agents'>;
  readonly surfaceIds: Id<'surfaces'>[];
  readonly connectionId: Id<'organisationConnections'>;
}

/**
 * Approved Linear cards for one employee each, and the organisation's Linear app connection in
 * the mode given, as IT landed it.
 */
async function seed(
  harness: TestConvex<typeof schema>,
  options: {
    mode: 'shared' | 'per-employee';
    cards?: number;
    clientCredentialsScopes?: string[];
  },
): Promise<Seeded> {
  return await harness.run(async (ctx): Promise<Seeded> => {
    const surfaceIds: Id<'surfaces'>[] = [];
    let firstAgent: Id<'agents'> | undefined;
    for (let index = 0; index < (options.cards ?? 1); index += 1) {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'ana@acme.test',
        name: index === 0 ? 'Leo' : `Employee ${index}`,
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      firstAgent ??= agentId;
      surfaceIds.push(
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'approved',
          whereFound: [],
          path: 'mcp',
          endpoint: 'https://mcp.linear.app/mcp',
          managerApprovedAt: 2,
          credentialLanded: false,
          createdAt: 1,
        }),
      );
    }
    const shared = options.mode === 'shared';
    const secretCredentialId = await ctx.db.insert('credentials', {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label: 'Linear client secret',
      ...sealForOwner(
        shared ? SHARED_SECRET : 'per-employee-unused',
        { current: credentialKey },
        ORGANISATION_OWNER_KEY,
      ),
      source: 'entered',
      createdAt: 1,
    });
    const connectionId = await ctx.db.insert('organisationConnections', {
      system: 'linear',
      displayName: 'Linear',
      kind: 'oauth-app',
      mode: options.mode,
      scopes: SCOPE_SET,
      registeredBy: { via: 'setup-cli', at: 1 },
      status: 'active',
      createdAt: 1,
      clientId: shared ? SHARED_CLIENT : 'day0-it-registration',
      secretCredentialId,
      ...(shared ? { clientCredentialsScopes: options.clientCredentialsScopes ?? SCOPE_SET } : {}),
    });
    return { agentId: firstAgent!, surfaceIds, connectionId };
  });
}

async function read(harness: TestConvex<typeof schema>, surfaceId: Id<'surfaces'>) {
  return await harness.run(async (ctx) => ({
    surface: (await ctx.db.get(surfaceId)) as Doc<'surfaces'>,
    credentials: await ctx.db.query('credentials').collect(),
    events: await ctx.db.query('events').collect(),
    connection: (await ctx.db
      .query('organisationConnections')
      .first()) as Doc<'organisationConnections'>,
    scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
  }));
}

/** The token requests the fake Linear answered, with the scope each carried. */
function tokenRequests(): Array<{ grant?: string; scope?: string }> {
  return linear.requests
    .filter((request) => request.path === '/oauth/token')
    .map(({ grant, scope }) => ({ grant, ...(scope === undefined ? {} : { scope }) }));
}

async function connect(harness: TestConvex<typeof schema>, surfaceId: Id<'surfaces'>) {
  const { api } = await liveApi();
  return await harness.withIdentity(managerIdentity()).action(api.linearIdentityActions.connect, {
    surfaceId,
  });
}

async function bearerOf(
  harness: TestConvex<typeof schema>,
  credentialId: Id<'credentials'>,
): Promise<string> {
  const { internal } = await liveApi();
  return await harness.action(internal.linearIdentityActions.currentBearer, { credentialId });
}

describe('shared mode: the organisation app actor', (): void => {
  it("connects a card as the organisation's app user, through the connection's one token", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds, connectionId } = await seed(harness, { mode: 'shared' });

    await expect(connect(harness, surfaceIds[0]!)).resolves.toEqual({ ok: true, connected: true });

    const { surface, credentials, connection, scheduled } = await read(harness, surfaceIds[0]!);
    const token = credentials.find((row) => row._id === connection.sharedTokenCredentialId);
    expect(token).toMatchObject({
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'oauth',
      issuedBy: {
        system: 'linear',
        grant: 'client-credentials',
        organisationConnectionId: connectionId,
        clientId: SHARED_CLIENT,
      },
      expiresAt: clock + (30 * 24 * 60 * 60 - 1) * 1_000,
      generation: 0,
    });
    expect(surface).toMatchObject({
      credentialId: token?._id,
      organisationConnectionId: connectionId,
      actsAs: { kind: 'shared-app', label: 'Linear', providerIdentityId: 'app-user-day0-shared' },
    });
    expect(scheduled.map((job) => job.name)).toEqual(
      expect.arrayContaining([
        'surfaceActions:probeInternal',
        'linearIdentityActions:renewSharedScheduled',
      ]),
    );
    expect(await bearerOf(harness, token!._id)).toMatch(/^lin_oauth_shared_/);
  });

  it("writes through the shared card carry the employee's trailer", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    await connect(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);
    const comment: MockAction = {
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ issueId: 'FIN-3', body: 'Reconciled.' }),
      },
    };
    const parsed = parseSurfaceAction(comment);
    if (!parsed.ok) throw new Error(parsed.reason);
    const record = toSurfaceRecord(surface);

    const signed = applyProvenance(
      parsed.action,
      record,
      { agentName: 'Leo', workItemId: 'wi_1', runId: 'run_1' },
      record.credentialKind ?? 'value',
    );

    expect(signed).toMatchObject({
      ok: true,
      action: { toolArgs: { body: 'Reconciled.\n\n-- Leo (Day0) · run wi_1/run_1' } },
    });
  });

  it("requests the shared token with the connection's scope set and never another", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds, connectionId } = await seed(harness, { mode: 'shared', cards: 2 });
    const { internal } = await liveApi();

    await connect(harness, surfaceIds[0]!);
    await connect(harness, surfaceIds[1]!);
    const { connection } = await read(harness, surfaceIds[0]!);
    const tokenId = connection.sharedTokenCredentialId!;
    // A 401 (the secret rotated, say), a renewal in its last day, and the scheduled renewal.
    linear.revokeAppTokens(SHARED_CLIENT);
    await harness.action(internal.linearIdentityActions.renewAfterRefusal, {
      credentialId: tokenId,
      generation: 0,
    });
    clock += 29.5 * DAY;
    await bearerOf(harness, tokenId);
    clock += 29.5 * DAY;
    await harness.action(internal.linearIdentityActions.renewSharedScheduled, {
      organisationConnectionId: connectionId,
      generation: 2,
    });

    const requests = tokenRequests();
    expect(requests.length).toBe(4);
    expect(new Set(requests.map((request) => request.scope))).toEqual(
      new Set(['read,write,app:assignable']),
    );
    expect(requests.every((request) => request.grant === 'client_credentials')).toBe(true);
    expect(linear.revokedByScopeChange()).toBe(0);
  });

  it('never sends a request when the connection holds no scope set, so no default set revokes the app', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared', clientCredentialsScopes: [] });

    await expect(connect(harness, surfaceIds[0]!)).rejects.toThrow(
      'no client-credentials scope set',
    );

    expect(tokenRequests()).toEqual([]);
    const { surface } = await read(harness, surfaceIds[0]!);
    expect(surface.credentialId).toBeUndefined();
  });

  it('keeps the token to its last day: one request for every card, renewed in place after', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared', cards: 2 });
    await connect(harness, surfaceIds[0]!);
    await connect(harness, surfaceIds[1]!);
    const { connection } = await read(harness, surfaceIds[0]!);
    const tokenId = connection.sharedTokenCredentialId!;
    const first = await bearerOf(harness, tokenId);

    clock += 28 * DAY;
    expect(await bearerOf(harness, tokenId)).toBe(first);
    expect(tokenRequests()).toHaveLength(1);

    clock += 1.5 * DAY;
    const renewed = await bearerOf(harness, tokenId);
    expect(renewed).not.toBe(first);
    expect(tokenRequests()).toHaveLength(2);
    const after = await read(harness, surfaceIds[1]!);
    expect(after.connection.sharedTokenCredentialId).toBe(tokenId);
    expect(after.surface.credentialId).toBe(tokenId);
    expect(after.credentials.find((row) => row._id === tokenId)?.generation).toBe(1);
  });

  it('answers a 401 with one new request, and a second refusal of the same token with its successor', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    const { internal } = await liveApi();
    await connect(harness, surfaceIds[0]!);
    const tokenId = (await read(harness, surfaceIds[0]!)).connection.sharedTokenCredentialId!;
    const refused = await bearerOf(harness, tokenId);
    linear.revokeAppTokens(SHARED_CLIENT);

    const renewed = await harness.action(internal.linearIdentityActions.renewAfterRefusal, {
      credentialId: tokenId,
      generation: 0,
    });
    const again = await harness.action(internal.linearIdentityActions.renewAfterRefusal, {
      credentialId: tokenId,
      generation: 0,
    });

    expect(renewed).not.toBe(refused);
    expect(linear.live(renewed)).toBe(true);
    expect(again).toBe(renewed);
    expect(tokenRequests()).toHaveLength(2);
  });

  it('names an app without client credentials turned on, and connects nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    await harness.run(async (ctx) => {
      const connection = await ctx.db.query('organisationConnections').first();
      await ctx.db.patch(connection!._id, { clientId: LEO_CLIENT });
      await ctx.db.patch(connection!.secretCredentialId!, {
        ...sealForOwner(LEO_SECRET, { current: credentialKey }, ORGANISATION_OWNER_KEY),
      });
    });

    await expect(connect(harness, surfaceIds[0]!)).rejects.toThrow(
      'Client does not support the client_credentials grant type',
    );
    expect((await read(harness, surfaceIds[0]!)).surface.credentialId).toBeUndefined();
  });

  it('refuses a caller who does not own the employee, and a card the manager has not approved', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    const { api } = await liveApi();

    await expect(
      harness
        .withIdentity(managerIdentity('someone-else'))
        .action(api.linearIdentityActions.connect, { surfaceId: surfaceIds[0]! }),
    ).rejects.toThrow();
    await harness.run(async (ctx) =>
      ctx.db.patch(surfaceIds[0]!, { managerApprovedAt: undefined }),
    );
    await expect(connect(harness, surfaceIds[0]!)).resolves.toMatchObject({
      ok: false,
      reason: 'not-approved',
    });
    expect(tokenRequests()).toEqual([]);
  });
});

/** An administrator records Leo's app and follows the install link through Linear's consent. */
async function installLeo(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
  options: { deny?: boolean } = {},
) {
  const { api } = await liveApi();
  const registered = await harness
    .withIdentity(managerIdentity('ines', { email: ADMINISTRATOR }))
    .action(api.linearIdentityActions.registerEmployeeApp, {
      surfaceId,
      clientId: LEO_CLIENT,
      clientSecret: LEO_SECRET,
    });
  if (!registered.ok) throw new Error(registered.message);
  const back = linear.consent(registered.authoriseUrl, options);
  const param = (name: string): Record<string, string> => {
    const value = back.searchParams.get(name);
    return value === null ? {} : { [name]: value };
  };
  return await harness.action(api.linearIdentityActions.completeAuthorisation, {
    state: back.searchParams.get('state') ?? '',
    ...param('code'),
    ...param('error'),
  });
}

describe("per-employee mode: the employee's own app", (): void => {
  it('acts as its own app user once a Linear administrator installs its app', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceIds, connectionId } = await seed(harness, { mode: 'per-employee' });

    await expect(installLeo(harness, surfaceIds[0]!)).resolves.toEqual({
      ok: true,
      agentId,
      surfaceSlug: 'linear',
    });

    const { surface, credentials, events, scheduled } = await read(harness, surfaceIds[0]!);
    const secret = credentials.find(
      (row) => row._id === surface.provisioning?.clientSecretCredentialId,
    );
    const access = credentials.find((row) => row._id === surface.credentialId);
    const refresh = credentials.find((row) => row._id === access?.refreshCredentialId);
    expect(surface).toMatchObject({
      credentialKind: 'oauth',
      organisationConnectionId: connectionId,
      actsAs: { kind: 'own-app', label: 'Day0 Leo', providerIdentityId: 'app-user-day0-leo' },
      provisioning: { appName: 'Day0 Leo', clientId: LEO_CLIENT, redirectUrl: REDIRECT },
    });
    expect(surface.pendingAuthorisation).toBeUndefined();
    expect(secret).toMatchObject({
      holder: ORGANISATION_HOLDER,
      issuedBy: { system: 'linear', grant: 'app-created', clientId: LEO_CLIENT },
    });
    for (const row of [access, refresh]) {
      expect(row).toMatchObject({
        userId: ORGANISATION_OWNER_KEY,
        holder: ORGANISATION_HOLDER,
        issuedBy: {
          system: 'linear',
          grant: 'authorisation-code',
          organisationConnectionId: connectionId,
          clientId: LEO_CLIENT,
          clientSecretCredentialId: secret?._id,
        },
      });
    }
    expect(access).toMatchObject({ generation: 0, expiresAt: clock + (24 * 60 * 60 - 1) * 1_000 });
    expect(events.map((event) => event.type)).toEqual([
      'surface.app-provisioned',
      'surface.app-installed',
    ]);
    expect(scheduled.map((job) => job.name)).toEqual(
      expect.arrayContaining([
        'surfaceActions:probeInternal',
        'linearIdentityActions:refreshScheduled',
      ]),
    );
    expect(linear.live(await bearerOf(harness, access!._id))).toBe(true);
  });

  it('refreshes an expired access token and rotates the pair through the rotation-safe write', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);
    const first = await bearerOf(harness, surface.credentialId!);

    clock += DAY + 60_000;
    const refreshed = await bearerOf(harness, surface.credentialId!);

    expect(refreshed).not.toBe(first);
    expect(linear.live(refreshed)).toBe(true);
    expect(tokenRequests().map((request) => request.grant)).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    const { credentials } = await read(harness, surfaceIds[0]!);
    const access = credentials.find((row) => row._id === surface.credentialId);
    expect(access).toMatchObject({ generation: 1, issuedBy: { grant: 'token-rotation' } });
    expect(
      credentials.find((row) => row._id === access?.refreshCredentialId)?.issuedBy?.grant,
    ).toBe('token-rotation');
  });

  it('ends the card with the reason when Linear refuses the refresh of an expired token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);
    linear.revokeAppTokens(LEO_CLIENT);

    clock += DAY + 60_000;

    await expect(bearerOf(harness, surface.credentialId!)).rejects.toThrow(
      /Linear refused to renew the token: .*Refresh token is invalid or expired.*Day0 is unauthorised in Linear until a Linear administrator installs the app again from the card\./,
    );
  });

  it('writes a refused scheduled refresh onto the card and checks the card when the token dies', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const { internal } = await liveApi();
    await installLeo(harness, surfaceIds[0]!);
    const { surface, credentials } = await read(harness, surfaceIds[0]!);
    const access = credentials.find((row) => row._id === surface.credentialId)!;
    linear.revokeAppTokens(LEO_CLIENT);

    await harness.action(internal.linearIdentityActions.refreshScheduled, {
      credentialId: access._id,
      generation: 0,
    });

    const after = await read(harness, surfaceIds[0]!);
    expect(after.events.at(-1)).toMatchObject({
      type: 'surface.install-failed',
      payload: {
        surfaceId: surfaceIds[0],
        reason: expect.stringContaining('until a Linear administrator installs the app again'),
      },
    });
    expect(
      after.scheduled.some(
        (job) =>
          job.name === 'surfaceActions:probeInternal' && job.scheduledTime === access.expiresAt,
      ),
    ).toBe(true);
  });

  it('records a declined installation on the card and keeps no token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });

    const result = await installLeo(harness, surfaceIds[0]!, { deny: true });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('access_denied') });
    const { surface, events } = await read(harness, surfaceIds[0]!);
    expect(surface.credentialId).toBeUndefined();
    expect(events.at(-1)?.type).toBe('surface.install-failed');
    expect(tokenRequests()).toEqual([]);
  });

  it('lets only an administrator record the app, and answers the access request before one is recorded', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const { api } = await liveApi();

    await expect(
      harness
        .withIdentity(managerIdentity())
        .action(api.linearIdentityActions.registerEmployeeApp, {
          surfaceId: surfaceIds[0]!,
          clientId: LEO_CLIENT,
          clientSecret: LEO_SECRET,
        }),
    ).rejects.toThrow();
    await expect(connect(harness, surfaceIds[0]!)).resolves.toMatchObject({
      ok: false,
      reason: 'install-needed',
    });
  });

  it('refuses a replayed redirect: the installation is consumed once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const { api } = await liveApi();
    const registered = await harness
      .withIdentity(managerIdentity('ines', { email: ADMINISTRATOR }))
      .action(api.linearIdentityActions.registerEmployeeApp, {
        surfaceId: surfaceIds[0]!,
        clientId: LEO_CLIENT,
        clientSecret: LEO_SECRET,
      });
    if (!registered.ok) throw new Error(registered.message);
    const back = linear.consent(registered.authoriseUrl);
    const redirect = {
      state: back.searchParams.get('state') ?? '',
      code: back.searchParams.get('code') ?? '',
    };

    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, redirect),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, redirect),
    ).resolves.toMatchObject({ ok: false });
  });

  it("starts a fresh installation from the card's Connect once the app is recorded", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);

    const started = await connect(harness, surfaceIds[0]!);

    expect(started).toMatchObject({ ok: true, authoriseUrl: expect.stringContaining('actor=app') });
    const { surface } = await read(harness, surfaceIds[0]!);
    expect(surface.pendingAuthorisation).toMatchObject({
      clientId: LEO_CLIENT,
      redirectUrl: REDIRECT,
    });
  });
});

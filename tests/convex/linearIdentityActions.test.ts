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
import { readLinearViewer } from '../../src/surfaces/identity-issuers/linear';
import { nangoLocation } from '../../src/surfaces/nango-token-store';
import { managerIdentity } from './fakes/manager-identity';
import { throughTimers } from './fakes/fake-clock';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const PUBLIC_URL = 'https://day0.acme.test';
const REDIRECT = `${PUBLIC_URL}/api/oauth/linear`;
const SHARED_CLIENT = 'day0-shared';
const SHARED_SECRET = 'shared-client-secret';
const LEO_CLIENT = 'day0-leo';
const LEO_SECRET = 'leo-client-secret';
const LEO_SECOND_CLIENT = 'day0-leo-2';
const LEO_SECOND_SECRET = 'leo-second-secret';
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
  // The clock starts at the real one under fake timers (the wave 11 review's M11 a): a clock ahead
  // of it put every scheduled refresh past the timer's range, so each fired at once, in a loop.
  vi.useFakeTimers();
  clock = Date.now();
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
      {
        clientId: LEO_SECOND_CLIENT,
        clientSecret: LEO_SECOND_SECRET,
        clientCredentials: false,
        appUser: { id: 'app-user-day0-leo-2', name: 'Day0 Leo 2' },
        redirectUris: [REDIRECT],
      },
    ],
    () => clock,
  );
  const actions = await import('../../convex/linearIdentityActions');
  actions.__setLinearIdentityDepsForTest({ fetch: linear.fetch, now: () => clock });
});

afterEach(async (): Promise<void> => {
  vi.useRealTimers();
  const actions = await import('../../convex/linearIdentityActions');
  actions.__setLinearIdentityDepsForTest(undefined);
  restoreSurfaceMode();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
      providerIdentityId: 'app-user-day0-shared',
    });
    expect(scheduled.map((job) => job.name)).toEqual(
      expect.arrayContaining([
        'surfaceActions:probeInternal',
        'linearIdentityActions:renewSharedScheduled',
      ]),
    );
    expect(await bearerOf(harness, token!._id)).toMatch(/^lin_oauth_shared_/);
  });

  it("puts the employee's skills on a connected card due a re-check when it moves off a pasted key onto the shared app (R41V-7)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceIds } = await seed(harness, { mode: 'shared' });
    const { internal } = await liveApi();
    // The walk's Wren: the card connected on a key pasted while no connection was active, and a
    // skill authored and verified under it.
    const pasted = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Linear key',
      plaintext: 'lin_api_pasted_0123456789',
      source: 'entered',
    });
    const skillId = await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceIds[0]!, {
        verdict: 'connected',
        credentialId: pasted,
        credentialKind: 'value',
        credentialLanded: true,
        lastVerifiedAt: 3,
        actsAs: { kind: 'shared-key', label: 'a key someone pasted', providerIdentityId: 'sam' },
        providerIdentityId: 'sam',
      });
      return await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Comment and close',
        body: '# Procedure',
        sourceType: 'agent-authored',
        state: 'registered',
        targetSurface: 'linear',
        registeredAt: 3,
        createdAt: 3,
      });
    });

    await expect(connect(harness, surfaceIds[0]!)).resolves.toEqual({ ok: true, connected: true });

    const { surface } = await read(harness, surfaceIds[0]!);
    expect(surface.verdict).toBe('connected');
    expect(surface.actsAs).toMatchObject({ kind: 'shared-app' });
    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill).toMatchObject({
      recheckDueAt: expect.any(Number),
      recheckReason: 'its connection to linear now acts as another identity',
    });
  });

  it('revokes at Linear the shared token issued while the connection was being revoked, which Day0 keeps nowhere', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds, connectionId } = await seed(harness, { mode: 'shared' });
    const { internal } = await liveApi();
    const issued: string[] = [];
    const actions = await import('../../convex/linearIdentityActions');
    actions.__setLinearIdentityDepsForTest({
      now: () => clock,
      fetch: async (url, init) => {
        const answer = await linear.fetch(url, init);
        if (url.href === 'https://api.linear.app/oauth/token') {
          const body = (await answer.clone().json()) as { access_token?: string };
          if (body.access_token !== undefined) issued.push(body.access_token);
          // An administrator revokes the connection while Linear issues the token.
          await harness.mutation(internal.organisationConnections.revokeFromSetup, {
            organisationConnectionId: connectionId,
            reason: 'IT is moving workspaces',
          });
        }
        return answer;
      },
    });

    await expect(connect(harness, surfaceIds[0]!)).resolves.toMatchObject({ ok: false });

    expect(issued).toHaveLength(1);
    expect(linear.live(issued[0]!)).toBe(false);
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

  it('lands the shared token as the OAuth token it is, and still signs every write as the employee (join 14)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    await connect(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);
    expect(surface).toMatchObject({ credentialKind: 'oauth', actsAs: { kind: 'shared-app' } });
    const parsedComment = parseSurfaceAction({
      tool: 'mcp.call',
      args: {
        surface: 'linear',
        tool: 'save_comment',
        toolArgsJson: JSON.stringify({ issueId: 'FIN-3', body: 'Reconciled.' }),
      },
    });
    if (!parsedComment.ok) throw new Error(parsedComment.reason);
    const record = toSurfaceRecord(surface);
    expect(
      applyProvenance(
        parsedComment.action,
        record,
        { agentName: 'Leo', workItemId: 'wi_1', runId: 'run_1' },
        record.credentialKind ?? 'value',
      ),
    ).toMatchObject({
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

    await expect(connect(harness, surfaceIds[0]!)).resolves.toEqual({
      ok: false,
      reason: 'linear-refused',
      message: "The organisation's Linear connection has no client-credentials scope set.",
    });

    expect(tokenRequests()).toEqual([]);
    const { surface } = await read(harness, surfaceIds[0]!);
    expect(surface.credentialId).toBeUndefined();
    expect(surface.organisationConnectionId).toBeUndefined();
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

  it("revokes at Linear the value a renewal in place replaced, so the connection's revoke ends every value it held (the round review's m5)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    await connect(harness, surfaceIds[0]!);
    const tokenId = (await read(harness, surfaceIds[0]!)).connection.sharedTokenCredentialId!;
    const first = await bearerOf(harness, tokenId);

    clock += 29.5 * DAY;
    const renewed = await bearerOf(harness, tokenId);

    expect(renewed).not.toBe(first);
    expect(linear.live(renewed)).toBe(true);
    expect(linear.live(first)).toBe(false);
  });

  it("revokes at Linear the token a renewal that lost the race requested, keeping the winner's live (the round review's m5)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    await connect(harness, surfaceIds[0]!);
    const tokenId = (await read(harness, surfaceIds[0]!)).connection.sharedTokenCredentialId!;
    const first = await bearerOf(harness, tokenId);

    clock += 29.5 * DAY;
    const [one, two] = await Promise.all([bearerOf(harness, tokenId), bearerOf(harness, tokenId)]);

    expect(tokenRequests()).toHaveLength(3);
    expect(one).toBe(two);
    expect(linear.live(one)).toBe(true);
    expect(linear.live(first)).toBe(false);
    // The first value and the loser's token: every token Day0 does not hold is ended at Linear.
    expect(linear.requests.filter((request) => request.path === '/oauth/revoke')).toHaveLength(2);
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

  it('empties the shared token in place when IT rotates the app’s secret, so the next read never meets the 401 (join 3)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds, connectionId } = await seed(harness, { mode: 'shared' });
    const { api } = await liveApi();
    await connect(harness, surfaceIds[0]!);
    const tokenId = (await read(harness, surfaceIds[0]!)).connection.sharedTokenCredentialId!;
    expect(linear.live(await bearerOf(harness, tokenId))).toBe(true);

    // IT rotates the secret in Linear, which ends every app-actor token issued with the old one
    // (L2), then records the new secret on the organisation page.
    const rotatedSecret = 'shared-client-secret-rotated';
    const rotated = fakeLinear(
      [
        {
          clientId: SHARED_CLIENT,
          clientSecret: rotatedSecret,
          clientCredentials: true,
          appUser: { id: 'app-user-day0-shared', name: 'Day0' },
          redirectUris: [REDIRECT],
        },
      ],
      () => clock,
    );
    const actions = await import('../../convex/linearIdentityActions');
    actions.__setLinearIdentityDepsForTest({ fetch: rotated.fetch, now: () => clock });
    await harness
      .withIdentity(managerIdentity('ines', { email: ADMINISTRATOR }))
      .action(api.organisationConnections.rotate, {
        organisationConnectionId: connectionId,
        secret: rotatedSecret,
      });

    const emptied = (await read(harness, surfaceIds[0]!)).credentials.find(
      (row) => row._id === tokenId,
    );
    expect(emptied).toMatchObject({ _id: tokenId });
    expect(emptied?.ciphertext).toBeUndefined();
    expect(emptied?.revokedAt).toBeUndefined();

    expect(rotated.live(await bearerOf(harness, tokenId))).toBe(true);
    expect(rotated.requests.filter((request) => request.path === '/oauth/token')).toHaveLength(1);
    const { surface, connection, credentials } = await read(harness, surfaceIds[0]!);
    expect(connection.sharedTokenCredentialId).toBe(tokenId);
    expect(surface.credentialId).toBe(tokenId);
    expect(credentials.find((row) => row._id === tokenId)?.generation).toBe(2);
  });

  it('refuses to land a token a renewal requested before the rotation emptied the shared row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds, connectionId } = await seed(harness, { mode: 'shared' });
    const { api, internal } = await liveApi();
    await connect(harness, surfaceIds[0]!);
    const before = (await read(harness, surfaceIds[0]!)).connection;
    const tokenId = before.sharedTokenCredentialId!;
    await harness
      .withIdentity(managerIdentity('ines', { email: ADMINISTRATOR }))
      .action(api.organisationConnections.rotate, {
        organisationConnectionId: connectionId,
        secret: 'shared-client-secret-rotated',
      });

    const late = await harness.mutation(internal.linearIdentity.landSharedToken, {
      organisationConnectionId: connectionId,
      sealed: sealForOwner(
        'lin_oauth_shared_minted_before',
        { current: credentialKey },
        ORGANISATION_OWNER_KEY,
      ),
      expectedGeneration: 0,
      secretCredentialId: before.secretCredentialId!,
      now: clock,
    });

    expect(late).toEqual({ ok: false, reason: 'stale', credentialId: tokenId });
    // A renewal that read the emptied row with the secret a second rotation has since replaced.
    const afterSecondRotation = await harness.mutation(internal.linearIdentity.landSharedToken, {
      organisationConnectionId: connectionId,
      sealed: sealForOwner(
        'lin_oauth_shared_minted_with_the_old_secret',
        { current: credentialKey },
        ORGANISATION_OWNER_KEY,
      ),
      secretCredentialId: before.secretCredentialId!,
      now: clock,
    });
    expect(afterSecondRotation).toEqual({ ok: false, reason: 'stale', credentialId: tokenId });
    const row = (await read(harness, surfaceIds[0]!)).credentials.find(
      (one) => one._id === tokenId,
    );
    expect(row?.ciphertext).toBeUndefined();
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

    await expect(connect(harness, surfaceIds[0]!)).resolves.toMatchObject({
      ok: false,
      reason: 'linear-refused',
      message: expect.stringContaining('Client does not support the client_credentials grant type'),
    });
    const { surface } = await read(harness, surfaceIds[0]!);
    expect(surface.credentialId).toBeUndefined();
    expect(surface.organisationConnectionId).toBeUndefined();
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

describe('one bearer read for every rung, the probe and intake (join 5)', (): void => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  /** The bearer every rung, the probe and intake send: the store's one read. */
  async function rungBearer(
    harness: TestConvex<typeof schema>,
    credentialId: Id<'credentials'>,
  ): Promise<string> {
    const { internal } = await liveApi();
    return await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
  }

  it('refreshes an employee’s own token that is due, through the native store', async (): Promise<void> => {
    // Scheduled refreshes stay queued: the fixture clock runs ahead of the real one, and a queued
    // refresh would otherwise fire at once and renew the token before the read under test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);

    clock += DAY + 60_000;
    const bearer = await rungBearer(harness, surface.credentialId!);

    expect(linear.live(bearer)).toBe(true);
    expect(tokenRequests().map((request) => request.grant)).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    const { credentials, scheduled } = await read(harness, surfaceIds[0]!);
    expect(credentials.find((row) => row._id === surface.credentialId)).toMatchObject({
      generation: 1,
      issuedBy: { grant: 'token-rotation' },
    });
    // The rotation queues Linear's own scheduled refresh, never the MCP client's.
    expect(scheduled.map((job) => job.name)).not.toContain('mcpOauthActions:refreshScheduled');
  });

  it('ends with Linear’s own words when Linear refuses the refresh of an expired token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);
    linear.revokeAppTokens(LEO_CLIENT);

    clock += DAY + 60_000;

    await expect(throughTimers(rungBearer(harness, surface.credentialId!))).rejects.toThrow(
      /Linear refused to renew the token: .*Refresh token revoked.*Day0 is unauthorised in Linear until a Linear administrator installs the app again from the card\./,
    );
  });

  it('renews the shared app-actor token in its last day through its issuer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    await connect(harness, surfaceIds[0]!);
    const tokenId = (await read(harness, surfaceIds[0]!)).connection.sharedTokenCredentialId!;
    const first = await rungBearer(harness, tokenId);

    clock += 29.5 * DAY;
    const renewed = await rungBearer(harness, tokenId);

    expect(renewed).not.toBe(first);
    expect(linear.live(renewed)).toBe(true);
    expect(tokenRequests().map((request) => request.grant)).toEqual([
      'client_credentials',
      'client_credentials',
    ]);
  });
});

describe('an employee acts at the vendor only as the identity its card names (cross-unit test 1, backend half)', (): void => {
  /** The bearer every rung sends for a card: the runtime's one read. */
  async function rungBearer(
    harness: TestConvex<typeof schema>,
    credentialId: Id<'credentials'>,
  ): Promise<string> {
    const { internal } = await liveApi();
    return await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
  }

  it('own-app: the bearer acts at Linear as the employee’s own app user, the one the card names', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);
    expect(surface.actsAs?.kind).toBe('own-app');

    const viewer = await readLinearViewer(
      linear.fetch,
      await rungBearer(harness, surface.credentialId!),
    );

    // The literal Leo's app was created with, never what the landing wrote from the same answer: a
    // shared token landed on this card would name the shared app user in both (the review's M11 b).
    expect(viewer).toMatchObject({ id: 'app-user-day0-leo', app: true });
    expect(surface.actsAs).toMatchObject({
      kind: 'own-app',
      providerIdentityId: 'app-user-day0-leo',
    });
  });

  it('shared-app: the bearer acts at Linear as the organisation’s shared app user, the one the card names', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    await connect(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);
    expect(surface.actsAs?.kind).toBe('shared-app');

    const viewer = await readLinearViewer(
      linear.fetch,
      await rungBearer(harness, surface.credentialId!),
    );

    expect(viewer).toMatchObject({ id: 'app-user-day0-shared', app: true });
    expect(surface.actsAs).toMatchObject({
      kind: 'shared-app',
      providerIdentityId: 'app-user-day0-shared',
    });
  });

  it('shared-key: the bearer is the key someone pasted, read as it was stored', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'shared' });
    const { internal } = await liveApi();
    const pasted = 'lin_api_pasted_0123456789';
    const credentialId = await harness.action(internal.credentials.store, {
      userId: 'owner',
      kind: 'value',
      label: 'Linear key',
      plaintext: pasted,
      source: 'entered',
    });
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceIds[0]!, {
        credentialId,
        credentialKind: 'value',
        actsAs: { kind: 'shared-key', label: 'a key someone pasted' },
      });
    });

    expect(await rungBearer(harness, credentialId)).toBe(pasted);
    expect(tokenRequests()).toEqual([]);
  });
});

describe("Linear's own bearer read for a credential its issuer did not obtain (the second pass)", (): void => {
  it('reads it through the token store, so a Nango-held row is never answered with its location', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: ORGANISATION_OWNER_KEY,
          holder: ORGANISATION_HOLDER,
          kind: 'location',
          label: 'Tracker token (Nango)',
          ...sealForOwner(
            nangoLocation({ providerConfigKey: 'tracker-cc', connectionId: 'tracker' }),
            { current: credentialKey },
            ORGANISATION_OWNER_KEY,
          ),
          source: 'entered',
          createdAt: 1,
          tokenStore: 'nango',
          issuedBy: { system: 'tracker', grant: 'client-credentials' },
        }),
    );

    await expect(bearerOf(harness, credentialId)).rejects.toThrow(
      'The nango token store is not configured on this deployment.',
    );
  });
});

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
      providerIdentityId: 'app-user-day0-leo',
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

  it("schedules the token's refresh for its last minutes, and nothing fires it sooner (the review's M11 a)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    await harness.finishInProgressScheduledFunctions();

    const refreshes = (await read(harness, surfaceIds[0]!)).scheduled.filter(
      (job) => job.name === 'linearIdentityActions:refreshScheduled',
    );
    expect(refreshes.length).toBeGreaterThan(0);
    for (const refresh of refreshes) {
      expect(refresh.state.kind).toBe('pending');
      expect(refresh.scheduledTime).toBeGreaterThan(Date.now() + 12 * 60 * 60 * 1_000);
    }
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

  it('presents the refresh token once when two reads refresh at once, under the refresh lease (R-S)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);

    clock += DAY + 60_000;
    // On the real timer: the second refresh sleeps on the first's lease between its reads.
    vi.useRealTimers();
    const [one, two] = await Promise.all([
      bearerOf(harness, surface.credentialId!),
      bearerOf(harness, surface.credentialId!),
    ]);

    expect(tokenRequests().map((request) => request.grant)).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(one).toBe(two);
    expect(linear.live(one)).toBe(true);
  });

  it('ends the card with the reason when Linear refuses the refresh of an expired token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const { surface } = await read(harness, surfaceIds[0]!);
    linear.revokeAppTokens(LEO_CLIENT);

    clock += DAY + 60_000;

    await expect(throughTimers(bearerOf(harness, surface.credentialId!))).rejects.toThrow(
      /Linear refused to renew the token: .*Refresh token revoked.*Day0 is unauthorised in Linear until a Linear administrator installs the app again from the card\./,
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

    await throughTimers(
      harness.action(internal.linearIdentityActions.refreshScheduled, {
        credentialId: access._id,
        generation: 0,
      }),
    );

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

  it("checks the card at once when a scheduled refresh is refused, so a revoke in Linear's settings ends it now, not at the token's expiry (R41V-9)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const { internal } = await liveApi();
    await installLeo(harness, surfaceIds[0]!);
    const { surface, credentials } = await read(harness, surfaceIds[0]!);
    const access = credentials.find((row) => row._id === surface.credentialId)!;
    // A Linear administrator's "Revoke access" ends both tokens of the pair at once.
    linear.revokeAppTokens(LEO_CLIENT);
    const refusedAt = clock;

    await throughTimers(
      harness.action(internal.linearIdentityActions.refreshScheduled, {
        credentialId: access._id,
        generation: 0,
      }),
    );

    const after = await read(harness, surfaceIds[0]!);
    const failed = after.events.at(-1);
    expect(failed?.type).toBe('surface.install-failed');
    expect((failed?.payload as { reason: string }).reason).toBe(
      'Linear refused to renew the token: Linear refused the token or code it was shown: Refresh ' +
        'token revoked. Day0 is unauthorised in Linear until a Linear administrator installs the ' +
        'app again from the card.',
    );
    const probes = after.scheduled.filter((job) => job.name === 'surfaceActions:probeInternal');
    expect(probes.some((job) => job.scheduledTime <= refusedAt)).toBe(true);
    // The probe that ends the card meets Linear's 401 and asks once for a new token: refused, in
    // the install-again words, as an authority withdrawn, never an unreadable answer.
    await expect(
      throughTimers(
        harness.action(internal.linearIdentityActions.renewAfterRefusal, {
          credentialId: access._id,
          generation: 0,
        }),
      ),
    ).rejects.toThrow(/Refresh token revoked\..*installs the app again from the card\./);
  });

  it('leaves the skills alone when a connected card installs the same app again (no move, R41V-7)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const skillId = await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceIds[0]!, { verdict: 'connected', credentialLanded: true });
      return await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Comment and close',
        body: '# Procedure',
        sourceType: 'agent-authored',
        state: 'registered',
        targetSurface: 'linear',
        registeredAt: 3,
        createdAt: 3,
      });
    });

    await expect(installLeo(harness, surfaceIds[0]!)).resolves.toMatchObject({ ok: true });

    const skill = await harness.run(async (ctx) => await ctx.db.get(skillId));
    expect(skill?.recheckReason).toBeUndefined();
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

  it("walks the access request to the installed app: its link names the card IT records the app for on the organisation page (the wave 11 review's M4)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const { api } = await liveApi();

    const request = await harness
      .withIdentity(managerIdentity())
      .query(api.accessRequests.forCard, { surfaceId: surfaceIds[0]! });
    expect(request?.reason).toBe('install-needed');
    expect(request?.text).not.toContain('./setup.sh');
    const link = /(https:\/\/\S+\/organisation\?card=[^\s;]+)/.exec(request?.text ?? '')?.[1];
    expect(link).toBeDefined();
    const opened = new URL(link!);
    expect(opened.origin).toBe(PUBLIC_URL);
    const cardId = opened.searchParams.get('card') as Id<'surfaces'>;
    expect(cardId).toBe(surfaceIds[0]);

    // The organisation page records the app for the card its link names, as `registerEmployeeApp`.
    await expect(installLeo(harness, cardId)).resolves.toEqual({
      ok: true,
      agentId,
      surfaceSlug: 'linear',
    });
    expect((await read(harness, surfaceIds[0]!)).surface.actsAs).toMatchObject({
      kind: 'own-app',
      label: 'Day0 Leo',
    });
  });

  it("never writes the app's client secret into a refused exchange's words, even when Linear echoes it (the review's m13)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const actions = await import('../../convex/linearIdentityActions');
    actions.__setLinearIdentityDepsForTest({
      fetch: async (url: URL, init: RequestInit): Promise<Response> =>
        url.pathname === '/oauth/token'
          ? Response.json(
              { error: 'invalid_client', error_description: `client ${LEO_SECRET} refused` },
              { status: 401 },
            )
          : await linear.fetch(url, init),
      now: () => clock,
    });

    const outcome = await installLeo(harness, surfaceIds[0]!);

    expect(outcome.ok).toBe(false);
    const { events } = await read(harness, surfaceIds[0]!);
    expect(JSON.stringify(events)).not.toContain(LEO_SECRET);
    expect(JSON.stringify(outcome)).not.toContain(LEO_SECRET);
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

  it('ends a replaced pair at Linear through the end of access: held, and its revocation scheduled (join 4)', async (): Promise<void> => {
    // The scheduled revocation reaches Linear through the deployment's own fetch: the fake's.
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await linear.fetch(new URL(String(input)), init ?? {}),
    );
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    await installLeo(harness, surfaceIds[0]!);
    const first = (await read(harness, surfaceIds[0]!)).surface.credentialId!;
    const { api } = await liveApi();

    const started = await connect(harness, surfaceIds[0]!);
    if (!started.ok || !('authoriseUrl' in started)) throw new Error('no installation started');
    const back = linear.consent(started.authoriseUrl);
    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, {
        state: back.searchParams.get('state') ?? '',
        code: back.searchParams.get('code') ?? '',
      }),
    ).resolves.toMatchObject({ ok: true });

    const { surface, credentials, scheduled } = await read(harness, surfaceIds[0]!);
    expect(surface.credentialId).not.toBe(first);
    const replaced = credentials.find((row) => row._id === first);
    expect(replaced).toMatchObject({
      revokedAt: clock,
      sourceRevocation: { state: 'pending', attempts: 0, end: 'disconnect' },
    });
    expect(replaced?.ciphertext).toEqual(expect.any(String));
    const attempts = scheduled.filter((job) => job.name === 'sourceRevocationActions:attempt');
    expect(attempts.map((job) => (job.args[0] as { credentialId: string }).credentialId)).toEqual([
      first,
    ]);
    await vi.waitFor(async (): Promise<void> => {
      const { events } = await read(harness, surfaceIds[0]!);
      expect(
        events
          .filter((event) => event.type === 'credential.revoked-at-source')
          .map((event) => event.payload),
      ).toEqual([expect.objectContaining({ credentialId: first, outcome: 'token-revoked' })]);
    });
  });

  it('installs again from one Connect on a card Linear refused to renew, ending the refused pair as a Disconnect does (R41X-4)', async (): Promise<void> => {
    // The refused pair's revocation reaches Linear through the deployment's own fetch: the fake's.
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await linear.fetch(new URL(String(input)), init ?? {}),
    );
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const { api } = await liveApi();
    const surfaceId = surfaceIds[0]!;
    await installLeo(harness, surfaceId);
    const refused = (await read(harness, surfaceId)).surface;
    // A Linear administrator's "Revoke access" in Linear's settings, then the card as its check
    // leaves it (`recordProbeFailure`): not granted, still holding the refused pair.
    linear.revokeAppTokens(LEO_CLIENT);
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(surfaceId, {
          verdict: 'ungranted',
          reason: 'Linear refused to renew the token: Refresh token revoked.',
          credentialLanded: false,
        }),
    );

    const started = await connect(harness, surfaceId);
    if (!started.ok || !('authoriseUrl' in started)) throw new Error('no installation started');
    const back = linear.consent(started.authoriseUrl);
    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, {
        state: back.searchParams.get('state') ?? '',
        code: back.searchParams.get('code') ?? '',
      }),
    ).resolves.toMatchObject({ ok: true });

    const { surface, credentials } = await read(harness, surfaceId);
    expect(surface.credentialId).not.toBe(refused.credentialId);
    expect(credentials.find((row) => row._id === refused.credentialId)).toMatchObject({
      revokedAt: clock,
      sourceRevocation: { end: 'disconnect' },
    });
    await vi.waitFor(async (): Promise<void> => {
      const { events } = await read(harness, surfaceId);
      expect(
        events
          .filter((event) => event.type === 'credential.revoked-at-source')
          .map((event) => event.payload),
      ).toEqual([
        expect.objectContaining({
          credentialId: refused.credentialId,
          end: 'disconnect',
          outcome: 'already-gone',
        }),
      ]);
    });
  });

  it('renews an expired card by re-authorising its own app through the issuer, with a fresh link (join 6)', async (): Promise<void> => {
    // The expiry's revocation reaches Linear through the deployment's own fetch: the fake's.
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await linear.fetch(new URL(String(input)), init ?? {}),
    );
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const { api, internal } = await liveApi();
    await installLeo(harness, surfaceIds[0]!);
    const surfaceId = surfaceIds[0]!;
    await harness.run(async (ctx) => await ctx.db.patch(surfaceId, { expiresAt: Date.now() - 1 }));
    await harness.mutation(internal.surfaces.recordExpired, { surfaceId, now: Date.now() });
    await vi.waitFor(async (): Promise<void> => {
      const { events } = await read(harness, surfaceId);
      expect(events.map((event) => event.type)).toContain('credential.revoked-at-source');
    });

    const renewal = await harness
      .withIdentity(managerIdentity())
      .mutation(api.surfaces.setAccessDays, { surfaceId, days: 30 });
    expect(renewal).toEqual({ expiresAt: expect.any(Number), reissue: 'authorise' });

    const started = await harness
      .withIdentity(managerIdentity())
      .action(api.linearIdentityActions.startAuthorisation, { surfaceId });
    if (!started.ok) throw new Error(started.message);
    const back = linear.consent(started.authoriseUrl);
    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, {
        state: back.searchParams.get('state') ?? '',
        code: back.searchParams.get('code') ?? '',
      }),
    ).resolves.toMatchObject({ ok: true });
    const { surface } = await read(harness, surfaceId);
    expect(surface).toMatchObject({
      verdict: 'approved',
      actsAs: { kind: 'own-app', providerIdentityId: 'app-user-day0-leo' },
    });
    expect(linear.live(await bearerOf(harness, surface.credentialId!))).toBe(true);
  });

  it("keeps the installed app's secret until a newly recorded app's installation lands", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceIds } = await seed(harness, { mode: 'per-employee' });
    const { api } = await liveApi();
    await installLeo(harness, surfaceIds[0]!);
    const installed = (await read(harness, surfaceIds[0]!)).surface;
    const firstSecret = installed.provisioning!.clientSecretCredentialId;
    const recorded = await harness
      .withIdentity(managerIdentity('ines', { email: ADMINISTRATOR }))
      .action(api.linearIdentityActions.registerEmployeeApp, {
        surfaceId: surfaceIds[0]!,
        clientId: LEO_SECOND_CLIENT,
        clientSecret: LEO_SECOND_SECRET,
      });
    if (!recorded.ok) throw new Error(recorded.message);

    clock += DAY + 60_000;
    const refreshed = await bearerOf(harness, installed.credentialId!);
    expect(linear.live(refreshed)).toBe(true);

    // The recorded link lapsed in the day that passed: a fresh one for the new app.
    const fresh = await connect(harness, surfaceIds[0]!);
    if (!('authoriseUrl' in fresh)) throw new Error('no installation link');
    expect(new URL(fresh.authoriseUrl).searchParams.get('client_id')).toBe(LEO_SECOND_CLIENT);
    const back = linear.consent(fresh.authoriseUrl);
    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, {
        state: back.searchParams.get('state') ?? '',
        code: back.searchParams.get('code') ?? '',
      }),
    ).resolves.toMatchObject({ ok: true });
    const { surface, credentials } = await read(harness, surfaceIds[0]!);
    expect(surface.providerIdentityId).toBe('app-user-day0-leo-2');
    const purged = credentials.find((row) => row._id === firstSecret);
    expect(purged?.revokedAt).toEqual(expect.any(Number));
    expect(purged?.ciphertext).toBeUndefined();
  });

  it("refuses another flow's pending authorisation without consuming it", async (): Promise<void> => {
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
    // An MCP server's authorisation took the card's pending row since (11-AM's flow).
    await harness.run(async (ctx) => {
      const surface = await ctx.db.get(surfaceIds[0]!);
      await ctx.db.patch(surfaceIds[0]!, {
        pendingAuthorisation: {
          ...surface!.pendingAuthorisation!,
          issuer: 'https://auth.acme.test',
        },
      });
    });
    const back = linear.consent(registered.authoriseUrl);

    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, {
        state: back.searchParams.get('state') ?? '',
        code: back.searchParams.get('code') ?? '',
      }),
    ).resolves.toMatchObject({ ok: false });
    expect((await read(harness, surfaceIds[0]!)).surface.pendingAuthorisation).toMatchObject({
      issuer: 'https://auth.acme.test',
    });
    expect(tokenRequests()).toEqual([]);
  });

  it("records only an OAuth error code Linear could have sent, never the redirect's free text", async (): Promise<void> => {
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
    const state = new URL(registered.authoriseUrl).searchParams.get('state') ?? '';

    const result = await harness.action(api.linearIdentityActions.completeAuthorisation, {
      state,
      error: '<a href="https://evil.test">click</a>',
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'Linear did not install the app: an unrecognised error.',
    });
  });

  it('refuses a state this deployment did not sign, and one that lapsed, exchanging nothing', async (): Promise<void> => {
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
    const state = back.searchParams.get('state') ?? '';
    const code = back.searchParams.get('code') ?? '';

    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, {
        state: `${state.slice(0, -4)}AAAA`,
        code,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'That install link is not one this deployment issued.',
    });
    clock += 16 * 60_000;
    await expect(
      harness.action(api.linearIdentityActions.completeAuthorisation, { state, code }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining('expired') });
    expect(tokenRequests()).toEqual([]);
    expect((await read(harness, surfaceIds[0]!)).surface.credentialId).toBeUndefined();
  });
});

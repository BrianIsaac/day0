import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { createIssuer } from '../../fake-oidc/issuer.js';
import type { FakeIssuer } from '../../fake-oidc/issuer';
import type { OauthFetch } from '../../src/surfaces/mcp-oauth';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

const PUBLIC_URL = 'https://day0.acme.test';
const ISSUER = 'https://auth.acme.test';
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = `${PUBLIC_URL}/api/oauth/mcp`;
const CLIENT = 'day0-mcp';
const SYSTEM = 'mcp:auth.acme.test';

let server: FakeIssuer;
let clock: number;

/** A fetch that hands every request to the in-process authorisation server. */
function fetchToServer(): OauthFetch {
  return async (url: URL, init: RequestInit): Promise<Response> =>
    await server.handle(new Request(url, init));
}

async function adminState(): Promise<Record<string, unknown>> {
  return (await (await server.handle(new Request(`${ISSUER}/admin/state`))).json()) as Record<
    string,
    unknown
  >;
}

beforeEach(async (): Promise<void> => {
  useSurfaceMode('real');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  clock = 1_800_000_000_000;
  server = createIssuer({
    issuer: ISSUER,
    clients: [{ id: CLIENT, redirectUris: [REDIRECT] }],
    protectedResource: { path: '/mcp', scopes: ['read', 'write'] },
    now: () => clock,
  });
  const actions = await import('../../convex/mcpOauthActions');
  actions.__setMcpOauthDepsForTest({ fetch: fetchToServer(), now: () => clock });
});

afterEach(async (): Promise<void> => {
  const actions = await import('../../convex/mcpOauthActions');
  actions.__setMcpOauthDepsForTest(undefined);
  restoreSurfaceMode();
  vi.unstubAllEnvs();
});

interface Seeded {
  readonly agentId: Id<'agents'>;
  readonly surfaceId: Id<'surfaces'>;
  readonly connectionId?: Id<'organisationConnections'>;
}

/** An owned, approved MCP card, and the organisation's pre-registered client for its server. */
async function seed(
  harness: TestConvex<typeof schema>,
  options: { connection?: boolean; secret?: boolean } = {},
): Promise<Seeded> {
  return await harness.run(async (ctx): Promise<Seeded> => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Maya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'docs',
      displayName: 'Acme docs',
      class: 'docs',
      verdict: 'approved',
      whereFound: [],
      path: 'mcp',
      endpoint: RESOURCE,
      managerApprovedAt: 2,
      credentialLanded: false,
      createdAt: 1,
    });
    if (options.connection === false) return { agentId, surfaceId };
    const connectionId = await ctx.db.insert('organisationConnections', {
      system: SYSTEM,
      displayName: 'Acme docs MCP',
      kind: 'mcp-client',
      mode: 'per-employee',
      clientId: CLIENT,
      clientRegistration: 'pre-registered',
      scopes: [],
      registeredBy: { via: 'setup-cli', at: 1 },
      status: 'active',
      createdAt: 1,
    });
    return { agentId, surfaceId, connectionId };
  });
}

async function liveApi(): Promise<typeof import('../../convex/_generated/api')> {
  return await import('../../convex/_generated/api');
}

async function start(
  harness: TestConvex<typeof schema>,
  surfaceId: Id<'surfaces'>,
): Promise<{ ok: true; authoriseUrl: string } | { ok: false; reason: string }> {
  const { api } = await liveApi();
  return await harness
    .withIdentity(managerIdentity())
    .action(api.mcpOauthActions.startAuthorisation, { surfaceId });
}

/** Walk the person's browser through the authorisation server and return its redirect. */
async function consent(authoriseUrl: string, extra: Record<string, string> = {}): Promise<URL> {
  const url = new URL(authoriseUrl);
  url.searchParams.set('login_hint', 'priya');
  for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
  const answer = await server.handle(new Request(url));
  expect(answer.status).toBe(302);
  return new URL(answer.headers.get('location') ?? '');
}

async function complete(
  harness: TestConvex<typeof schema>,
  back: URL,
): Promise<{ ok: boolean; reason?: string; agentId?: string; surfaceSlug?: string }> {
  const { api } = await liveApi();
  const arg = (name: string): Record<string, string> => {
    const value = back.searchParams.get(name);
    return value === null ? {} : { [name]: value };
  };
  return await harness.action(api.mcpOauthActions.completeAuthorisation, {
    state: back.searchParams.get('state') ?? '',
    ...arg('code'),
    ...arg('iss'),
    ...arg('error'),
  });
}

async function read(harness: TestConvex<typeof schema>, surfaceId: Id<'surfaces'>) {
  return await harness.run(async (ctx) => ({
    surface: (await ctx.db.get(surfaceId)) as Doc<'surfaces'>,
    credentials: await ctx.db.query('credentials').collect(),
    events: await ctx.db.query('events').collect(),
    connections: await ctx.db.query('organisationConnections').collect(),
    scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
  }));
}

describe('starting an authorisation', (): void => {
  it('discovers the server, seals the verifier in the row and sends the browser with PKCE and the resource', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, connectionId } = await seed(harness);

    const started = await start(harness, surfaceId);

    if (!started.ok) throw new Error(started.reason);
    const url = new URL(started.authoriseUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('resource')).toBe(RESOURCE);
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.has('code_verifier')).toBe(false);

    const { surface, connections, credentials, scheduled } = await read(harness, surfaceId);
    expect(surface.pendingAuthorisation).toMatchObject({
      clientId: CLIENT,
      issuer: ISSUER,
      resource: RESOURCE,
      redirectUrl: REDIRECT,
      organisationConnectionId: connectionId,
      stateExpiresAt: clock + 15 * 60_000,
    });
    expect(surface.pendingAuthorisation?.verifierCiphertext).not.toContain(
      url.searchParams.get('code_challenge'),
    );
    expect(url.searchParams.get('state')).toContain(surface.pendingAuthorisation?.stateNonce);
    expect(credentials).toEqual([]);
    expect(connections[0]).toMatchObject({
      issuer: ISSUER,
      resource: RESOURCE,
      authorisationEndpoints: {
        authorisation: `${ISSUER}/authorize`,
        token: `${ISSUER}/token`,
        revocation: `${ISSUER}/revoke`,
        discoveredAt: clock,
      },
    });
    expect(scheduled.some((job) => job.name.includes('expirePendingAuthorisation'))).toBe(true);
  });

  it('refuses a card whose server has no organisation connection, and asks for nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness, { connection: false });
    expect(await start(harness, surfaceId)).toMatchObject({ ok: false, reason: 'no-connection' });
    expect((await read(harness, surfaceId)).surface.pendingAuthorisation).toBeUndefined();
  });

  it('refuses a connection registered with another authorisation server', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, connectionId } = await seed(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(connectionId as Id<'organisationConnections'>, {
        issuer: 'https://other.acme.test',
      });
    });
    expect(await start(harness, surfaceId)).toMatchObject({ ok: false, reason: 'issuer-mismatch' });
  });

  it('refuses someone who does not own the employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const { api } = await liveApi();
    await expect(
      harness
        .withIdentity(managerIdentity('someone-else'))
        .action(api.mcpOauthActions.startAuthorisation, { surfaceId }),
    ).rejects.toThrow();
    expect((await read(harness, surfaceId)).surface.pendingAuthorisation).toBeUndefined();
  });
});

describe('completing an authorisation', (): void => {
  it('exchanges the code with the verifier and the resource and lands both tokens on the card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId, connectionId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);

    const outcome = await complete(harness, await consent(started.authoriseUrl));

    expect(outcome).toEqual({ ok: true, agentId, surfaceSlug: 'docs' });
    const { surface, credentials, events, scheduled } = await read(harness, surfaceId);
    const access = credentials.find((row) => row._id === surface.credentialId);
    const refresh = credentials.find((row) => row._id === access?.refreshCredentialId);
    expect(access).toMatchObject({
      userId: 'owner',
      kind: 'oauth',
      source: 'oauth',
      generation: 0,
      expiresAt: clock + 300_000,
      issuedBy: {
        system: SYSTEM,
        grant: 'authorisation-code',
        organisationConnectionId: connectionId,
        clientId: CLIENT,
      },
    });
    expect(refresh).toMatchObject({ userId: 'owner', kind: 'oauth', source: 'oauth' });
    expect(surface).toMatchObject({
      credentialKind: 'oauth',
      credentialLanded: false,
      organisationConnectionId: connectionId,
      actsAs: { kind: 'delegated', label: MANAGER_ADDRESS },
    });
    expect(surface.pendingAuthorisation).toBeUndefined();
    expect(events.map((event) => event.type)).toContain('surface.authorised');
    expect(scheduled.map((job) => job.name).join(' ')).toContain('probeInternal');
    expect(scheduled.map((job) => job.name).join(' ')).toContain('refreshScheduled');
    expect(await adminState()).toMatchObject({ codeExchanges: 1, lastResource: RESOURCE });

    // The landed access token is one the protected resource accepts as Priya's.
    const { internal } = await liveApi();
    const bearer = await harness.action(internal.mcpOauthActions.currentBearer, {
      credentialId: surface.credentialId as Id<'credentials'>,
    });
    const answer = await server.handle(
      new Request(RESOURCE, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      }),
    );
    expect(((await answer.json()) as { result: unknown }).result).toEqual({
      content: [{ type: 'text', text: 'priya@acme.test' }],
    });
    expect(JSON.stringify(surface)).not.toContain(bearer);
    expect(JSON.stringify(events)).not.toContain(bearer);
  });

  it('refuses a response whose iss differs and never sends the code to a token endpoint', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    await server.handle(
      new Request(`${ISSUER}/admin/iss?value=https://rogue.acme.test`, { method: 'POST' }),
    );

    const outcome = await complete(harness, await consent(started.authoriseUrl));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('another authorisation server');
    expect(await adminState()).toMatchObject({ codeExchanges: 0 });
    const { surface, credentials, events } = await read(harness, surfaceId);
    expect(surface.pendingAuthorisation).toBeUndefined();
    expect(surface.credentialId).toBeUndefined();
    expect(credentials).toEqual([]);
    expect(events.map((event) => event.type)).toContain('surface.authorisation-failed');
  });

  it('finds nothing to claim when the same redirect arrives again', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    const back = await consent(started.authoriseUrl);
    expect((await complete(harness, back)).ok).toBe(true);
    const replay = await complete(harness, back);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toContain('already been used');
    expect((await read(harness, surfaceId)).credentials).toHaveLength(2);
  });

  it('refuses an expired authorisation and clears it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    const back = await consent(started.authoriseUrl);
    clock += 16 * 60_000;
    const outcome = await complete(harness, back);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('expired');
    expect(await adminState()).toMatchObject({ codeExchanges: 0 });
  });

  it('clears the authorisation without an exchange when the person declines', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    const outcome = await complete(harness, await consent(started.authoriseUrl, { decline: '1' }));
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('declined') });
    expect((await read(harness, surfaceId)).surface.pendingAuthorisation).toBeUndefined();
    expect(await adminState()).toMatchObject({ codeExchanges: 0 });
  });

  it('refuses a state this deployment did not sign', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    const back = await consent(started.authoriseUrl);
    back.searchParams.set('state', `${back.searchParams.get('state') ?? ''}x`);
    expect((await complete(harness, back)).ok).toBe(false);
    expect((await read(harness, surfaceId)).surface.pendingAuthorisation).toBeDefined();
  });
});

describe('cancelling and expiring', (): void => {
  it('clears a pending authorisation on the owner’s cancel', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    await start(harness, surfaceId);
    const { api } = await liveApi();
    expect(
      await harness
        .withIdentity(managerIdentity())
        .mutation(api.mcpOauth.cancelAuthorisation, { surfaceId }),
    ).toBe(true);
    expect((await read(harness, surfaceId)).surface.pendingAuthorisation).toBeUndefined();
    await expect(
      harness
        .withIdentity(managerIdentity('someone-else'))
        .mutation(api.mcpOauth.cancelAuthorisation, { surfaceId }),
    ).rejects.toThrow();
  });

  it('clears a pending authorisation at its expiry, and leaves a newer one alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    await start(harness, surfaceId);
    const first = (await read(harness, surfaceId)).surface.pendingAuthorisation;
    const { internal } = await liveApi();
    await start(harness, surfaceId);
    await harness.mutation(internal.mcpOauth.expirePendingAuthorisation, {
      surfaceId,
      stateNonce: first?.stateNonce ?? '',
    });
    const second = (await read(harness, surfaceId)).surface.pendingAuthorisation;
    expect(second?.stateNonce).not.toBe(first?.stateNonce);
    await harness.mutation(internal.mcpOauth.expirePendingAuthorisation, {
      surfaceId,
      stateNonce: second?.stateNonce ?? '',
    });
    expect((await read(harness, surfaceId)).surface.pendingAuthorisation).toBeUndefined();
  });
});

describe('refreshing with rotation', (): void => {
  async function landed(harness: TestConvex<typeof schema>): Promise<Id<'credentials'>> {
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    expect((await complete(harness, await consent(started.authoriseUrl))).ok).toBe(true);
    return (await read(harness, surfaceId)).surface.credentialId as Id<'credentials'>;
  }

  it('hands back the stored token while it is fresh, and refreshes it when it is due', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const { internal } = await liveApi();
    const first = await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
    expect(await harness.action(internal.mcpOauthActions.currentBearer, { credentialId })).toBe(
      first,
    );
    expect(await adminState()).toMatchObject({ refreshExchanges: 0 });

    clock += 290_000;
    const second = await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
    expect(second).not.toBe(first);
    expect(await adminState()).toMatchObject({ refreshExchanges: 1 });
    const row = await harness.run(async (ctx) => await ctx.db.get(credentialId));
    expect(row).toMatchObject({
      generation: 1,
      expiresAt: clock + 300_000,
      issuedBy: { grant: 'token-rotation' },
    });
  });

  it('writes a rotated pair atomically and refuses a stale generation', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const before = await harness.run(async (ctx) => {
      const access = await ctx.db.get(credentialId);
      return {
        access,
        refresh: await ctx.db.get(access?.refreshCredentialId as Id<'credentials'>),
      };
    });
    const { internal } = await liveApi();
    clock += 290_000;
    await harness.action(internal.mcpOauthActions.refreshScheduled, {
      credentialId,
      generation: 0,
    });
    const after = await harness.run(async (ctx) => {
      const access = await ctx.db.get(credentialId);
      return {
        access,
        refresh: await ctx.db.get(access?.refreshCredentialId as Id<'credentials'>),
      };
    });
    expect(after.access?.generation).toBe(1);
    expect(after.access?.ciphertext).not.toBe(before.access?.ciphertext);
    expect(after.refresh?.ciphertext).not.toBe(before.refresh?.ciphertext);
    expect(after.refresh?._id).toBe(before.refresh?._id);

    // A concurrent refresh that read generation 0 loses: nothing it carries is written.
    const stale = await harness.mutation(internal.mcpOauth.rotateTokens, {
      credentialId,
      expectedGeneration: 0,
      access: { ciphertext: 'stale', iv: 'stale', keyId: 'stale' },
      refresh: { ciphertext: 'stale', iv: 'stale', keyId: 'stale' },
      now: clock,
    });
    expect(stale).toEqual({ ok: false, reason: 'stale' });
    const unchanged = await harness.run(async (ctx) => await ctx.db.get(credentialId));
    expect(unchanged?.ciphertext).toBe(after.access?.ciphertext);
  });

  it('gives two concurrent reads the same refreshed token', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const { internal } = await liveApi();
    clock += 290_000;
    const [one, two] = await Promise.all([
      harness.action(internal.mcpOauthActions.currentBearer, { credentialId }),
      harness.action(internal.mcpOauthActions.currentBearer, { credentialId }),
    ]);
    expect(one).toBe(two);
    const row = await harness.run(async (ctx) => await ctx.db.get(credentialId));
    expect(row?.generation).toBe(1);
  });

  it('records on the card’s record when the server refuses the refresh', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    await server.handle(new Request(`${ISSUER}/admin/revoke?person=priya`, { method: 'POST' }));
    const { internal } = await liveApi();
    clock += 290_000;
    await harness.action(internal.mcpOauthActions.refreshScheduled, {
      credentialId,
      generation: 0,
    });
    const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    const failed = events.find((event) => event.type === 'surface.authorisation-failed');
    expect(failed?.payload.reason).toContain('invalid_grant');
    const row = await harness.run(async (ctx) => await ctx.db.get(credentialId));
    expect(row?.generation).toBe(0);
  });
});

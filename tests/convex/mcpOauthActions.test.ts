import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { createIssuer } from '../../fake-oidc/issuer.js';
import type { FakeIssuer } from '../../fake-oidc/issuer';
import type { OauthFetch } from '../../src/surfaces/mcp-oauth';
import { mcpConnectionSystem } from '../../src/surfaces/access-kit';
import { nangoLocation } from '../../src/surfaces/nango-token-store';
import { sealForOwner } from '../../src/lib/credential-crypto';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { throughTimers } from './fakes/fake-clock';
import { vendorTransport } from './fakes/vendor-revocation';
import { privateHostAllowlist } from '../../src/lib/private-hosts';

const PUBLIC_URL = 'https://day0.acme.test';
const ISSUER = 'https://auth.acme.test';
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = `${PUBLIC_URL}/api/oauth/mcp`;
const CLIENT = 'day0-mcp';
const SYSTEM = 'mcp:auth.acme.test';
const CONFIDENTIAL = 'day0-mcp-confidential';
const CLIENT_SECRET = 'mcp-client-secret';

let server: FakeIssuer;
let clock: number;
let credentialKey: string;

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
  credentialKey = randomBytes(32).toString('base64');
  vi.stubEnv('DAY0_CREDENTIAL_KEY', credentialKey);
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  // The clock starts at the real one under fake timers (the wave 11 review's M11 a): a clock ahead
  // of it put every scheduled refresh past the timer's range, so each fired at once, in a loop.
  vi.useFakeTimers();
  clock = Date.now();
  server = createIssuer({
    issuer: ISSUER,
    clients: [
      { id: CLIENT, redirectUris: [REDIRECT] },
      { id: CONFIDENTIAL, secret: CLIENT_SECRET, redirectUris: [REDIRECT] },
    ],
    protectedResource: { path: '/mcp', scopes: ['read', 'write'] },
    now: () => clock,
  });
  const actions = await import('../../convex/mcpOauthActions');
  actions.__setMcpOauthDepsForTest({ fetch: fetchToServer(), now: () => clock });
});

afterEach(async (): Promise<void> => {
  vi.useRealTimers();
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
  options: { connection?: boolean; confidential?: { issuer?: string } } = {},
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
    const secretCredentialId = options.confidential
      ? await ctx.db.insert('credentials', {
          userId: ORGANISATION_OWNER_KEY,
          holder: ORGANISATION_HOLDER,
          kind: 'value',
          label: 'Acme docs MCP client secret',
          ...sealForOwner(CLIENT_SECRET, { current: credentialKey }, ORGANISATION_OWNER_KEY),
          source: 'entered',
          createdAt: 1,
        })
      : undefined;
    const connectionId = await ctx.db.insert('organisationConnections', {
      system: SYSTEM,
      displayName: 'Acme docs MCP',
      kind: 'mcp-client',
      mode: 'per-employee',
      clientId: options.confidential ? CONFIDENTIAL : CLIENT,
      clientRegistration: 'pre-registered',
      scopes: [],
      registeredBy: { via: 'setup-cli', at: 1 },
      status: 'active',
      createdAt: 1,
      ...(secretCredentialId ? { secretCredentialId } : {}),
      ...(options.confidential?.issuer ? { issuer: options.confidential.issuer } : {}),
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
): Promise<{ ok: true; authoriseUrl: string } | { ok: false; reason: string; message: string }> {
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

/**
 * Hand the redirect to the deployment as the route does, signed in as the card's manager unless the
 * test names another caller, or none.
 */
async function complete(
  harness: TestConvex<typeof schema>,
  back: URL,
  as: ReturnType<typeof managerIdentity> | 'nobody' = managerIdentity(),
): Promise<{ ok: boolean; reason?: string; agentId?: string; surfaceSlug?: string }> {
  const { api } = await liveApi();
  const arg = (name: string): Record<string, string> => {
    const value = back.searchParams.get(name);
    return value === null ? {} : { [name]: value };
  };
  const caller = as === 'nobody' ? harness : harness.withIdentity(as);
  return await caller.action(api.mcpOauthActions.completeAuthorisation, {
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

  it('finds the connection the setup verb landed for a server on a non-default port, keyed as the card keys it', async (): Promise<void> => {
    const ported = 'https://auth.acme.test:8443';
    server = createIssuer({
      issuer: ported,
      clients: [{ id: CLIENT, redirectUris: [REDIRECT] }],
      protectedResource: { path: '/mcp', scopes: ['read'] },
      now: () => clock,
    });
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness, { connection: false });
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, { endpoint: `${ported}/mcp` });
    });
    const { internal } = await liveApi();
    const connectionId = await harness.action(internal.organisationConnections.landFromSetup, {
      system: mcpConnectionSystem(`${ported}/mcp`),
      displayName: 'Acme docs MCP',
      kind: 'mcp-client',
      mode: 'per-employee',
      scopes: [],
      clientId: CLIENT,
      clientRegistration: 'pre-registered',
    });

    const started = await start(harness, surfaceId);

    if (!started.ok) throw new Error(started.reason);
    expect(new URL(started.authoriseUrl).origin).toBe(ported);
    const { surface } = await read(harness, surfaceId);
    expect(surface.pendingAuthorisation).toMatchObject({
      organisationConnectionId: connectionId,
      resource: `${ported}/mcp`,
    });
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

  it('refuses a confidential client whose authorisation server was never registered', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness, { confidential: {} });
    expect(await start(harness, surfaceId)).toMatchObject({
      ok: false,
      reason: 'issuer-unregistered',
    });
    expect((await read(harness, surfaceId)).surface.pendingAuthorisation).toBeUndefined();
  });

  it('says so in a message the browser can read when the deployment has no public address', async (): Promise<void> => {
    vi.stubEnv('DAY0_PUBLIC_URL', '');
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    let refusal: unknown;
    try {
      await start(harness, surfaceId);
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { data?: unknown }).data).toContain('DAY0_PUBLIC_URL');
  });

  it('checks the address rules through the deployment’s own fetch when nothing replaces it', async (): Promise<void> => {
    const actions = await import('../../convex/mcpOauthActions');
    actions.__setMcpOauthDepsForTest(undefined);
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, connectionId } = await seed(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(surfaceId, { endpoint: 'https://10.1.2.3/mcp' });
      await ctx.db.patch(connectionId as Id<'organisationConnections'>, { system: 'mcp:10.1.2.3' });
    });
    expect(await start(harness, surfaceId)).toMatchObject({ ok: false, reason: 'address-refused' });
  });

  it('says the server could not be reached when nothing answered, not that it publishes no metadata', async (): Promise<void> => {
    const actions = await import('../../convex/mcpOauthActions');
    actions.__setMcpOauthDepsForTest({
      fetch: async (): Promise<Response> => {
        throw new Error('connect ETIMEDOUT');
      },
      now: () => clock,
    });
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    expect(await start(harness, surfaceId)).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('clips a refusal that repeats a long value to 300 characters', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, connectionId } = await seed(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(connectionId as Id<'organisationConnections'>, {
        issuer: `https://${'a'.repeat(1_000)}.test`,
      });
    });
    const refused = await start(harness, surfaceId);
    expect(refused).toMatchObject({ ok: false, reason: 'issuer-mismatch' });
    expect(refused.ok ? '' : refused.message).toHaveLength(300);
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

  it('lands a confidential client’s tokens through Basic authentication and names its secret', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness, { confidential: { issuer: ISSUER } });
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    expect((await complete(harness, await consent(started.authoriseUrl))).ok).toBe(true);
    const { surface, credentials } = await read(harness, surfaceId);
    const access = credentials.find((row) => row._id === surface.credentialId);
    const secret = credentials.find((row) => row.holder === ORGANISATION_HOLDER);
    expect(access?.issuedBy).toMatchObject({
      clientId: CONFIDENTIAL,
      clientSecretCredentialId: secret?._id,
    });
    const { internal } = await liveApi();
    clock += 290_000;
    await harness.action(internal.mcpOauthActions.currentBearer, {
      credentialId: surface.credentialId as Id<'credentials'>,
    });
    expect(await adminState()).toMatchObject({ codeExchanges: 1, refreshExchanges: 1 });
  });

  it('refuses a response without the iss its server advertises, and sends no code', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    const back = await consent(started.authoriseUrl);
    back.searchParams.delete('iss');
    const outcome = await complete(harness, back);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('did not say who answered');
    expect(await adminState()).toMatchObject({ codeExchanges: 0 });
  });

  it('reads a decline from another server as the mix-up it is, never as a decline', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    await server.handle(
      new Request(`${ISSUER}/admin/iss?value=https://rogue.acme.test`, { method: 'POST' }),
    );
    const outcome = await complete(harness, await consent(started.authoriseUrl, { decline: '1' }));
    expect(outcome.reason).toContain('another authorisation server');
    expect(outcome.reason).not.toContain('declined');
  });

  it('refuses an oversized response before it claims anything', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    const back = await consent(started.authoriseUrl);
    back.searchParams.set('code', 'x'.repeat(5_000));
    expect((await complete(harness, back)).ok).toBe(false);
    expect((await read(harness, surfaceId)).surface.pendingAuthorisation).toBeDefined();
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

  it('hands back a token still inside its life when the server cannot be reached, and refuses one past it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const { internal } = await liveApi();
    const stored = await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
    const actions = await import('../../convex/mcpOauthActions');
    actions.__setMcpOauthDepsForTest({
      fetch: async (): Promise<Response> => {
        throw new Error('connect ECONNREFUSED auth.acme.test:443');
      },
      now: () => clock,
    });
    clock += 290_000;
    expect(await harness.action(internal.mcpOauthActions.currentBearer, { credentialId })).toBe(
      stored,
    );
    clock += 20_000;
    await expect(
      harness.action(internal.mcpOauthActions.currentBearer, { credentialId }),
    ).rejects.toThrow('could not be reached');
  });

  it('exchanges only the refresh token of the generation it read, so a pair rotated since is not spent', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const { internal } = await liveApi();
    clock += 290_000;
    const rotated = await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
    const actions = await import('../../convex/mcpOauthActions');
    // A read that still holds the pair as it was before that rotation.
    actions.__setMcpOauthDepsForTest({
      fetch: fetchToServer(),
      now: () => clock,
      store: {
        ...actions.nativeMcpTokenStore,
        read: async (ctx, id) => {
          const current = await actions.nativeMcpTokenStore.read(ctx, id);
          return current && { ...current, generation: 0, expiresAt: clock + 10_000 };
        },
      },
    });
    expect(await harness.action(internal.mcpOauthActions.currentBearer, { credentialId })).toBe(
      rotated,
    );
    expect(await adminState()).toMatchObject({ refreshExchanges: 1 });
    actions.__setMcpOauthDepsForTest({ fetch: fetchToServer(), now: () => clock });
    clock += 290_000;
    await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
    expect(await adminState()).toMatchObject({ refreshExchanges: 2 });
  });

  it('revokes at the server the pair a refresh was issued when its write finds the token gone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const actions = await import('../../convex/mcpOauthActions');
    actions.__setMcpOauthDepsForTest({
      fetch: fetchToServer(),
      now: () => clock,
      store: {
        ...actions.nativeMcpTokenStore,
        rotate: async () => ({ ok: false, reason: 'gone' }),
      },
    });
    const { internal } = await liveApi();
    clock += 290_000;
    await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
    expect(await adminState()).toMatchObject({ refreshExchanges: 1, liveRefreshTokens: 0 });
  });

  it('leaves the winner’s grant alone when its own write loses as stale', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const actions = await import('../../convex/mcpOauthActions');
    actions.__setMcpOauthDepsForTest({
      fetch: fetchToServer(),
      now: () => clock,
      store: {
        ...actions.nativeMcpTokenStore,
        rotate: async () => ({ ok: false, reason: 'stale' }),
      },
    });
    const { internal } = await liveApi();
    clock += 290_000;
    await harness.action(internal.mcpOauthActions.currentBearer, { credentialId });
    expect(await adminState()).toMatchObject({ refreshExchanges: 1, liveRefreshTokens: 1 });
  });

  it('records at once a refresh that fails for a reason no retry can pass, such as its client secret revoked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness, { confidential: { issuer: ISSUER } });
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    expect((await complete(harness, await consent(started.authoriseUrl))).ok).toBe(true);
    const credentialId = (await read(harness, surfaceId)).surface.credentialId as Id<'credentials'>;
    await harness.run(async (ctx) => {
      const secret = (await ctx.db.query('credentials').collect()).find(
        (row) => row.holder === ORGANISATION_HOLDER,
      );
      await ctx.db.patch(secret?._id as Id<'credentials'>, { revokedAt: 1 });
    });
    const { internal } = await liveApi();
    clock += 290_000;
    await harness.action(internal.mcpOauthActions.refreshScheduled, {
      credentialId,
      generation: 0,
    });
    const { events, scheduled } = await harness.run(async (ctx) => ({
      events: await ctx.db.query('events').collect(),
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }));
    const failed = events.filter((event) => event.type === 'surface.authorisation-failed');
    expect(failed).toHaveLength(1);
    expect(String(failed[0].payload.reason)).not.toContain('could not be reached');
    expect(
      scheduled.some(
        (job) =>
          job.name.includes('refreshScheduled') &&
          (job.args[0] as { attempt?: number }).attempt === 1,
      ),
    ).toBe(false);
  });

  it('tries a scheduled refresh again when the server is busy, and records nothing yet', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const actions = await import('../../convex/mcpOauthActions');
    actions.__setMcpOauthDepsForTest({
      fetch: async (url, init) =>
        url.pathname === '/token'
          ? Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
          : await fetchToServer()(url, init),
      now: () => clock,
    });
    const { internal } = await liveApi();
    clock += 290_000;
    await harness.action(internal.mcpOauthActions.refreshScheduled, {
      credentialId,
      generation: 0,
    });
    const { events, scheduled } = await harness.run(async (ctx) => ({
      events: await ctx.db.query('events').collect(),
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }));
    expect(events.map((event) => event.type)).not.toContain('surface.authorisation-failed');
    expect(
      scheduled.some(
        (job) =>
          job.name.includes('refreshScheduled') &&
          (job.args[0] as { attempt?: number }).attempt === 1,
      ),
    ).toBe(true);
  });

  it('records on the card when the retries run out, and at once for a refusal no retry can pass', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await landed(harness);
    const actions = await import('../../convex/mcpOauthActions');
    actions.__setMcpOauthDepsForTest({
      fetch: async (): Promise<Response> => {
        throw new Error('connect ECONNREFUSED');
      },
      now: () => clock,
    });
    const { internal } = await liveApi();
    await harness.action(internal.mcpOauthActions.refreshScheduled, {
      credentialId,
      generation: 0,
      attempt: 5,
    });
    actions.__setMcpOauthDepsForTest({
      fetch: async (url, init) =>
        url.pathname.startsWith('/.well-known/oauth-authorization-server')
          ? Response.json({ issuer: 'https://other.acme.test' })
          : url.pathname.startsWith('/.well-known/openid-configuration')
            ? new Response(null, { status: 404 })
            : await fetchToServer()(url, init),
      now: () => clock,
    });
    await harness.action(internal.mcpOauthActions.refreshScheduled, {
      credentialId,
      generation: 0,
    });
    const { events, scheduled } = await harness.run(async (ctx) => ({
      events: await ctx.db.query('events').collect(),
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }));
    const reasons = events
      .filter((event) => event.type === 'surface.authorisation-failed')
      .map((event) => String(event.payload.reason));
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('could not be reached');
    expect(reasons[1]).toContain('another issuer');
    expect(
      scheduled.filter(
        (job) =>
          job.name.includes('refreshScheduled') &&
          job.state.kind === 'pending' &&
          (job.args[0] as { attempt?: number }).attempt !== undefined,
      ),
    ).toEqual([]);
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
    const unchanged = await harness.run(async (ctx) => {
      const access = await ctx.db.get(credentialId);
      return {
        access,
        refresh: await ctx.db.get(access?.refreshCredentialId as Id<'credentials'>),
      };
    });
    expect(unchanged.access?.ciphertext).toBe(after.access?.ciphertext);
    expect(unchanged.refresh?.ciphertext).toBe(after.refresh?.ciphertext);
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
    await throughTimers(
      harness.action(internal.mcpOauthActions.refreshScheduled, {
        credentialId,
        generation: 0,
      }),
    );
    const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    const failed = events.find((event) => event.type === 'surface.authorisation-failed');
    expect(failed?.payload.reason).toContain('invalid_grant');
    const row = await harness.run(async (ctx) => await ctx.db.get(credentialId));
    expect(row?.generation).toBe(0);
  });
});

describe('an employee acts at the vendor only as the identity its card names (cross-unit test 1, backend half)', (): void => {
  it('delegated: the bearer every rung sends acts for the manager whose address the card names', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId } = await seed(harness);
    // The manager consents in their own browser (AM6): the fake's person is the manager.
    await harness.run(async (ctx) => await ctx.db.patch(agentId, { bossEmail: 'priya@acme.test' }));
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    expect((await complete(harness, await consent(started.authoriseUrl))).ok).toBe(true);
    const { surface } = await read(harness, surfaceId);
    expect(surface.actsAs).toMatchObject({ kind: 'delegated', label: 'priya@acme.test' });
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
    const reply = (await answer.json()) as { result?: { content?: Array<{ text?: string }> } };

    expect(reply.result?.content?.[0]?.text).toBe(surface.actsAs?.label);
  });
});

describe('the scheduled refresh under the real clock (the wave 11 review’s M11 a)', (): void => {
  it("waits for the token's last minutes, and nothing fires it sooner", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    expect((await complete(harness, await consent(started.authoriseUrl))).ok).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await harness.finishInProgressScheduledFunctions();

    const refresh = (await read(harness, surfaceId)).scheduled.find(
      (job) => job.name === 'mcpOauthActions:refreshScheduled',
    );
    expect(refresh?.state.kind).toBe('pending');
    expect(refresh?.scheduledTime).toBeGreaterThan(Date.now());
    expect(await adminState()).toMatchObject({ refreshExchanges: 0 });
  });
});

describe('a confidential client whose secret IT rotates (the wave 11 review’s M9)', (): void => {
  it('refreshes a token issued under the old secret with the connection’s current one', async (): Promise<void> => {
    const confidential = { id: CONFIDENTIAL, secret: CLIENT_SECRET, redirectUris: [REDIRECT] };
    server = createIssuer({
      issuer: ISSUER,
      clients: [confidential],
      protectedResource: { path: '/mcp', scopes: ['read', 'write'] },
      now: () => clock,
    });
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId, connectionId } = await seed(harness, { confidential: { issuer: ISSUER } });
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    expect((await complete(harness, await consent(started.authoriseUrl))).ok).toBe(true);
    const { surface } = await read(harness, surfaceId);
    const { internal } = await liveApi();

    // IT gives the client a new secret at the server and on the organisation page ("No card ends").
    confidential.secret = 'mcp-client-secret-rotated';
    await harness.action(internal.organisationConnections.rotateFromSetup, {
      organisationConnectionId: connectionId as Id<'organisationConnections'>,
      secret: 'mcp-client-secret-rotated',
    });
    clock += 290_000;
    const bearer = await harness.action(internal.mcpOauthActions.currentBearer, {
      credentialId: surface.credentialId as Id<'credentials'>,
    });

    expect(bearer).toEqual(expect.any(String));
    expect(await adminState()).toMatchObject({ codeExchanges: 1, refreshExchanges: 1 });
  });
});

describe('who may complete an authorisation (the wave 11 review’s M2, decision 3 (a))', (): void => {
  it('refuses a second signed-in person’s consent, lands nothing and leaves the manager’s authorisation pending', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    const back = await consent(started.authoriseUrl);

    const outcome = await complete(harness, back, managerIdentity('ana'));

    expect(outcome).toEqual({
      ok: false,
      reason:
        "Only the employee's manager, signed in to Day0, can finish this authorisation, so nothing was connected. The manager starts it from the card.",
    });
    const after = await read(harness, surfaceId);
    expect(after.surface.credentialId).toBeUndefined();
    expect(after.surface.actsAs).toBeUndefined();
    expect(after.surface.pendingAuthorisation).toBeDefined();
    expect(after.credentials).toEqual([]);
    expect(await adminState()).toMatchObject({ liveAccessTokens: 0, liveRefreshTokens: 0 });
  });

  it('refuses a redirect that carries no signed-in caller', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);

    const outcome = await complete(harness, await consent(started.authoriseUrl), 'nobody');

    expect(outcome.ok).toBe(false);
    expect((await read(harness, surfaceId)).surface.credentialId).toBeUndefined();
  });

  it('lands the manager’s own consent on the card, labelled as the manager', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { surfaceId } = await seed(harness);
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);

    expect((await complete(harness, await consent(started.authoriseUrl))).ok).toBe(true);

    expect((await read(harness, surfaceId)).surface.actsAs).toEqual({
      kind: 'delegated',
      label: MANAGER_ADDRESS,
    });
  });
});

describe('the organisation’s revoke of a confidential client’s connection (join 8)', (): void => {
  afterEach(async (): Promise<void> => {
    vi.unstubAllGlobals();
    // The modules are reset per test: the seam is set on the instance the harness loads.
    const revocation = await import('../../convex/sourceRevocationActions');
    revocation.__setRevocationAddressingForTest(undefined);
  });

  it('revokes every card’s token at the server with the client secret it revoked in the same act', async (): Promise<void> => {
    vi.stubEnv('DAY0_ADMINISTRATORS', 'ines@acme.test');
    // The revocation meets the MCP rung's address rules (the wave 11 review's M3): the issuer's
    // host answers a public address, and the pinned transport reaches the issuer through the
    // stubbed fetch, so no socket opens.
    const revocation = await import('../../convex/sourceRevocationActions');
    revocation.__setRevocationAddressingForTest({
      resolve: async (): Promise<string[]> => ['93.184.216.34'],
      request: vendorTransport(),
      privateHosts: privateHostAllowlist(''),
    });
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await server.handle(new Request(input, init)),
    );
    const harness = convexTest(schema, allConvexModules());
    const { agentId, surfaceId, connectionId } = await seed(harness, {
      confidential: { issuer: ISSUER },
    });
    const started = await start(harness, surfaceId);
    if (!started.ok) throw new Error(started.reason);
    expect((await complete(harness, await consent(started.authoriseUrl))).ok).toBe(true);
    expect(await adminState()).toMatchObject({ liveAccessTokens: 1, liveRefreshTokens: 1 });

    const { api } = await liveApi();
    await harness
      .withIdentity(managerIdentity('ines', { email: 'ines@acme.test' }))
      .mutation(api.organisationConnections.revoke, {
        organisationConnectionId: connectionId as Id<'organisationConnections'>,
        reason: 'the server is retired',
      });

    await vi.waitFor(async (): Promise<void> => {
      const lines = await harness.run(async (ctx) =>
        (
          await ctx.db
            .query('events')
            .withIndex('by_agent_type', (index) =>
              index.eq('agentId', agentId).eq('type', 'credential.revoked-at-source'),
            )
            .collect()
        ).map((event) => event.payload),
      );
      expect(lines).toEqual([
        expect.objectContaining({ end: 'organisation-revoked', outcome: 'token-revoked' }),
      ]);
    });
    expect(await adminState()).toMatchObject({ liveAccessTokens: 0, liveRefreshTokens: 0 });
  });
});

describe('the deployment token store and Nango (11-AT)', (): void => {
  const NANGO_KEY = '3f1c2a9e-5b7d-4c8a-9e21-0a6b4d2c8f17';

  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  /** A credential whose token Nango keeps: the row seals the connection, never the token. */
  async function nangoHeld(harness: TestConvex<typeof schema>): Promise<Id<'credentials'>> {
    return await harness.run(
      async (ctx): Promise<Id<'credentials'>> =>
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
  }

  it('answers a Nango-held credential with the token Nango holds, asked of the configured Nango', async (): Promise<void> => {
    vi.stubEnv('DAY0_NANGO_URL', 'http://nango-server:3003');
    vi.stubEnv('DAY0_NANGO_SECRET_KEY', NANGO_KEY);
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: URL | string): Promise<Response> => {
      asked.push(String(input));
      return Response.json({
        credentials: {
          type: 'OAUTH2_CC',
          token: 'fake-cc-9',
          client_secret: 'secret-abcdefghij',
          expires_at: '2026-10-02T11:13:50.598Z',
        },
      });
    });
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await nangoHeld(harness);
    const { internal } = await liveApi();
    await expect(
      harness.action(internal.mcpOauthActions.currentBearer, { credentialId }),
    ).resolves.toBe('fake-cc-9');
    expect(asked).toEqual([
      'http://nango-server:3003/connections/tracker?provider_config_key=tracker-cc',
    ]);
    const row = await harness.run(async (ctx) => await ctx.db.get(credentialId));
    expect(row?.lastUsedAt).toBeTypeOf('number');
  });

  it('refuses a Nango-held credential on a deployment where Nango is not configured', async (): Promise<void> => {
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      throw new Error('no request expected');
    });
    const harness = convexTest(schema, allConvexModules());
    const credentialId = await nangoHeld(harness);
    const { internal } = await liveApi();
    await expect(
      harness.action(internal.mcpOauthActions.currentBearer, { credentialId }),
    ).rejects.toThrow('Nango is not configured on this deployment');
  });
});

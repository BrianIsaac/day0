import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createIssuer } from '../../fake-oidc/issuer.js';
import type { FakeIssuer } from '../../fake-oidc/issuer';

const ISSUER = 'https://auth.acme.test';
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = 'https://day0.acme.test/api/oauth/mcp';
const MCP_CLIENT = 'day0-mcp';

/** An issuer that is also an authorisation server for one protected MCP resource. */
function authorisationServer(options: { now?: () => number } = {}): FakeIssuer {
  return createIssuer({
    issuer: ISSUER,
    clients: [
      { id: 'day0-app', secret: 'day0-test-client-secret', redirectUris: [REDIRECT] },
      { id: MCP_CLIENT, redirectUris: [REDIRECT] },
    ],
    protectedResource: { path: '/mcp', scopes: ['read', 'write'] },
    dynamicRegistration: true,
    ...(options.now ? { now: options.now } : {}),
  });
}

async function call(
  issuer: FakeIssuer,
  path: string,
  init: RequestInit & { form?: Record<string, string> } = {},
): Promise<Response> {
  const { form, ...rest } = init;
  return await issuer.handle(
    new Request(`${ISSUER}${path}`, {
      ...rest,
      ...(form
        ? {
            method: 'POST',
            body: new URLSearchParams(form).toString(),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
          }
        : {}),
    }),
  );
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Walk one authorisation for the MCP client as `person`, returning the redirect it sends. */
async function authorise(
  issuer: FakeIssuer,
  challenge: string,
  extra: Record<string, string> = {},
): Promise<URL> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: MCP_CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-1',
    resource: RESOURCE,
    scope: 'read write',
    login_hint: 'priya',
    ...extra,
  });
  const response = await call(issuer, `/authorize?${query.toString()}`);
  expect(response.status).toBe(302);
  return new URL(response.headers.get('location') ?? '');
}

async function exchange(
  issuer: FakeIssuer,
  code: string,
  verifier: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return await call(issuer, '/token', {
    form: {
      grant_type: 'authorization_code',
      client_id: MCP_CLIENT,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
      ...extra,
    },
  });
}

async function mcp(
  issuer: FakeIssuer,
  token: string | undefined,
  body: unknown,
): Promise<Response> {
  return await call(issuer, '/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('the test issuer as an authorisation server (RFC 8414, RFC 9207)', (): void => {
  it('publishes authorisation server metadata naming itself, S256 and the iss parameter', async (): Promise<void> => {
    const issuer = authorisationServer();
    const metadata = await (await call(issuer, '/.well-known/oauth-authorization-server')).json();
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      revocation_endpoint: `${ISSUER}/revoke`,
      registration_endpoint: `${ISSUER}/register`,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none');
    const openid = await (await call(issuer, '/.well-known/openid-configuration')).json();
    expect(openid.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('puts its own issuer on the redirect, or the one an administrator set to test a mix-up', async (): Promise<void> => {
    const issuer = authorisationServer();
    expect((await authorise(issuer, pkce().challenge)).searchParams.get('iss')).toBe(ISSUER);
    await call(issuer, '/admin/iss?value=https://rogue.acme.test', { method: 'POST' });
    expect((await authorise(issuer, pkce().challenge)).searchParams.get('iss')).toBe(
      'https://rogue.acme.test',
    );
    await call(issuer, '/admin/iss?value=', { method: 'POST' });
    expect((await authorise(issuer, pkce().challenge)).searchParams.get('iss')).toBe(ISSUER);
  });

  it('sends the person back with access_denied and the issuer when they decline', async (): Promise<void> => {
    const issuer = authorisationServer();
    const back = await authorise(issuer, pkce().challenge, { decline: '1' });
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('state-1');
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('refuses a resource other than its protected one (RFC 8707 invalid_target)', async (): Promise<void> => {
    const issuer = authorisationServer();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: MCP_CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: 'https://elsewhere.acme.test/mcp',
      scope: 'read',
      login_hint: 'priya',
    });
    const refused = await call(issuer, `/authorize?${query.toString()}`);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('invalid_target');
  });

  it('exchanges a public client’s code only with the verifier and the same resource', async (): Promise<void> => {
    const issuer = authorisationServer();
    const { verifier, challenge } = pkce();
    const code = (await authorise(issuer, challenge)).searchParams.get('code') ?? '';
    const withoutResource = await call(issuer, '/token', {
      form: {
        grant_type: 'authorization_code',
        client_id: MCP_CLIENT,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
    });
    expect((await withoutResource.json()).error).toBe('invalid_target');

    const again = await authorise(issuer, challenge);
    const granted = await exchange(issuer, again.searchParams.get('code') ?? '', verifier);
    expect(granted.status).toBe(200);
    const tokens = await granted.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'read write' });
    expect(tokens.refresh_token).toEqual(expect.any(String));
    expect(tokens.id_token).toBeUndefined();
    const state = await (await call(issuer, '/admin/state')).json();
    expect(state).toMatchObject({ codeExchanges: 1, liveAccessTokens: 1, lastResource: RESOURCE });
  });

  it('rotates the refresh token and refuses the spent one', async (): Promise<void> => {
    const issuer = authorisationServer();
    const { verifier, challenge } = pkce();
    const code = (await authorise(issuer, challenge)).searchParams.get('code') ?? '';
    const first = await (await exchange(issuer, code, verifier)).json();
    const refresh = (token: string): Promise<Response> =>
      call(issuer, '/token', {
        form: {
          grant_type: 'refresh_token',
          client_id: MCP_CLIENT,
          refresh_token: token,
          resource: RESOURCE,
        },
      });
    const second = await (await refresh(first.refresh_token)).json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    expect((await (await refresh(first.refresh_token)).json()).error).toBe('invalid_grant');
    expect((await call(issuer, '/admin/state').then((r) => r.json())).refreshExchanges).toBe(1);
  });

  it('registers a public client dynamically (RFC 7591) that can then authorise', async (): Promise<void> => {
    const issuer = authorisationServer();
    const registered = await call(issuer, '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Day0',
        redirect_uris: ['https://other.acme.test/api/oauth/mcp'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registered.status).toBe(201);
    const client = await registered.json();
    expect(client.client_id).toEqual(expect.any(String));
    expect(client.client_secret).toBeUndefined();
    const back = await authorise(issuer, pkce().challenge, {
      client_id: client.client_id,
      redirect_uri: 'https://other.acme.test/api/oauth/mcp',
    });
    expect(back.searchParams.get('code')).toEqual(expect.any(String));
  });
});

describe('the test issuer’s protected MCP resource (RFC 9728)', (): void => {
  it('publishes protected resource metadata at the path-inserted and root well-known URIs', async (): Promise<void> => {
    const issuer = authorisationServer();
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      expect(await (await call(issuer, path)).json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ['read', 'write'],
        bearer_methods_supported: ['header'],
      });
    }
  });

  it('answers a request without a token with 401 and a challenge naming its metadata', async (): Promise<void> => {
    const issuer = authorisationServer();
    const refused = await mcp(issuer, undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="read write"`,
    );
  });

  it('lists and calls its tools for a token issued for it, and refuses one issued for nothing', async (): Promise<void> => {
    const issuer = authorisationServer();
    const { verifier, challenge } = pkce();
    const code = (await authorise(issuer, challenge)).searchParams.get('code') ?? '';
    const tokens = await (await exchange(issuer, code, verifier)).json();

    const initialised = await (
      await mcp(issuer, tokens.access_token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't' } },
      })
    ).json();
    expect(initialised.result.protocolVersion).toBe('2025-11-25');
    const notified = await mcp(issuer, tokens.access_token, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notified.status).toBe(202);
    const listed = await (
      await mcp(issuer, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    ).json();
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['whoami']);
    const called = await (
      await mcp(issuer, tokens.access_token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      })
    ).json();
    expect(called.result.content).toEqual([{ type: 'text', text: 'priya@acme.test' }]);

    const forged = await mcp(issuer, 'not-a-token-it-issued', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect((await (await call(issuer, '/admin/state')).json()).mcpRequests).toBe(4);
  });

  it('refuses an access token once it has expired', async (): Promise<void> => {
    let clock = 1_000_000;
    const issuer = authorisationServer({ now: () => clock });
    const { verifier, challenge } = pkce();
    const code = (await authorise(issuer, challenge)).searchParams.get('code') ?? '';
    const tokens = await (await exchange(issuer, code, verifier)).json();
    clock += (tokens.expires_in + 1) * 1000;
    const late = await mcp(issuer, tokens.access_token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(late.status).toBe(401);
  });
});

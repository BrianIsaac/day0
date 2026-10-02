import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasHostTool } from '../setup/host-tools';

const SERVER = fileURLToPath(new URL('../../fake-oidc/server.js', import.meta.url));
const MAKE_TLS = fileURLToPath(new URL('../../fake-oidc/make-tls.sh', import.meta.url));
const REDIRECT = 'http://127.0.0.1:3550/api/auth/oidc/callback';
const MCP_REDIRECT = 'http://127.0.0.1:3550/api/oauth/mcp';

let base = '';
let child: ChildProcess | undefined;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', (): void => {
      const { port } = probe.address() as AddressInfo;
      probe.close((): void => resolve(port));
    });
  });
}

beforeAll(async (): Promise<void> => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      FAKE_OIDC_ISSUER: base,
      FAKE_OIDC_PORT: String(port),
      FAKE_OIDC_REDIRECT_URIS: REDIRECT,
      FAKE_OIDC_TOKEN_SECONDS: '120',
      FAKE_OIDC_MCP_PATH: '/mcp',
      FAKE_OIDC_MCP_SCOPES: 'read write',
      FAKE_OIDC_MCP_CLIENT_ID: 'day0-mcp',
      FAKE_OIDC_MCP_REDIRECT_URIS: MCP_REDIRECT,
      FAKE_OIDC_DYNAMIC_REGISTRATION: '1',
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // The child has not bound the socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the test issuer did not start');
}, 20_000);

afterAll((): void => {
  child?.kill('SIGTERM');
});

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
}

/** Sign one person in through the authorisation endpoint and the token endpoint, with PKCE. */
async function signIn(person: string): Promise<Record<string, unknown>> {
  const verifier = randomBytes(32).toString('base64url');
  const authorise = new URL(`${base}/authorize`);
  for (const [name, value] of Object.entries({
    client_id: 'day0-app',
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid email profile offline_access',
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    login_hint: person,
  })) {
    authorise.searchParams.set(name, value);
  }
  const redirected = await fetch(authorise, { redirect: 'manual' });
  const back = new URL(redirected.headers.get('location') ?? '');
  expect(back.searchParams.get('state')).toBe('state-1');
  const tokens = await fetch(`${base}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from('day0-app:day0-test-client-secret').toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
  return (await tokens.json()) as Record<string, unknown>;
}

async function refresh(token: string): Promise<Response> {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: 'day0-app',
      client_secret: 'day0-test-client-secret',
    }),
  });
}

describe('the test issuer', (): void => {
  it('publishes discovery naming itself, its keys and its endpoints', async (): Promise<void> => {
    const discovery = (await (
      await fetch(`${base}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      issuer: base,
      jwks_uri: `${base}/jwks`,
      token_endpoint: `${base}/token`,
      end_session_endpoint: `${base}/end-session`,
      code_challenge_methods_supported: ['S256'],
    });
    const jwks = (await (await fetch(`${base}/jwks`)).json()) as { keys: Array<{ kty: string }> };
    expect(jwks.keys[0]?.kty).toBe('RSA');
  });

  it('signs its people in with PKCE: two in acme.test and one outside it, each with a short token', async (): Promise<void> => {
    const priya = await signIn('priya');
    expect(claimsOf(String(priya.id_token))).toMatchObject({
      iss: base,
      aud: 'day0-app',
      sub: 'fake-oidc|priya',
      email: 'priya@acme.test',
      email_verified: true,
      nonce: 'nonce-1',
    });
    const claims = claimsOf(String(priya.id_token));
    expect(Number(claims.exp) - Number(claims.iat)).toBe(120);
    expect(claimsOf(String((await signIn('mateo')).id_token)).email).toBe('mateo@acme.test');
    expect(claimsOf(String((await signIn('eve')).id_token)).email).toBe('eve@rival.test');
  });

  it('rotates a refresh token, refuses a spent one and every one of a revoked person', async (): Promise<void> => {
    const first = String((await signIn('priya')).refresh_token);
    const rotated = (await (await refresh(first)).json()) as Record<string, unknown>;
    expect(rotated.refresh_token).not.toBe(first);
    expect(claimsOf(String(rotated.id_token)).nonce).toBeUndefined();
    expect((await refresh(first)).status).toBe(400);
    await fetch(`${base}/admin/revoke?person=priya`, { method: 'POST' });
    const refused = await refresh(String(rotated.refresh_token));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a code exchanged with the wrong PKCE verifier, and an unregistered redirect', async (): Promise<void> => {
    const authorise = new URL(`${base}/authorize`);
    authorise.search = new URLSearchParams({
      client_id: 'day0-app',
      redirect_uri: 'https://evil.test/callback',
      response_type: 'code',
      scope: 'openid',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      login_hint: 'priya',
    }).toString();
    expect((await fetch(authorise, { redirect: 'manual' })).status).toBe(400);
  });

  it('shows a page to choose a person when no hint names one', async (): Promise<void> => {
    const authorise = new URL(`${base}/authorize`);
    authorise.search = new URLSearchParams({
      client_id: 'day0-app',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    }).toString();
    const page = await (await fetch(authorise)).text();
    expect(page).toContain('Priya Raman');
    expect(page).toContain('eve@rival.test');
  });

  it('serves the protected MCP resource and its public client when the environment names them', async (): Promise<void> => {
    const metadata = (await (
      await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ['read', 'write'],
    });
    const server = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(server.registration_endpoint).toBe(`${base}/register`);

    const verifier = randomBytes(32).toString('base64url');
    const authorise = new URL(`${base}/authorize`);
    for (const [name, value] of Object.entries({
      client_id: 'day0-mcp',
      redirect_uri: MCP_REDIRECT,
      response_type: 'code',
      scope: 'read',
      resource: `${base}/mcp`,
      state: 'state-2',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      login_hint: 'mateo',
    })) {
      authorise.searchParams.set(name, value);
    }
    const back = new URL(
      (await fetch(authorise, { redirect: 'manual' })).headers.get('location') ?? '',
    );
    expect(back.searchParams.get('iss')).toBe(base);
    const tokens = (await (
      await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: 'day0-mcp',
          code: back.searchParams.get('code') ?? '',
          redirect_uri: MCP_REDIRECT,
          code_verifier: verifier,
          resource: `${base}/mcp`,
        }),
      })
    ).json()) as Record<string, unknown>;
    const called = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${String(tokens.access_token)}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} },
      }),
    });
    expect(((await called.json()) as { result: unknown }).result).toEqual({
      content: [{ type: 'text', text: 'mateo@acme.test' }],
    });
  });

  it('ends a session and sends the browser back where it was asked to', async (): Promise<void> => {
    const ended = await fetch(
      `${base}/end-session?post_logout_redirect_uri=${encodeURIComponent('http://127.0.0.1:3550/api/auth/oidc/logout')}`,
      { redirect: 'manual' },
    );
    expect(ended.status).toBe(302);
    expect(ended.headers.get('location')).toBe('http://127.0.0.1:3550/api/auth/oidc/logout');
  });
});

describe('the test issuer’s TLS material (make-tls.sh)', (): void => {
  it.skipIf(!hasHostTool('openssl'))(
    'writes a CA and a certificate for the issuer address the CA signs (needs openssl)',
    (): void => {
      const directory = mkdtempSync(join(tmpdir(), 'day0-fake-oidc-tls-'));
      try {
        const made = spawnSync('bash', [MAKE_TLS, directory, '172.31.250.10'], {
          encoding: 'utf8',
        });
        expect(made.status, made.stderr).toBe(0);
        const text = spawnSync(
          'openssl',
          ['x509', '-in', join(directory, 'cert.pem'), '-noout', '-text'],
          {
            encoding: 'utf8',
          },
        ).stdout;
        expect(text).toContain('IP Address:172.31.250.10');
        const verified = spawnSync(
          'openssl',
          ['verify', '-CAfile', join(directory, 'ca.pem'), join(directory, 'cert.pem')],
          { encoding: 'utf8' },
        );
        expect(verified.status).toBe(0);
        expect(readFileSync(join(directory, 'bundle.pem'), 'utf8')).toContain(
          readFileSync(join(directory, 'ca.pem'), 'utf8').trim(),
        );
        expect(spawnSync('bash', [MAKE_TLS, directory, 'not-an-ip']).status).toBe(2);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

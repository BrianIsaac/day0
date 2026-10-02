import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Under the customer-local profile the proxy is the first of two locks: every
 * page and API route but the sign-in's own and the two externally called ones
 * needs a session sealed by this install. The second lock is `getCaller` on
 * the deployment (O2: the proxy is an optimistic check).
 */

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (): (() => never) => (): never => {
    throw new Error('Clerk must not run under the customer-local profile');
  },
  createRouteMatcher:
    (patterns: string[]) =>
    (request: { nextUrl: URL }): boolean =>
      patterns.some((pattern: string): boolean =>
        new RegExp(`^${pattern.replace('(.*)', '.*')}$`).test(request.nextUrl.pathname),
      ),
}));

const SECRET = 'p'.repeat(43);
const ORIGIN = 'https://day0.acme.test';

type Proxy = (request: NextRequest) => Promise<Response | undefined> | Response | undefined;

async function loadProxy(env: Record<string, string> = {}): Promise<Proxy> {
  const values: Record<string, string> = {
    NEXT_PUBLIC_DAY0_PROFILE: 'customer-local',
    DAY0_PROFILE: 'customer-local',
    DAY0_SESSION_SECRET: SECRET,
    DAY0_PUBLIC_URL: ORIGIN,
    ...env,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  vi.resetModules();
  return (await import('../proxy')).default as unknown as Proxy;
}

async function sessionCookie(expiresAt: number = Date.now() + 3_600_000): Promise<string> {
  const { sealSession } = await import('../src/lib/customer-session');
  return `day0_session=${await sealSession(SECRET, {
    version: 1,
    idToken: 'h.p.s',
    idTokenExpiresAt: Date.now() + 60_000,
    startedAt: Date.now(),
    expiresAt,
  })}`;
}

function request(path: string, cookie?: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://127.0.0.1:3550${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  });
}

beforeEach((): void => {
  vi.resetModules();
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('the customer-local proxy gate', (): void => {
  it('sends a signed-out visitor to the company sign-in, keeping the page they asked for', async (): Promise<void> => {
    const proxy = await loadProxy();
    const response = (await proxy(request('/agent/abc?tab=work'))) as Response;
    expect(response.status).toBe(307);
    // Absolute, on the public origin: Next's server refuses a relative Location from the proxy
    // (ERR_INVALID_URL, found on the customer-local bed), whatever host the request came in on.
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/api/auth/oidc/login?returnTo=%2Fagent%2Fabc%3Ftab%3Dwork`,
    );
  });

  it("redirects on the request's own origin when the public origin is not set", async (): Promise<void> => {
    const proxy = await loadProxy({ DAY0_PUBLIC_URL: '' });
    const response = (await proxy(request('/agent/abc'))) as Response;
    expect(response.headers.get('location')).toBe(
      // Next's own view of the request's origin, which writes loopback as localhost.
      'http://localhost:3550/api/auth/oidc/login?returnTo=%2Fagent%2Fabc',
    );
  });

  it('refuses a signed-out API call with 401, never a redirect', async (): Promise<void> => {
    const proxy = await loadProxy();
    const response = (await proxy(request('/api/seed', undefined, 'POST'))) as Response;
    expect(response.status).toBe(401);
  });

  it('lets a browser with a live session through to pages and API routes', async (): Promise<void> => {
    const proxy = await loadProxy();
    const cookie = await sessionCookie();
    expect(((await proxy(request('/agent/abc', cookie))) as Response).status).toBe(200);
    expect(
      ((await proxy(request('/api/voice/elevenlabs/start', cookie, 'POST'))) as Response).status,
    ).toBe(200);
  });

  it('refuses a session sealed under another secret, and one past its end', async (): Promise<void> => {
    const proxy = await loadProxy();
    const stale = await sessionCookie(Date.now() - 1);
    expect(((await proxy(request('/', stale))) as Response).status).toBe(307);
    vi.stubEnv('DAY0_SESSION_SECRET', 'q'.repeat(43));
    const rotated = await loadProxy({ DAY0_SESSION_SECRET: 'q'.repeat(43) });
    const { sealSession } = await import('../src/lib/customer-session');
    const foreign = `day0_session=${await sealSession(SECRET, {
      version: 1,
      idToken: 'h.p.s',
      idTokenExpiresAt: Date.now() + 60_000,
      startedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    })}`;
    expect(((await rotated(request('/', foreign))) as Response).status).toBe(307);
  });

  it('lets the sign-in routes and the two externally called routes through with no session', async (): Promise<void> => {
    const proxy = await loadProxy();
    for (const path of [
      '/api/auth/oidc/login',
      '/api/auth/oidc/callback?code=x&state=y',
      '/api/auth/oidc/logout',
      '/api/voice/elevenlabs/webhook',
      '/api/oauth/slack',
      '/api/oauth/linear?code=x&state=y',
    ]) {
      expect(((await proxy(request(path))) as Response).status).toBe(200);
    }
  });

  it("keeps the MCP authorisation redirect behind the session: it returns to the manager's own browser", async (): Promise<void> => {
    const proxy = await loadProxy();
    expect(((await proxy(request('/api/oauth/mcp?code=x&state=y'))) as Response).status).toBe(401);
    const cookie = await sessionCookie();
    expect(
      ((await proxy(request('/api/oauth/mcp?code=x&state=y', cookie))) as Response).status,
    ).toBe(200);
  });

  it("sends Clerk's sign-in pages to the company sign-in, never to Clerk", async (): Promise<void> => {
    const proxy = await loadProxy();
    const cookie = await sessionCookie();
    for (const path of ['/sign-in', '/sign-up/sso-callback']) {
      const response = (await proxy(request(path, cookie))) as Response;
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/api/auth/oidc/login?returnTo=%2F`);
    }
  });

  it('refuses every request when the server runs the customer profile and the build was made without it (the wave 10 review, S-m1)', async (): Promise<void> => {
    const proxy = await loadProxy({ NEXT_PUBLIC_DAY0_PROFILE: '', NEXT_PUBLIC_DEV_NO_AUTH: '' });
    const response = (await proxy(request('/', await sessionCookie()))) as Response;
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('NEXT_PUBLIC_DAY0_PROFILE=customer-local');
  });

  it('refuses every request when the server runs another profile than the build', async (): Promise<void> => {
    const proxy = await loadProxy({ DAY0_PROFILE: 'local-dev' });
    const response = (await proxy(request('/', await sessionCookie()))) as Response;
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('DAY0_PROFILE=local-dev');
  });
});

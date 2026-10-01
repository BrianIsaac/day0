import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverConvexUrl } from '../../../src/lib/convex-caller';

describe('the server-side Convex address', (): void => {
  it('prefers CONVEX_URL, the address a server process reaches the backend on', (): void => {
    expect(
      serverConvexUrl({
        CONVEX_URL: ' http://backend:3210 ',
        NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210',
      }),
    ).toBe('http://backend:3210');
  });

  it("falls back to the browser's address", (): void => {
    expect(
      serverConvexUrl({ CONVEX_URL: '', NEXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210' }),
    ).toBe('http://127.0.0.1:3210');
  });

  it('refuses when neither is set', (): void => {
    expect(() => serverConvexUrl({})).toThrow('CONVEX_URL');
  });
});

describe('the server routes under the customer-local profile', (): void => {
  const SECRET = 'c'.repeat(43);

  afterEach((): void => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock('next/headers');
    vi.resetModules();
  });

  async function establishWith(cookie: string | undefined): Promise<{
    ok: boolean;
    status?: number;
    bearer?: string | null;
  }> {
    vi.stubEnv('NEXT_PUBLIC_DAY0_PROFILE', 'customer-local');
    vi.stubEnv('DAY0_SESSION_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://customer-test.convex.cloud');
    vi.resetModules();
    vi.doMock('next/headers', () => ({
      cookies: async (): Promise<{ get: (name: string) => { value: string } | undefined }> => ({
        get: (name: string): { value: string } | undefined =>
          name === 'day0_session' && cookie ? { value: cookie } : undefined,
      }),
    }));
    vi.doMock('@clerk/nextjs/server', () => ({
      auth: (): never => {
        throw new Error('Clerk must not be asked under the customer-local profile');
      },
    }));
    let bearer: string | null = null;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      bearer = new Headers(init?.headers).get('authorization');
      return Response.json({ status: 'success', value: null, logLines: [] });
    });
    const { establishConvexCaller } = await import('../../../src/lib/convex-caller');
    const caller = await establishConvexCaller();
    if (!caller.ok) return { ok: false, status: caller.refusal.status };
    await caller.client.query('config:release' as never, {} as never);
    return { ok: true, bearer };
  }

  it("acts on Convex with the session's ID token, never asking Clerk", async (): Promise<void> => {
    const { sealSession } = await import('../../../src/lib/customer-session');
    const sealed = await sealSession(SECRET, {
      version: 1,
      idToken: 'header.claims.signature',
      idTokenExpiresAt: Date.now() + 60_000,
      startedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    await expect(establishWith(sealed)).resolves.toEqual({
      ok: true,
      bearer: 'Bearer header.claims.signature',
    });
  });

  it('refuses with 401 when the browser holds no session, or only a token past its expiry', async (): Promise<void> => {
    await expect(establishWith(undefined)).resolves.toEqual({ ok: false, status: 401 });
    const { sealSession } = await import('../../../src/lib/customer-session');
    const stale = await sealSession(SECRET, {
      version: 1,
      idToken: 'header.claims.signature',
      idTokenExpiresAt: Date.now() - 1,
      startedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    await expect(establishWith(stale)).resolves.toEqual({ ok: false, status: 401 });
  });
});

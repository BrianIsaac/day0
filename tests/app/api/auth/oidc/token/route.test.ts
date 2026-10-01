import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_URL,
  customerIssuer,
  jwtClaims,
  sessionCookieHeader,
  setCookies,
  signedIn,
} from '../customer-issuer';

const START = new Date('2026-10-02T09:00:00Z').getTime();

beforeEach((): void => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

interface TokenAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly response: Response;
}

async function token(
  cookie: string,
  options: { readonly force?: boolean; readonly origin?: string } = {},
): Promise<TokenAnswer> {
  const { POST } = await import('../../../../../../app/api/auth/oidc/token/route');
  const response = await POST(
    new NextRequest(`${PUBLIC_URL}/api/auth/oidc/token`, {
      method: 'POST',
      headers: { cookie, origin: options.origin ?? PUBLIC_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ force: options.force === true }),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    response,
  };
}

describe('the company sign-in token route', (): void => {
  it("hands the browser the session's ID token, and the account it names", async (): Promise<void> => {
    const issuer = customerIssuer({ tokenSeconds: 120 });
    const cookie = await signedIn(issuer, 'priya');
    const answer = await token(cookie);
    expect(answer.status).toBe(200);
    expect(jwtClaims(String(answer.body.token))).toMatchObject({ email: 'priya@acme.test' });
    expect(answer.body.account).toEqual({ name: 'Priya Raman', email: 'priya@acme.test' });
    expect(answer.response.headers.get('cache-control')).toBe('no-store');
  });

  it('refreshes an ID token in its last minutes and signs out on a refused refresh', async (): Promise<void> => {
    const issuer = customerIssuer({ tokenSeconds: 120 });
    const cookie = await signedIn(issuer, 'priya');
    const first = await token(cookie);

    vi.setSystemTime(START + 30_000);
    const early = await token(cookie);
    expect(early.body.token).toBe(first.body.token);
    expect(setCookies(early.response).size).toBe(0);

    vi.setSystemTime(START + 70_000);
    const late = await token(cookie);
    expect(late.status).toBe(200);
    expect(late.body.token).not.toBe(first.body.token);
    expect(jwtClaims(String(late.body.token)).exp).toBe(Math.floor((START + 70_000) / 1000) + 120);
    const refreshedCookie = sessionCookieHeader(late.response);
    expect(refreshedCookie).not.toBe('');

    await issuer.handle(
      new Request(`${issuer.issuer}/admin/revoke?person=priya`, { method: 'POST' }),
    );
    vi.setSystemTime(START + 160_000);
    const refused = await token(refreshedCookie);
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ signedOut: true });
    expect(setCookies(refused.response).get('day0_session')).toMatch(/Max-Age=0/);
  });

  it('refreshes at once when Convex asks for a fresh token', async (): Promise<void> => {
    const issuer = customerIssuer({ tokenSeconds: 120 });
    const cookie = await signedIn(issuer, 'priya');
    const first = await token(cookie);
    vi.setSystemTime(START + 5_000);
    const forced = await token(cookie, { force: true });
    expect(forced.body.token).not.toBe(first.body.token);
  });

  it('keeps the session when the issuer cannot be reached, and says so', async (): Promise<void> => {
    const issuer = customerIssuer({ tokenSeconds: 120 });
    const cookie = await signedIn(issuer, 'priya');
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    vi.setSystemTime(START + 70_000);
    const stillValid = await token(cookie);
    expect(stillValid.status).toBe(200);
    vi.setSystemTime(START + 119_000);
    const unavailable = await token(cookie);
    expect(unavailable.status).toBe(503);
    expect(setCookies(unavailable.response).size).toBe(0);
  });

  it('answers a browser with no session as signed out', async (): Promise<void> => {
    customerIssuer();
    const answer = await token('day0_session=v1.AAAAAAAAAAAAAAAA.AAAA');
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ signedOut: true });
  });

  it('refuses a request from another origin', async (): Promise<void> => {
    const issuer = customerIssuer();
    const cookie = await signedIn(issuer, 'priya');
    expect((await token(cookie, { origin: 'https://evil.test' })).status).toBe(403);
  });
});

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_URL, customerIssuer, setCookies, signedIn } from '../customer-issuer';

beforeEach((): void => {
  vi.resetModules();
});

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function signOut(cookie: string, origin = PUBLIC_URL): Promise<Response> {
  const { POST } = await import('../../../../../../app/api/auth/oidc/logout/route');
  return POST(
    new NextRequest(`${PUBLIC_URL}/api/auth/oidc/logout`, {
      method: 'POST',
      headers: { cookie, origin },
    }),
  );
}

describe('the company sign-out', (): void => {
  it("ends the session and the issuer's, through its end_session_endpoint", async (): Promise<void> => {
    const issuer = customerIssuer();
    const cookie = await signedIn(issuer, 'priya');
    const response = await signOut(cookie);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${issuer.issuer}/end-session`);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe(
      `${PUBLIC_URL}/api/auth/oidc/logout`,
    );
    expect(location.searchParams.get('id_token_hint')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(setCookies(response).get('day0_session')).toMatch(/Max-Age=0/);
  });

  it('revokes the refresh token, so a copy of the cookie taken before sign-out refreshes nothing', async (): Promise<void> => {
    const issuer = customerIssuer();
    const cookie = await signedIn(issuer, 'priya');
    await signOut(cookie);
    const { POST } = await import('../../../../../../app/api/auth/oidc/token/route');
    const copied = await POST(
      new NextRequest(`${PUBLIC_URL}/api/auth/oidc/token`, {
        method: 'POST',
        headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      }),
    );
    expect(copied.status).toBe(401);
  });

  it('ends the session on its own when the issuer names no end_session_endpoint', async (): Promise<void> => {
    const issuer = customerIssuer({ endSession: false });
    const cookie = await signedIn(issuer, 'priya');
    const response = await signOut(cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${PUBLIC_URL}/api/auth/oidc/logout`);
    expect(setCookies(response).get('day0_session')).toMatch(/Max-Age=0/);
  });

  it('refuses a sign-out another site asks for', async (): Promise<void> => {
    const issuer = customerIssuer();
    const cookie = await signedIn(issuer, 'priya');
    const response = await signOut(cookie, 'https://evil.test');
    expect(response.status).toBe(403);
    expect(setCookies(response).has('day0_session')).toBe(false);
  });

  it('says the person is signed out, with the way back in', async (): Promise<void> => {
    customerIssuer();
    const { GET } = await import('../../../../../../app/api/auth/oidc/logout/route');
    const response = GET();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('You are signed out');
    // The body does not repeat the title (the second pass's design review).
    expect(text).toContain('Your session has ended. Sign in with your work account to carry on.');
    expect(text).toContain('href="/api/auth/oidc/login?returnTo=%2F"');
  });
});

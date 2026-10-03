import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookieAttributes, fromOwnPages } from '../../../src/lib/customer-oidc-routes';
import type { CustomerSignInSettings } from '../../../src/lib/customer-oidc-server';
import { CUSTOMER_OIDC_PRESETS } from '../../../src/lib/customer-oidc-presets';
import { PUBLIC_URL, customerIssuer, signedIn } from '../../app/api/auth/oidc/customer-issuer';

const SETTINGS: CustomerSignInSettings = {
  issuer: 'https://issuer.acme.test',
  clientId: 'day0-app',
  clientSecret: 'day0-test-client-secret',
  allowedDomains: ['acme.test'],
  publicUrl: 'https://day0.acme.test',
  sessionSecret: 's'.repeat(43),
  preset: CUSTOMER_OIDC_PRESETS.oidc,
  emailTrusted: false,
};

function post(url: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(url, { method: 'POST', headers });
}

describe("a request from the app's own pages", (): void => {
  it('is one whose Origin is the public origin, or the origin it was sent to', (): void => {
    expect(
      fromOwnPages(
        post('https://day0.acme.test/x', { origin: 'https://day0.acme.test' }),
        SETTINGS,
      ),
    ).toBe(true);
    // The customer's proxy serves another name than DAY0_PUBLIC_URL: still the same origin.
    expect(
      fromOwnPages(
        post('https://day0.internal.acme.test/x', { origin: 'https://day0.internal.acme.test' }),
        SETTINGS,
      ),
    ).toBe(true);
    expect(
      fromOwnPages(post('https://day0.acme.test/x', { origin: 'https://evil.test' }), SETTINGS),
    ).toBe(false);
  });

  it('is marked same-origin by the browser when it sends no Origin', (): void => {
    expect(
      fromOwnPages(post('https://day0.acme.test/x', { 'sec-fetch-site': 'same-origin' }), SETTINGS),
    ).toBe(true);
    expect(
      fromOwnPages(post('https://day0.acme.test/x', { 'sec-fetch-site': 'cross-site' }), SETTINGS),
    ).toBe(false);
    expect(fromOwnPages(post('https://day0.acme.test/x', {}), SETTINGS)).toBe(false);
  });
});

describe('the sign-in cookies', (): void => {
  it('are httpOnly and Lax, and Secure on an https origin only', (): void => {
    expect(cookieAttributes(SETTINGS)).toEqual({ httpOnly: true, sameSite: 'lax', secure: true });
    expect(cookieAttributes({ ...SETTINGS, publicUrl: 'http://localhost:3296' }).secure).toBe(
      false,
    );
  });
});

describe('the company sign-in routes and Clerk (Q16)', (): void => {
  afterEach((): void => {
    vi.doUnmock('@clerk/nextjs/server');
    vi.resetModules();
  });

  it('load without importing Clerk, which the customer-local profile never runs', async (): Promise<void> => {
    vi.resetModules();
    vi.doMock('@clerk/nextjs/server', (): never => {
      throw new Error('Clerk was imported on the company sign-in path');
    });

    const routes = await import('../../../src/lib/customer-oidc-routes');

    expect(typeof routes.fromOwnPages).toBe('function');
  });
});

describe("a redirect's caller under the company sign-in (the pre-tag second pass; the code pass's m8)", (): void => {
  const START = new Date('2026-10-03T09:00:00Z').getTime();

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function caller(cookie: string): Promise<{
    idToken: string | null;
    setCookies: number;
  }> {
    const { redirectCaller } = await import('../../../src/lib/customer-oidc-routes');
    const { NextResponse } = await import('next/server');
    const found = await redirectCaller(
      new NextRequest(`${PUBLIC_URL}/api/oauth/mcp`, { headers: { cookie } }),
    );
    const response = NextResponse.redirect(`${PUBLIC_URL}/`);
    await found.finish(response);
    return { idToken: found.idToken, setCookies: response.headers.getSetCookie().length };
  }

  it('acts with no caller and writes nothing when the issuer cannot be reached for a lapsed token', async (): Promise<void> => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const issuer = customerIssuer({ tokenSeconds: 120 });
    const cookie = await signedIn(issuer, 'priya');
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    vi.setSystemTime(START + 300_000);

    expect(await caller(cookie)).toEqual({ idToken: null, setCookies: 0 });
  });

  it('acts with no caller where the company sign-in is not set up on this installation', async (): Promise<void> => {
    vi.resetModules();
    const issuer = customerIssuer({ tokenSeconds: 120 });
    const cookie = await signedIn(issuer, 'priya');
    vi.stubEnv('DAY0_SESSION_SECRET', '');

    expect(await caller(cookie)).toEqual({ idToken: null, setCookies: 0 });
  });
});

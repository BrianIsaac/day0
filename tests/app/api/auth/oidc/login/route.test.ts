import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  ISSUER,
  PUBLIC_URL,
  SESSION_SECRET,
  cookieValue,
  customerIssuer,
  setCookies,
} from '../customer-issuer';

beforeEach((): void => {
  vi.resetModules();
});

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function signIn(path: string): Promise<Response> {
  const { GET } = await import('../../../../../../app/api/auth/oidc/login/route');
  return GET(new NextRequest(`${PUBLIC_URL}${path}`));
}

describe('the company sign-in login route', (): void => {
  it('sends the browser to the issuer with PKCE, state and nonce, and seals them for the callback', async (): Promise<void> => {
    customerIssuer();
    const response = await signIn('/api/auth/oidc/login?returnTo=%2Fagent%2Fabc');
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${PUBLIC_URL}/api/auth/oidc/callback`,
      response_type: 'code',
      scope: 'openid profile email offline_access',
      code_challenge_method: 'S256',
    });

    const line = setCookies(response).get('day0_sign_in') ?? '';
    expect(line).toMatch(/Path=\/api\/auth\/oidc\/callback/);
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=lax/i);
    expect(line).toMatch(/Secure/);
    const { openTransaction } = await import('../../../../../../src/lib/customer-session');
    const transaction = await openTransaction(SESSION_SECRET, cookieValue(line));
    expect(transaction).toMatchObject({
      state: location.searchParams.get('state'),
      nonce: location.searchParams.get('nonce'),
      returnTo: '/agent/abc',
    });
    const { calculatePKCECodeChallenge } = await import('openid-client');
    expect(await calculatePKCECodeChallenge(transaction?.codeVerifier ?? '')).toBe(
      location.searchParams.get('code_challenge'),
    );
  });

  it('lands on the dashboard rather than on another origin a link names', async (): Promise<void> => {
    customerIssuer();
    for (const returnTo of [
      '//evil.test/x',
      'https://evil.test',
      '/\\evil.test',
      '/api/auth/oidc/login',
    ]) {
      const response = await signIn(
        `/api/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`,
      );
      const { openTransaction } = await import('../../../../../../src/lib/customer-session');
      const line = setCookies(response).get('day0_sign_in');
      expect((await openTransaction(SESSION_SECRET, cookieValue(line)))?.returnTo).toBe('/');
    }
  });

  it('asks Google for a refresh token by its own parameters, not a scope', async (): Promise<void> => {
    customerIssuer({ issuer: 'https://accounts.google.com' });
    const location = new URL((await signIn('/api/auth/oidc/login')).headers.get('location') ?? '');
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');
  });

  it('asks the issuer to let the person choose another account when the refusal page sends them back', async (): Promise<void> => {
    customerIssuer();
    const okta = new URL(
      (await signIn('/api/auth/oidc/login?switch=1')).headers.get('location') ?? '',
    );
    expect(okta.searchParams.get('prompt')).toBe('login');
    vi.resetModules();
    customerIssuer({ issuer: 'https://accounts.google.com' });
    const google = new URL(
      (await signIn('/api/auth/oidc/login?switch=1')).headers.get('location') ?? '',
    );
    expect(google.searchParams.get('prompt')).toBe('select_account consent');
    const plain = new URL((await signIn('/api/auth/oidc/login')).headers.get('location') ?? '');
    expect(plain.searchParams.get('prompt')).toBe('consent');
  });

  it('says the install is unfinished, naming no value, when a setting is missing', async (): Promise<void> => {
    customerIssuer({ env: { DAY0_OIDC_CLIENT_SECRET: '' } });
    const response = await signIn('/api/auth/oidc/login');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('pnpm check:setup');
    expect(text).not.toContain(SESSION_SECRET);
  });

  it('is not there in a build without the customer sign-in', async (): Promise<void> => {
    customerIssuer({ env: { NEXT_PUBLIC_DAY0_PROFILE: '' } });
    expect((await signIn('/api/auth/oidc/login')).status).toBe(404);
  });

  it('refuses to start when the server runs another profile than the build', async (): Promise<void> => {
    customerIssuer({ env: { DAY0_PROFILE: 'local-dev' } });
    const response = await signIn('/api/auth/oidc/login');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('DAY0_PROFILE=local-dev');
  });
});

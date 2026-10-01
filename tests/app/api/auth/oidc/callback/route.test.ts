import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeIssuer } from '../../../../../../fake-oidc/issuer.js';
import {
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

/** What the browser holds between the login route and the issuer's redirect back. */
interface Started {
  readonly transactionCookie: string;
  readonly authorisation: URL;
}

async function startSignIn(returnTo = '/'): Promise<Started> {
  const { GET } = await import('../../../../../../app/api/auth/oidc/login/route');
  const response = await GET(
    new NextRequest(`${PUBLIC_URL}/api/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`),
  );
  return {
    transactionCookie: cookieValue(setCookies(response).get('day0_sign_in')) ?? '',
    authorisation: new URL(response.headers.get('location') ?? ''),
  };
}

/** The issuer's redirect back for one person, as a browser that chose them would follow it. */
async function issuerRedirect(issuer: FakeIssuer, started: Started, person: string): Promise<URL> {
  const authorise = new URL(started.authorisation);
  authorise.searchParams.set('login_hint', person);
  const answer = await issuer.handle(new Request(authorise));
  return new URL(answer.headers.get('location') ?? '');
}

async function callback(search: string, transactionCookie?: string): Promise<Response> {
  const { GET } = await import('../../../../../../app/api/auth/oidc/callback/route');
  const headers = new Headers();
  if (transactionCookie) headers.set('cookie', `day0_sign_in=${transactionCookie}`);
  return GET(new NextRequest(`http://127.0.0.1:3550/api/auth/oidc/callback${search}`, { headers }));
}

describe('the company sign-in callback', (): void => {
  it('signs an allowed person in: a sealed session, the transaction cleared, back where they were', async (): Promise<void> => {
    const issuer = customerIssuer();
    const started = await startSignIn('/agent/abc');
    const back = await issuerRedirect(issuer, started, 'priya');
    const response = await callback(back.search, started.transactionCookie);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${PUBLIC_URL}/agent/abc`);
    const cookies = setCookies(response);
    expect(cookies.get('day0_sign_in')).toMatch(/Max-Age=0/);
    const sessionLine = cookies.get('day0_session') ?? '';
    expect(sessionLine).toMatch(/HttpOnly/);
    expect(sessionLine).toMatch(/SameSite=lax/i);
    expect(sessionLine).toMatch(/Path=\//);
    const { openSession } = await import('../../../../../../src/lib/customer-session');
    const session = await openSession(SESSION_SECRET, cookieValue(sessionLine));
    expect(session?.refreshToken).toBeTruthy();
    const claims = JSON.parse(
      Buffer.from(session?.idToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    expect(claims).toMatchObject({ email: 'priya@acme.test', aud: 'day0-app' });
  });

  it('refuses a mismatched state', async (): Promise<void> => {
    const issuer = customerIssuer();
    const started = await startSignIn();
    const back = await issuerRedirect(issuer, started, 'priya');
    back.searchParams.set('state', 'not-the-state-we-sealed');
    const response = await callback(back.search, started.transactionCookie);
    expect(response.status).toBe(400);
    expect(setCookies(response).has('day0_session')).toBe(false);
  });

  it('refuses a callback with no PKCE verifier: no transaction, or a verifier the issuer does not match', async (): Promise<void> => {
    const issuer = customerIssuer();
    const started = await startSignIn();
    const back = await issuerRedirect(issuer, started, 'priya');
    const withoutTransaction = await callback(back.search);
    expect(withoutTransaction.status).toBe(400);
    expect(await withoutTransaction.text()).toContain('Sign in again');

    const { openTransaction, sealTransaction } =
      await import('../../../../../../src/lib/customer-session');
    const sealed = await openTransaction(SESSION_SECRET, started.transactionCookie);
    if (!sealed) throw new Error('the login route sealed no transaction');
    const forged = await sealTransaction(SESSION_SECRET, {
      ...sealed,
      codeVerifier: 'x'.repeat(43),
    });
    const wrongVerifier = await callback(back.search, forged);
    expect(wrongVerifier.status).toBe(400);
    expect(setCookies(wrongVerifier).has('day0_session')).toBe(false);
  });

  it('refuses a person outside the allowed domains, with words that say why', async (): Promise<void> => {
    const issuer = customerIssuer();
    const started = await startSignIn();
    const back = await issuerRedirect(issuer, started, 'eve');
    const response = await callback(back.search, started.transactionCookie);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('not in a domain this installation admits');
    expect(setCookies(response).has('day0_session')).toBe(false);
  });

  it('refuses a Google token without the allowed hd', async (): Promise<void> => {
    const issuer = customerIssuer({
      issuer: 'https://accounts.google.com',
      people: [
        { id: 'personal', claims: { email: 'priya@acme.test', email_verified: true } },
        {
          id: 'workspace',
          claims: { email: 'priya@acme.test', email_verified: true, hd: 'acme.test' },
        },
      ],
    });
    const personal = await startSignIn();
    const refused = await callback(
      (await issuerRedirect(issuer, personal, 'personal')).search,
      personal.transactionCookie,
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Google Workspace');

    const workspace = await startSignIn();
    const admitted = await callback(
      (await issuerRedirect(issuer, workspace, 'workspace')).search,
      workspace.transactionCookie,
    );
    expect(admitted.status).toBe(302);
  });

  it("says the issuer refused when it sends an error back, without repeating the issuer's words", async (): Promise<void> => {
    customerIssuer();
    const started = await startSignIn();
    const response = await callback(
      '?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      started.transactionCookie,
    );
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).toContain('access_denied');
    expect(text).not.toContain('<script>');
  });
});

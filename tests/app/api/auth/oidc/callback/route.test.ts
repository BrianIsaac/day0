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
    const page = await response.text();
    expect(page).toContain('You signed in as eve@rival.test');
    expect(page).toContain('not in a domain this installation admits');
    // Another account means the issuer is asked to let the person choose one.
    expect(page).toContain('href="/api/auth/oidc/login?returnTo=%2F&amp;switch=1"');
    // A refused person can tell which app refused them.
    expect(page).toContain('<p class="brand" aria-hidden="true">Day0</p>');
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

describe('the callback in check mode (pnpm check:sign-in)', (): void => {
  const REPORT_TO = 'http://127.0.0.1:41999/report';
  const CONVEX = 'https://convex.acme.test';

  /** The issuer, the check's listener and the deployment, as one live check meets them. */
  function checkBed(whoAmI: unknown): { reports: unknown[]; issuer: FakeIssuer } {
    const reports: unknown[] = [];
    const issuer = customerIssuer({
      env: { NEXT_PUBLIC_CONVEX_URL: CONVEX },
      elsewhere: async (request: Request): Promise<Response | undefined> => {
        if (request.url === REPORT_TO) {
          reports.push(await request.json());
          return new Response(null, { status: 204 });
        }
        if (request.url === `${CONVEX}/api/query`) {
          return Response.json({ status: 'success', value: whoAmI, logLines: [] });
        }
        return undefined;
      },
    });
    return { reports, issuer };
  }

  async function checkLink(): Promise<string> {
    const { sealCheckTicket } = await import('../../../../../../src/lib/sign-in-check');
    return sealCheckTicket(SESSION_SECRET, {
      checkId: 'check-1',
      reportTo: REPORT_TO,
      expiresAt: Date.now() + 600_000,
    });
  }

  async function startCheck(ticket: string): Promise<Started & { status: number }> {
    const { GET } = await import('../../../../../../app/api/auth/oidc/login/route');
    const response = await GET(
      new NextRequest(`${PUBLIC_URL}/api/auth/oidc/login?check=${encodeURIComponent(ticket)}`),
    );
    return {
      status: response.status,
      transactionCookie: cookieValue(setCookies(response).get('day0_sign_in')) ?? '',
      authorisation: new URL(response.headers.get('location') ?? 'https://unused.invalid'),
    };
  }

  it("shows each claim's verdict and the owner key Convex derived, and signs nobody in", async (): Promise<void> => {
    const { reports, issuer } = checkBed({
      ownerKey: 'https://issuer.acme.test|fake-oidc|priya',
      issuer: 'https://issuer.acme.test',
      subject: 'fake-oidc|priya',
      verifiedAddress: 'priya@acme.test',
    });
    const started = await startCheck(await checkLink());
    const back = await issuerRedirect(issuer, started, 'priya');
    const response = await callback(back.search, started.transactionCookie);

    expect(response.status).toBe(200);
    expect(setCookies(response).has('day0_session')).toBe(false);
    const page = await response.text();
    for (const claim of ['iss', 'aud', 'sub', 'email', 'email_verified', 'exp', 'refresh_token']) {
      expect(page).toContain(`<th scope="row" role="rowheader">${claim}</th>`);
    }
    expect(page).toContain('https://issuer.acme.test|fake-oidc|priya');
    // Seen on the bed: claim names and the Verdict heading broke mid-word; only values and reasons wrap.
    expect(page).toContain('th,td.verdict{white-space:nowrap}');
    expect(page).toContain('td.value,td.why{overflow-wrap:anywhere}');
    // The result is announced, in sentence case, and the page ends on the one way on.
    expect(page).toContain('<p role="status" class="ok">Pass: the deployment accepted the token.');
    expect(page).toContain('<p>Next: nothing to fix.');
    // At phone width each claim is a block, the table's semantics kept by explicit roles.
    expect(page).toContain('@media (max-width:40rem)');
    expect(page).toContain('<table role="table">');
    // At 390 the table scrolls inside its box, which a keyboard must be able to reach (N14).
    expect(page).toContain(
      '<div class="table" tabindex="0" role="region" aria-label="Each claim and its verdict">',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      checkId: 'check-1',
      whoAmI: { status: 'ok', ownerKey: 'https://issuer.acme.test|fake-oidc|priya' },
    });
  });

  it('reports a person the domain rule refuses, and what the deployment said of them', async (): Promise<void> => {
    const { reports, issuer } = checkBed(null);
    const started = await startCheck(await checkLink());
    const back = await issuerRedirect(issuer, started, 'eve');
    const response = await callback(back.search, started.transactionCookie);
    expect(response.status).toBe(200);
    expect(reports[0]).toMatchObject({ whoAmI: { status: 'gap' } });
    const email = (
      reports[0] as { verdicts: Array<{ claim: string; status: string }> }
    ).verdicts.find((one) => one.claim === 'email');
    expect(email?.status).toBe('gap');
  });

  it('refuses a check link the session secret did not seal', async (): Promise<void> => {
    checkBed(null);
    const { sealCheckTicket } = await import('../../../../../../src/lib/sign-in-check');
    const forged = await sealCheckTicket('f'.repeat(43), {
      checkId: 'check-1',
      reportTo: REPORT_TO,
      expiresAt: Date.now() + 600_000,
    });
    expect((await startCheck(forged)).status).toBe(400);
  });
});

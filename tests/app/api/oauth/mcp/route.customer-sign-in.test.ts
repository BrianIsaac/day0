import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_URL,
  customerIssuer,
  jwtClaims,
  sessionCookieHeader,
  setCookies,
  signedIn,
} from '../../auth/oidc/customer-issuer';

const action = vi.hoisted(() => vi.fn());
/** The tokens the route's client was authenticated with, in order. */
const tokens = vi.hoisted((): string[] => []);

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    action = action;
    setAuth(token: string): void {
      tokens.push(token);
    }
  },
}));

const START = new Date('2026-10-03T09:00:00Z').getTime();

beforeEach((): void => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  action.mockReset();
  tokens.length = 0;
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function returnFromConsent(cookie: string): Promise<Response> {
  const { GET } = await import('../../../../../app/api/oauth/mcp/route');
  const url = new URL(`${PUBLIC_URL}/api/oauth/mcp`);
  url.searchParams.set('code', 'the-code');
  url.searchParams.set('state', 'the-state');
  return await GET(new Request(url, { headers: { cookie } }));
}

describe('the MCP authorisation redirect under the company sign-in (the pre-tag second pass)', (): void => {
  it("completes a consent that outlasted the ID token, refreshing the manager's session on the way", async (): Promise<void> => {
    const issuer = customerIssuer({
      tokenSeconds: 120,
      env: { CONVEX_URL: 'http://127.0.0.1:3210' },
    });
    const cookie = await signedIn(issuer, 'priya');
    action.mockResolvedValue({ ok: true, agentId: 'j57agent', surfaceSlug: 'docs' });

    // A consent at the authorisation server that took five minutes: the ID token has lapsed.
    vi.setSystemTime(START + 300_000);
    const response = await returnFromConsent(cookie);

    expect(tokens).toHaveLength(1);
    expect(jwtClaims(tokens[0]!).exp).toBe(Math.floor((START + 300_000) / 1000) + 120);
    expect(action).toHaveBeenCalledWith(expect.anything(), {
      code: 'the-code',
      state: 'the-state',
    });
    expect(sessionCookieHeader(response)).not.toBe('');
    expect(new URL(response.headers.get('location') ?? '').searchParams.get('authorisation')).toBe(
      'authorised',
    );
  });

  it('acts with the session as it stands while its ID token is good, and writes no cookie', async (): Promise<void> => {
    const issuer = customerIssuer({
      tokenSeconds: 120,
      env: { CONVEX_URL: 'http://127.0.0.1:3210' },
    });
    const cookie = await signedIn(issuer, 'priya');
    action.mockResolvedValue({ ok: true, agentId: 'j57agent', surfaceSlug: 'docs' });

    vi.setSystemTime(START + 30_000);
    const response = await returnFromConsent(cookie);

    expect(tokens).toHaveLength(1);
    expect(jwtClaims(tokens[0]!).exp).toBe(Math.floor(START / 1000) + 120);
    expect(setCookies(response).size).toBe(0);
  });

  it('asks with no caller, and clears the session, when the issuer refuses the refresh', async (): Promise<void> => {
    const issuer = customerIssuer({
      tokenSeconds: 120,
      env: { CONVEX_URL: 'http://127.0.0.1:3210' },
    });
    const cookie = await signedIn(issuer, 'priya');
    await issuer.handle(
      new Request(`${issuer.issuer}/admin/revoke?person=priya`, { method: 'POST' }),
    );
    action.mockResolvedValue({ ok: false, reason: 'Your Day0 sign-in had lapsed.' });

    vi.setSystemTime(START + 300_000);
    const response = await returnFromConsent(cookie);

    expect(tokens).toEqual([]);
    expect(setCookies(response).get('day0_session')).toMatch(/Max-Age=0/);
  });
});

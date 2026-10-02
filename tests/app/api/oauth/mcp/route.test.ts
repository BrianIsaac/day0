import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const action = vi.hoisted(() => vi.fn());
const constructed = vi.hoisted((): string[] => []);
/** The tokens the route's client was authenticated with, in order. */
const tokens = vi.hoisted((): string[] => []);
/** The local sign-in's session cookie the browser presents, when it holds one. */
let cookieValue: string | undefined;

vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ userId: null }> => ({ userId: null }),
}));

vi.mock('next/headers', () => ({
  cookies: async (): Promise<{ get: () => { value: string } | undefined }> => ({
    get: (): { value: string } | undefined => (cookieValue ? { value: cookieValue } : undefined),
  }),
}));

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    action = action;
    constructor(url: string) {
      constructed.push(url);
    }
    setAuth(token: string): void {
      tokens.push(token);
    }
  },
}));

/** A P-256 signing key for the local sign-in's Convex tokens. */
async function signingKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
}

const PUBLIC_URL = 'https://day0.example.test';

let GET: (request: Request) => Promise<Response>;

beforeEach(async (): Promise<void> => {
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://convex.example.invalid');
  vi.stubEnv('CONVEX_URL', 'http://127.0.0.1:3210');
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DEV_NO_AUTH_SECRET', 'a'.repeat(43));
  vi.stubEnv('DEV_NO_AUTH_SIGNING_KEY', await signingKey());
  action.mockReset();
  constructed.length = 0;
  tokens.length = 0;
  vi.resetModules();
  // The manager's browser holds the local sign-in's session unless a test says otherwise.
  const { mintDevNoAuthSession } = await import('../../../../../src/lib/dev-auth-server');
  cookieValue = await mintDevNoAuthSession();
  ({ GET } = await import('../../../../../app/api/oauth/mcp/route'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

function redirect(query: Record<string, string>): Request {
  const url = new URL(`${PUBLIC_URL}/api/oauth/mcp`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return new Request(url);
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') ?? '');
}

describe('the MCP authorisation redirect', (): void => {
  it('hands the code, state and iss to the deployment and sends the browser to the card', async (): Promise<void> => {
    action.mockResolvedValue({ ok: true, agentId: 'j57agent', surfaceSlug: 'docs' });
    const response = await GET(
      redirect({ code: 'the-code', state: 'the-state', iss: 'https://auth.acme.test' }),
    );

    expect(action).toHaveBeenCalledWith(expect.anything(), {
      code: 'the-code',
      state: 'the-state',
      iss: 'https://auth.acme.test',
    });
    expect(constructed).toEqual(['http://127.0.0.1:3210']);
    // The deployment is asked as the browser's signed-in caller (the wave 11 review's M2).
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(response.status).toBe(307);
    const target = location(response);
    expect(target.origin).toBe(PUBLIC_URL);
    expect(target.pathname).toBe('/agent/j57agent');
    expect(target.hash).toBe('#surfaces');
    expect(target.searchParams.get('authorisation')).toBe('authorised');
    expect(target.searchParams.get('surface')).toBe('docs');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('hands a decline to the deployment too, which checks its issuer and clears the authorisation', async (): Promise<void> => {
    action.mockResolvedValue({
      ok: false,
      reason: 'The authorisation was declined at the authorisation server.',
      agentId: 'j57agent',
      surfaceSlug: 'docs',
    });
    const response = await GET(
      redirect({
        error: 'access_denied',
        error_description: 'echo <script>',
        state: 'the-state',
        iss: 'https://auth.acme.test',
      }),
    );
    expect(action).toHaveBeenCalledWith(expect.anything(), {
      error: 'access_denied',
      state: 'the-state',
      iss: 'https://auth.acme.test',
    });
    const target = location(response);
    expect(target.pathname).toBe('/agent/j57agent');
    expect(target.searchParams.get('authorisation')).toBe('failed');
    expect(target.searchParams.get('reason')).toBe(
      'The authorisation was declined at the authorisation server.',
    );
    expect(target.href).not.toContain('script');
  });

  it('asks the deployment with no token when the browser holds no session, and lands its refusal (M2)', async (): Promise<void> => {
    cookieValue = undefined;
    const refusal =
      "Only the employee's manager, signed in to Day0, can finish this authorisation, so nothing was connected. The manager starts it from the card.";
    action.mockResolvedValue({ ok: false, reason: refusal });
    const response = await GET(redirect({ code: 'the-code', state: 'the-state' }));
    expect(tokens).toEqual([]);
    expect(action).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(307);
    const target = location(response);
    expect(target.pathname).toBe('/');
    expect(target.searchParams.get('authorisation')).toBe('failed');
    expect(target.searchParams.get('reason')).toBe(refusal);
  });

  it('refuses a redirect with no state, or with neither a code nor an error, before calling the deployment', async (): Promise<void> => {
    const queries: Record<string, string>[] = [{ code: 'the-code' }, { state: 'the-state' }, {}];
    for (const query of queries) {
      const response = await GET(redirect(query));
      expect(location(response).pathname).toBe('/');
      expect(location(response).searchParams.get('authorisation')).toBe('invalid');
    }
    expect(action).not.toHaveBeenCalled();
  });

  it('lands as failed, not as a server error, when the deployment cannot be reached', async (): Promise<void> => {
    action.mockRejectedValue(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:3210'));
    const response = await GET(redirect({ code: 'the-code', state: 'the-state' }));
    expect(response.status).toBe(307);
    const target = location(response);
    expect(target.pathname).toBe('/');
    expect(target.searchParams.get('authorisation')).toBe('failed');
    expect(target.searchParams.get('reason')).toBe(
      'Day0 could not complete the authorisation just now. Start it again from the card.',
    );
  });

  it('refuses a response that repeats a parameter (RFC 9207 section 2.4)', async (): Promise<void> => {
    const url = new URL(`${PUBLIC_URL}/api/oauth/mcp`);
    url.search = 'code=c&state=s&iss=https%3A%2F%2Fauth.acme.test&iss=https%3A%2F%2Frogue.test';
    const response = await GET(new Request(url));
    expect(action).not.toHaveBeenCalled();
    expect(location(response).searchParams.get('authorisation')).toBe('invalid');
  });

  it('sends a refused state to the dashboard with the reason the deployment gave', async (): Promise<void> => {
    action.mockResolvedValue({
      ok: false,
      reason: 'That authorisation link is not one this deployment issued.',
    });
    const response = await GET(redirect({ code: 'the-code', state: 'forged' }));
    const target = location(response);
    expect(target.pathname).toBe('/');
    expect(target.searchParams.get('authorisation')).toBe('failed');
    expect(target.searchParams.get('reason')).toBe(
      'That authorisation link is not one this deployment issued.',
    );
  });
});

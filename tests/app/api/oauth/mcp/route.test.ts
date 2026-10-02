import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const action = vi.hoisted(() => vi.fn());
const constructed = vi.hoisted((): string[] => []);

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    action = action;
    constructor(url: string) {
      constructed.push(url);
    }
  },
}));

const PUBLIC_URL = 'https://day0.example.test';

let GET: (request: Request) => Promise<Response>;

beforeEach(async (): Promise<void> => {
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://convex.example.invalid');
  vi.stubEnv('CONVEX_URL', 'http://127.0.0.1:3210');
  action.mockReset();
  constructed.length = 0;
  vi.resetModules();
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

  it('refuses a redirect with no state, or with neither a code nor an error, before calling the deployment', async (): Promise<void> => {
    const queries: Record<string, string>[] = [{ code: 'the-code' }, { state: 'the-state' }, {}];
    for (const query of queries) {
      const response = await GET(redirect(query));
      expect(location(response).pathname).toBe('/');
      expect(location(response).searchParams.get('authorisation')).toBe('invalid');
    }
    expect(action).not.toHaveBeenCalled();
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

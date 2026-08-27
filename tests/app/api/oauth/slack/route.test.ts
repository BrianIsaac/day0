import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const action = vi.hoisted(() => vi.fn());

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    action = action;
  },
}));

const PUBLIC_URL = 'https://day0.example.test';

let GET: (request: Request) => Promise<Response>;

beforeEach(async (): Promise<void> => {
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210');
  action.mockReset();
  vi.resetModules();
  ({ GET } = await import('../../../../../app/api/oauth/slack/route'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

function redirect(query: Record<string, string>): Request {
  const url = new URL(`${PUBLIC_URL}/api/oauth/slack`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return new Request(url);
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') ?? '');
}

describe('the Slack install redirect', (): void => {
  it('sends a completed install to the agent\'s Surfaces tab', async (): Promise<void> => {
    action.mockResolvedValue({ ok: true, agentId: 'j57agent', surfaceSlug: 'slack' });
    const response = await GET(redirect({ code: 'the-code', state: 'the-state' }));

    expect(action).toHaveBeenCalledWith(expect.anything(), {
      code: 'the-code',
      state: 'the-state',
    });
    expect(response.status).toBe(307);
    const target = location(response);
    expect(target.pathname).toBe('/agent/j57agent');
    expect(target.hash).toBe('#surfaces');
    expect(target.searchParams.get('install')).toBe('installed');
    expect(target.searchParams.get('surface')).toBe('slack');
  });

  it('refuses a redirect with no state before calling Convex', async (): Promise<void> => {
    const response = await GET(redirect({ code: 'the-code' }));
    expect(action).not.toHaveBeenCalled();
    expect(location(response).searchParams.get('install')).toBe('invalid');
  });

  it('refuses a redirect with no code before calling Convex', async (): Promise<void> => {
    const response = await GET(redirect({ state: 'the-state' }));
    expect(action).not.toHaveBeenCalled();
    expect(location(response).searchParams.get('install')).toBe('invalid');
  });

  it('carries a declined install back without exchanging anything', async (): Promise<void> => {
    const response = await GET(redirect({ error: 'access_denied', state: 'the-state' }));
    expect(action).not.toHaveBeenCalled();
    const target = location(response);
    expect(target.searchParams.get('install')).toBe('declined');
    expect(target.searchParams.get('reason')).toBe('access_denied');
  });

  it('carries a refused state back as a reason the card can show', async (): Promise<void> => {
    action.mockResolvedValue({
      ok: false,
      reason: 'That install link has expired. Provision the app again to get a fresh one.',
    });
    const response = await GET(redirect({ code: 'the-code', state: 'stale' }));
    const target = location(response);
    expect(target.pathname).toBe('/');
    expect(target.searchParams.get('install')).toBe('failed');
    expect(target.searchParams.get('reason')).toContain('expired');
  });

  it('never puts the authorisation code on the page it redirects to', async (): Promise<void> => {
    action.mockResolvedValue({ ok: true, agentId: 'j57agent', surfaceSlug: 'slack' });
    const response = await GET(redirect({ code: 'the-secret-code', state: 'the-state' }));
    expect(response.headers.get('location')).not.toContain('the-secret-code');
  });
});

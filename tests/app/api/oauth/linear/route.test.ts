import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const action = vi.hoisted(() => vi.fn());

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    action = action;
  },
}));

const PUBLIC_URL = 'https://day0.acme.test';

let GET: (request: Request) => Promise<Response>;

beforeEach(async (): Promise<void> => {
  vi.stubEnv('DAY0_PUBLIC_URL', PUBLIC_URL);
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'http://127.0.0.1:3210');
  action.mockReset();
  vi.resetModules();
  ({ GET } = await import('../../../../../app/api/oauth/linear/route'));
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** The redirect Linear sends an administrator's browser back with. */
function redirect(query: Record<string, string>, repeated: Record<string, string> = {}): Request {
  const url = new URL(`${PUBLIC_URL}/api/oauth/linear`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  for (const [name, value] of Object.entries(repeated)) url.searchParams.append(name, value);
  return new Request(url);
}

function location(response: Response): URL {
  return new URL(response.headers.get('location') ?? '');
}

describe("the Linear app's installation redirect", (): void => {
  it("completes the installation and sends the browser to the employee's Surfaces tab", async (): Promise<void> => {
    action.mockResolvedValue({ ok: true, agentId: 'j57agent', surfaceSlug: 'linear' });

    const response = await GET(redirect({ code: 'the-code', state: 'the-state' }));

    expect(action).toHaveBeenCalledWith(expect.anything(), {
      state: 'the-state',
      code: 'the-code',
    });
    expect(response.status).toBe(307);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const target = location(response);
    expect(target.origin + target.pathname).toBe(`${PUBLIC_URL}/agent/j57agent`);
    expect(target.hash).toBe('#surfaces');
    expect(Object.fromEntries(target.searchParams)).toEqual({
      install: 'installed',
      surface: 'linear',
    });
  });

  it("hands Linear's refusal on with the state, and never its description", async (): Promise<void> => {
    action.mockResolvedValue({
      ok: false,
      agentId: 'j57agent',
      surfaceSlug: 'linear',
      reason: 'Linear did not install the app: access_denied.',
    });

    const response = await GET(
      redirect({ state: 'the-state', error: 'access_denied', error_description: '<b>no</b>' }),
    );

    expect(action).toHaveBeenCalledWith(expect.anything(), {
      state: 'the-state',
      error: 'access_denied',
    });
    expect(Object.fromEntries(location(response).searchParams)).toEqual({
      install: 'failed',
      surface: 'linear',
      reason: 'Linear did not install the app: access_denied.',
    });
  });

  it('refuses a redirect with no state, with neither code nor error, or with a repeated parameter, before calling Convex', async (): Promise<void> => {
    for (const request of [
      redirect({ code: 'the-code' }),
      redirect({ state: 'the-state' }),
      redirect({ state: 'the-state', code: 'one' }, { code: 'two' }),
    ]) {
      const target = location(await GET(request));
      expect(target.pathname).toBe('/');
      expect(target.searchParams.get('install')).toBe('invalid');
    }
    expect(action).not.toHaveBeenCalled();
  });

  it('sends the browser back to start again when the deployment cannot be asked, logging no query', async (): Promise<void> => {
    action.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3210 code=the-code'));

    const target = location(await GET(redirect({ code: 'the-code', state: 'the-state' })));

    expect(target.pathname).toBe('/');
    expect(target.searchParams.get('install')).toBe('failed');
    expect(target.searchParams.get('reason')).toContain('Start it again from the card');
  });
});

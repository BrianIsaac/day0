import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the Clerk proxy sends a signed-out visitor (round 0141 R-D item 4). The hosted demo's
 * production deployment carries none of the `NEXT_PUBLIC_CLERK_*_URL` names, and a signed-out link
 * to a page that needs a sign-in landed on Clerk's development Account Portal. The fake below
 * behaves as Clerk's middleware does: `protect()` answers a page request with a redirect to the
 * sign-in address the middleware was given, else to the instance's Account Portal, carrying the
 * page asked for as `redirect_url`.
 */

const PORTAL_SIGN_IN = 'https://capital-goblin-65.accounts.dev/sign-in';

/** Whether the fake caller is signed in. */
const session = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock('@clerk/nextjs/server', () => {
  /** Clerk's `protect()` throws its redirect, and the middleware answers with it. */
  class RedirectThrown extends Error {
    readonly response: Response;

    constructor(response: Response) {
      super('redirect');
      this.response = response;
    }
  }
  return {
    clerkMiddleware:
      (handler: (auth: unknown, request: Request) => unknown, options?: { signInUrl?: string }) =>
      async (request: Request): Promise<unknown> => {
        const auth = Object.assign(async () => ({ userId: session.userId }), {
          protect: async (): Promise<unknown> => {
            if (session.userId !== null) return { userId: session.userId };
            const target = new URL(options?.signInUrl ?? PORTAL_SIGN_IN, request.url);
            target.searchParams.set('redirect_url', request.url);
            throw new RedirectThrown(Response.redirect(target, 307));
          },
        });
        try {
          return await handler(auth, request);
        } catch (err: unknown) {
          if (err instanceof RedirectThrown) return err.response;
          throw err;
        }
      },
    createRouteMatcher:
      (patterns: string[]) =>
      (request: { nextUrl: URL }): boolean =>
        patterns.some((pattern: string): boolean =>
          new RegExp(`^${pattern.replace('(.*)', '.*')}$`).test(request.nextUrl.pathname),
        ),
  };
});

type ProxyRequest = Request & { nextUrl: URL; cookies: unknown };

let proxy: (request: ProxyRequest) => Promise<Response | undefined>;

async function loadProxy(): Promise<void> {
  vi.resetModules();
  proxy = (await import('../proxy')).default as unknown as typeof proxy;
}

beforeEach(async (): Promise<void> => {
  session.userId = null;
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', '');
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_landing');
  vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_URL', '');
  vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_UP_URL', '');
  await loadProxy();
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** A request for `pathname` on the hosted origin, with the headers a browser would send. */
function request(pathname: string, headers: Record<string, string> = {}): ProxyRequest {
  const url = new URL(`https://dayzer0.example.test${pathname}`);
  const base = new Request(url, { headers }) as ProxyRequest;
  Object.defineProperty(base, 'nextUrl', { value: url });
  Object.defineProperty(base, 'cookies', { value: { get: (): undefined => undefined } });
  return base;
}

/** A full page load, as a browser sends one for a typed or followed link. */
const DOCUMENT = { 'sec-fetch-dest': 'document', accept: 'text/html' };

/**
 * A prefetch or client-side navigation as the proxy receives it: Next strips its flight headers
 * (`rsc`, `next-router-prefetch`) before the proxy runs and keeps `next-url`.
 */
const ROUTER_FETCH = { 'next-url': '/', accept: '*/*' };

describe('where the Clerk proxy sends a signed-out visitor', (): void => {
  it.each(['/organisation', '/home', '/agent/j57agent', '/documentation'])(
    "sends a signed-out page load of %s to Day0's own sign-in, returning to the page after it",
    async (path): Promise<void> => {
      const response = await proxy(request(path, DOCUMENT));
      expect(response?.status).toBe(307);
      const location = new URL(response?.headers.get('location') ?? '');
      expect(`${location.origin}${location.pathname}`).toBe('https://dayzer0.example.test/sign-in');
      expect(location.searchParams.get('redirect_url')).toBe(`https://dayzer0.example.test${path}`);
    },
  );

  it('follows the sign-in address the environment names, which overrides the default', async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_URL', '/enter');
    await loadProxy();
    const response = await proxy(request('/organisation', DOCUMENT));
    expect(new URL(response?.headers.get('location') ?? '').pathname).toBe('/enter');
  });

  it('never redirects a prefetch the router sends without a session, so the link loads whole when followed', async (): Promise<void> => {
    const response = await proxy(request('/agent/j57agent', ROUTER_FETCH));
    expect(response?.status).toBe(204);
    expect(response?.headers.get('location')).toBeNull();
  });

  it('never redirects an in-app navigation the router sends without a session', async (): Promise<void> => {
    const response = await proxy(request('/organisation', ROUTER_FETCH));
    expect(response?.status).toBe(204);
    expect(response?.headers.get('location')).toBeNull();
  });

  it('lets a signed-in prefetch through untouched', async (): Promise<void> => {
    session.userId = 'user_signed_in';
    await expect(proxy(request('/agent/j57agent', ROUTER_FETCH))).resolves.toBeUndefined();
  });
});

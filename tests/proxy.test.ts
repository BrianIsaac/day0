import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The no-auth gate is the boundary for every route but the two that are meant
 * to be reached from off this machine. This file pins which two those are: a
 * third one added by accident would be reachable by anybody who can resolve the
 * tunnel, so the list is worth a test of its own.
 */

/**
 * A signed-out caller, as Clerk's own `auth` argument presents one: awaitable
 * for the user id, and with a `protect()` that refuses rather than returns.
 */
const signedOut = Object.assign(async (): Promise<{ userId: null }> => ({ userId: null }), {
  protect: async (): Promise<never> => {
    throw new Error('clerk would redirect to sign-in');
  },
});

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware:
    (handler: (auth: unknown, request: unknown) => unknown) =>
    (request: unknown): unknown =>
      handler(signedOut, request),
  createRouteMatcher:
    (patterns: string[]) =>
    (request: { nextUrl: URL }): boolean =>
      patterns.some((pattern: string): boolean =>
        new RegExp(`^${pattern.replace('(.*)', '.*')}$`).test(request.nextUrl.pathname),
      ),
}));

let proxy: (request: Request & { nextUrl: URL; cookies: unknown }) => unknown;

beforeEach(async (): Promise<void> => {
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DEV_NO_AUTH_SECRET', 'a'.repeat(43));
  vi.stubEnv('DEV_NO_AUTH_SIGNING_KEY', 'b'.repeat(64));
  vi.resetModules();
  proxy = (await import('../proxy')).default as typeof proxy;
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** One request with no unlock cookie, as a stranger's browser would send it. */
function request(pathname: string): Request & { nextUrl: URL; cookies: unknown } {
  const url = new URL(`https://day0.example.test${pathname}`);
  const base = new Request(url) as Request & { nextUrl: URL; cookies: unknown };
  Object.defineProperty(base, 'nextUrl', { value: url });
  Object.defineProperty(base, 'cookies', { value: { get: (): undefined => undefined } });
  return base;
}

async function status(pathname: string): Promise<number> {
  const response = (await proxy(request(pathname))) as Response;
  return response.status;
}

describe('the no-auth proxy gate', (): void => {
  it('lets the OAuth install redirect through without the unlock key', async (): Promise<void> => {
    expect(await status('/api/oauth/slack')).toBe(200);
  });

  it('lets the voice webhook through without the unlock key', async (): Promise<void> => {
    expect(await status('/api/voice/elevenlabs/webhook')).toBe(200);
  });

  it('refuses every other API route without the unlock key', async (): Promise<void> => {
    expect(await status('/api/seed')).toBe(403);
    expect(await status('/api/dev-auth/token')).toBe(403);
  });

  it('refuses a page without the unlock key', async (): Promise<void> => {
    expect(await status('/agent/j57agent')).toBe(403);
  });

  it('refuses a path that merely starts like the redirect', async (): Promise<void> => {
    expect(await status('/api/oauth-slack')).toBe(403);
  });
});

/**
 * With Clerk configured, the proxy's own public list is the whole of what a
 * stranger can reach. The demo and the setup page are the two routes the
 * landing page sends a signed-out visitor to, so a missing entry there is a
 * dead button on the hosted site rather than a visible error.
 */
describe('the Clerk proxy gate', (): void => {
  beforeEach(async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', '');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_landing');
    vi.resetModules();
    proxy = (await import('../proxy')).default as typeof proxy;
  });

  it('lets a signed-out visitor reach the recorded demo', async (): Promise<void> => {
    await expect(proxy(request('/demo'))).resolves.toBeUndefined();
  });

  it('lets a signed-out visitor reach the setup page', async (): Promise<void> => {
    await expect(proxy(request('/setup'))).resolves.toBeUndefined();
  });

  it('still protects an agent dashboard', async (): Promise<void> => {
    await expect(proxy(request('/agent/j57agent'))).rejects.toThrow('sign-in');
  });
});

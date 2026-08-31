import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The no-auth gate is the boundary for every route but the two that are meant
 * to be reached from off this machine. This file pins which two those are: a
 * third one added by accident would be reachable by anybody who can resolve the
 * tunnel, so the list is worth a test of its own.
 */

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
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

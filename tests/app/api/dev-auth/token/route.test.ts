import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ userId: null }> => ({ userId: null }),
}));

let cookieValue: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async (): Promise<{ get: () => { value: string } | undefined }> => ({
    get: (): { value: string } | undefined => (cookieValue ? { value: cookieValue } : undefined),
  }),
}));

const SECRET = 'a'.repeat(43);

/** A PKCS#8 ES256 key, as `pnpm dev:no-auth-key` writes one. */
async function signingKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
}

beforeEach(async (): Promise<void> => {
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('DEV_NO_AUTH_SECRET', SECRET);
  vi.stubEnv('DEV_NO_AUTH_SIGNING_KEY', await signingKey());
  vi.resetModules();
  cookieValue = undefined;
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('the no-auth token route', (): void => {
  it('hands an unlocked browser a Convex token', async (): Promise<void> => {
    const { mintDevNoAuthSession } = await import('../../../../../src/lib/dev-auth-server');
    cookieValue = await mintDevNoAuthSession();
    const { POST } = await import('../../../../../app/api/dev-auth/token/route');
    const response = await POST();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('refuses a cookie that holds the unlock secret rather than a session', async (): Promise<void> => {
    cookieValue = SECRET;
    const { POST } = await import('../../../../../app/api/dev-auth/token/route');
    expect((await POST()).status).toBe(403);
  });

  it('refuses a browser with no cookie', async (): Promise<void> => {
    const { POST } = await import('../../../../../app/api/dev-auth/token/route');
    expect((await POST()).status).toBe(403);
  });
});

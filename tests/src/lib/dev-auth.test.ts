import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Evaluate `src/lib/dev-auth.ts` afresh under the current stubbed environment. */
async function loadDevAuth(): Promise<typeof import('../../../src/lib/dev-auth')> {
  vi.resetModules();
  return await import('../../../src/lib/dev-auth');
}

describe('isLoopbackHostHeader', (): void => {
  it('accepts the loopback names and the whole of 127/8, with or without a port', async (): Promise<void> => {
    const { isLoopbackHostHeader } = await loadDevAuth();
    for (const host of [
      'localhost',
      'localhost:3000',
      '127.0.0.1',
      '127.9.8.7:3000',
      '[::1]',
      '[::1]:3000',
      'LOCALHOST',
    ]) {
      expect(isLoopbackHostHeader(host), host).toBe(true);
    }
  });

  it('refuses a LAN address, a public name, an empty header and a missing one', async (): Promise<void> => {
    const { isLoopbackHostHeader } = await loadDevAuth();
    for (const host of ['192.168.1.20:3000', 'day0.example.com', '', null, undefined]) {
      expect(isLoopbackHostHeader(host), String(host)).toBe(false);
    }
  });
});

describe('DEV_NO_AUTH', (): void => {
  it('is on only under next dev with the flag set to true', async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', '');
    expect((await loadDevAuth()).DEV_NO_AUTH).toBe(true);
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'false');
    expect((await loadDevAuth()).DEV_NO_AUTH).toBe(false);
  });

  it('refuses to load with the flag set in a production-like environment, naming the flag', async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(loadDevAuth()).rejects.toThrow(
      'NEXT_PUBLIC_DEV_NO_AUTH=true is a local-development-only flag',
    );
  });
});

describe('the synthetic boss', (): void => {
  it('takes the public demo address when one is set, and a local one otherwise', async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', '');
    vi.stubEnv('NEXT_PUBLIC_DEMO_BOSS_EMAIL', 'manager@example.com');
    expect((await loadDevAuth()).DEV_BOSS_EMAIL).toBe('manager@example.com');
    vi.stubEnv('NEXT_PUBLIC_DEMO_BOSS_EMAIL', '');
    expect((await loadDevAuth()).DEV_BOSS_EMAIL).toBe('boss@day0.local');
  });
});

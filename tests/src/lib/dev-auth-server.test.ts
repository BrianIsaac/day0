import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ userId: null }> => ({ userId: null }),
}));

let server: typeof import('../../../src/lib/dev-auth-server');

const SECRET = 'a'.repeat(43);
const NOW = Date.UTC(2026, 8, 27, 9, 0, 0);

beforeEach(async (): Promise<void> => {
  vi.stubEnv('DEV_NO_AUTH_SECRET', SECRET);
  vi.resetModules();
  server = await import('../../../src/lib/dev-auth-server');
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('the no-auth unlock secret', (): void => {
  it('matches only the configured secret', (): void => {
    expect(server.isDevNoAuthSecret(SECRET)).toBe(true);
    expect(server.isDevNoAuthSecret(`${SECRET}x`)).toBe(false);
    expect(server.isDevNoAuthSecret(undefined)).toBe(false);
  });

  it('matches nothing when no secret is configured', (): void => {
    vi.stubEnv('DEV_NO_AUTH_SECRET', '');
    expect(server.isDevNoAuthSecret('')).toBe(false);
  });
});

describe('a no-auth browser session', (): void => {
  it('is accepted while the secret it was signed with is current', async (): Promise<void> => {
    const session = await server.mintDevNoAuthSession(NOW);
    expect(await server.isDevNoAuthSession(session, NOW + 1_000)).toBe(true);
  });

  it('never carries the secret', async (): Promise<void> => {
    expect(await server.mintDevNoAuthSession(NOW)).not.toContain(SECRET);
  });

  it('is different for every browser that unlocks', async (): Promise<void> => {
    const first = await server.mintDevNoAuthSession(NOW);
    const second = await server.mintDevNoAuthSession(NOW);
    expect(first).not.toBe(second);
  });

  it('is refused once the secret is rotated', async (): Promise<void> => {
    const session = await server.mintDevNoAuthSession(NOW);
    vi.stubEnv('DEV_NO_AUTH_SECRET', 'b'.repeat(43));
    expect(await server.isDevNoAuthSession(session, NOW)).toBe(false);
  });

  it('is refused after it expires', async (): Promise<void> => {
    const session = await server.mintDevNoAuthSession(NOW);
    const expired = NOW + server.DEV_NO_AUTH_SESSION_SECONDS * 1000;
    expect(await server.isDevNoAuthSession(session, expired)).toBe(false);
  });

  it('is refused when its id or expiry is altered', async (): Promise<void> => {
    const [version, id, expires, signature] = (await server.mintDevNoAuthSession(NOW)).split('.');
    const laterExpiry = String(Number(expires) + 86_400);
    expect(await server.isDevNoAuthSession(`${version}.${id}x.${expires}.${signature}`, NOW)).toBe(
      false,
    );
    expect(
      await server.isDevNoAuthSession(`${version}.${id}.${laterExpiry}.${signature}`, NOW),
    ).toBe(false);
  });

  it('refuses the raw secret and malformed values without throwing', async (): Promise<void> => {
    for (const value of [
      SECRET,
      '',
      'v1',
      'v1.a.b.c',
      'v1.id.99999999999.a',
      'v2.id.1.sig',
      'v1.id.x.sig',
    ]) {
      expect(await server.isDevNoAuthSession(value, NOW), value).toBe(false);
    }
  });

  it('refuses every value when no secret is configured', async (): Promise<void> => {
    const session = await server.mintDevNoAuthSession(NOW);
    vi.stubEnv('DEV_NO_AUTH_SECRET', '');
    expect(await server.isDevNoAuthSession(session, NOW)).toBe(false);
    await expect(server.mintDevNoAuthSession(NOW)).rejects.toThrow('DEV_NO_AUTH_SECRET is not set');
  });
});

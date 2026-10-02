import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerIssuer } from '../../app/api/auth/oidc/customer-issuer';
import type { CustomerSession } from '../../../src/lib/customer-session';

beforeEach((): void => {
  vi.resetModules();
});

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function server(): Promise<typeof import('../../../src/lib/customer-oidc-server')> {
  return import('../../../src/lib/customer-oidc-server');
}

describe('the return path after sign-in', (): void => {
  it('keeps a same-origin path, query included', async (): Promise<void> => {
    const { safeReturnTo } = await server();
    expect(safeReturnTo('/agent/abc?tab=work')).toBe('/agent/abc?tab=work');
  });

  it('replaces anything that could leave the origin or loop into the sign-in', async (): Promise<void> => {
    const { safeReturnTo } = await server();
    for (const value of [
      null,
      '',
      'agent',
      '//evil.test',
      '/\\evil.test',
      'https://evil.test',
      '/a\nb',
      '/api/auth/oidc/login',
      `/${'a'.repeat(2048)}`,
    ]) {
      expect(safeReturnTo(value), String(value)).toBe('/');
    }
  });
});

describe('when an ID token is in its last minutes', (): void => {
  const session = (issuedAt: number, lifetimeMs: number): CustomerSession => ({
    version: 1,
    idToken: 'h.p.s',
    idTokenExpiresAt: issuedAt + lifetimeMs,
    startedAt: issuedAt,
    expiresAt: issuedAt + 3_600_000,
  });

  it('refreshes an hour-long token in its last five minutes', async (): Promise<void> => {
    const { needsRefresh } = await server();
    expect(needsRefresh(session(0, 3_600_000), 0, 3_600_000 - 300_001)).toBe(false);
    expect(needsRefresh(session(0, 3_600_000), 0, 3_600_000 - 300_000)).toBe(true);
  });

  it('refreshes a two-minute token at its first minute, not at once', async (): Promise<void> => {
    const { needsRefresh } = await server();
    expect(needsRefresh(session(0, 120_000), 0, 59_999)).toBe(false);
    expect(needsRefresh(session(0, 120_000), 0, 60_000)).toBe(true);
  });
});

describe('a refresh shared per refresh token', (): void => {
  it('does not hold on to an issuer that could not be reached: the next request asks again', async (): Promise<void> => {
    const issuer = customerIssuer();
    const { customerSignInSettings, refreshSession } = await server();
    const settings = customerSignInSettings();
    // Discovery is fetched first, so the refresh itself is what fails.
    await (await server()).issuerConfiguration(settings);
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    const held: CustomerSession = {
      version: 1,
      idToken: 'h.p.s',
      idTokenExpiresAt: Date.now() + 60_000,
      refreshToken: 'unknown-to-the-issuer',
      startedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    };
    expect((await refreshSession(settings, held)).kind).toBe('unavailable');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
      issuer.handle(new Request(input, init)),
    );
    // The issuer answers now, and refuses this refresh token: proof it was asked again.
    expect((await refreshSession(settings, held)).kind).toBe('refused');
  });
});

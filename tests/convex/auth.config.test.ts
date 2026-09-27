import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_NO_AUTH_ISSUER } from '../../convex/devAuth';

const DATA_JWKS = 'data:text/plain;charset=utf-8;base64,eyJrZXlzIjpbXX0=';

/** Stub a deployment's env with every identity setting cleared first. */
function deploymentEnv(values: Record<string, string>): void {
  for (const name of [
    'NEXT_PUBLIC_DEV_NO_AUTH',
    'DEV_NO_AUTH_JWKS',
    'DAY0_OIDC_ISSUER',
    'DAY0_OIDC_AUDIENCE',
    'CLERK_JWT_ISSUER_DOMAIN',
    'VERCEL',
    'NEXT_PUBLIC_VERCEL_ENV',
  ]) {
    vi.stubEnv(name, values[name] ?? '');
  }
}

/** Evaluate `convex/auth.config.ts` the way a push does: once, against the env. */
async function loadAuthConfig(): Promise<{ providers: readonly Record<string, unknown>[] }> {
  vi.resetModules();
  return (await import('../../convex/auth.config')).default;
}

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the identity providers a push declares', (): void => {
  it('accepts the local issuer and the customer issuer on one deployment', async (): Promise<void> => {
    deploymentEnv({
      NEXT_PUBLIC_DEV_NO_AUTH: 'true',
      DEV_NO_AUTH_JWKS: DATA_JWKS,
      DAY0_OIDC_ISSUER: 'https://sso.example.com/realms/ops',
      DAY0_OIDC_AUDIENCE: 'day0',
    });
    const { providers } = await loadAuthConfig();
    expect(providers).toEqual([
      expect.objectContaining({ type: 'customJwt', issuer: DEV_NO_AUTH_ISSUER }),
      { domain: 'https://sso.example.com/realms/ops', applicationID: 'day0' },
    ]);
  });

  it('takes the customer issuer alone when the local key is off', async (): Promise<void> => {
    deploymentEnv({ DAY0_OIDC_ISSUER: 'https://sso.example.com', DAY0_OIDC_AUDIENCE: 'day0' });
    expect((await loadAuthConfig()).providers).toEqual([
      { domain: 'https://sso.example.com', applicationID: 'day0' },
    ]);
  });

  it('leaves Clerk out wherever a local or customer issuer is configured', async (): Promise<void> => {
    deploymentEnv({
      NEXT_PUBLIC_DEV_NO_AUTH: 'true',
      DEV_NO_AUTH_JWKS: DATA_JWKS,
      CLERK_JWT_ISSUER_DOMAIN: 'https://demo.clerk.accounts.dev',
    });
    const { providers } = await loadAuthConfig();
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ issuer: DEV_NO_AUTH_ISSUER });
  });

  it('declares Clerk for the hosted demo when nothing else is configured', async (): Promise<void> => {
    deploymentEnv({ CLERK_JWT_ISSUER_DOMAIN: 'https://demo.clerk.accounts.dev' });
    expect((await loadAuthConfig()).providers).toEqual([
      { domain: 'https://demo.clerk.accounts.dev', applicationID: 'convex' },
    ]);
  });

  it('refuses the push when no issuer is configured, rather than trusting a placeholder one', async (): Promise<void> => {
    deploymentEnv({});
    await expect(loadAuthConfig()).rejects.toThrow('no identity provider');
  });

  it('refuses the push when the customer issuer has no audience', async (): Promise<void> => {
    deploymentEnv({ DAY0_OIDC_ISSUER: 'https://sso.example.com' });
    await expect(loadAuthConfig()).rejects.toThrow('DAY0_OIDC_AUDIENCE');
  });
});

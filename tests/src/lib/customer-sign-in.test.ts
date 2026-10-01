import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach((): void => {
  vi.resetModules();
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

async function load(
  env: Record<string, string>,
): Promise<typeof import('../../../src/lib/customer-sign-in')> {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import('../../../src/lib/customer-sign-in');
}

describe("the browser's copy of the profile", (): void => {
  it('turns the customer sign-in on only for customer-local', async (): Promise<void> => {
    expect((await load({ NEXT_PUBLIC_DAY0_PROFILE: ' customer-local ' })).CUSTOMER_SIGN_IN).toBe(
      true,
    );
    vi.resetModules();
    expect((await load({ NEXT_PUBLIC_DAY0_PROFILE: 'local-dev' })).CUSTOMER_SIGN_IN).toBe(false);
  });

  it('refuses to load beside the local key, which would be two sign-ins', async (): Promise<void> => {
    await expect(
      load({
        NEXT_PUBLIC_DAY0_PROFILE: 'customer-local',
        NEXT_PUBLIC_DEV_NO_AUTH: 'true',
        NODE_ENV: 'development',
      }),
    ).rejects.toThrow('two sign-ins');
  });
});

describe('a server whose profile differs from the build', (): void => {
  it('is refused either way, saying which value to change', async (): Promise<void> => {
    const customer = await load({ NEXT_PUBLIC_DAY0_PROFILE: 'customer-local' });
    expect(customer.profileMismatch('customer-local')).toBeUndefined();
    expect(customer.profileMismatch(undefined)).toContain('DAY0_PROFILE=local-dev');
    vi.resetModules();
    const clerk = await load({ NEXT_PUBLIC_DAY0_PROFILE: '' });
    expect(clerk.profileMismatch(undefined)).toBeUndefined();
    expect(clerk.profileMismatch('customer-local')).toContain('pnpm build again');
  });

  it('lets the local key stand in for the operator on a customer-local server under next dev', async (): Promise<void> => {
    const local = await load({ NEXT_PUBLIC_DEV_NO_AUTH: 'true', NODE_ENV: 'development' });
    expect(local.profileMismatch('customer-local')).toBeUndefined();
  });
});

describe('the sign-in link', (): void => {
  it('carries the page to land on, and asks for another account when told to', async (): Promise<void> => {
    const { customerSignInHref } = await load({});
    expect(customerSignInHref('/agent/a?b=c')).toBe(
      '/api/auth/oidc/login?returnTo=%2Fagent%2Fa%3Fb%3Dc',
    );
    expect(customerSignInHref('/', { switchAccount: true })).toBe(
      '/api/auth/oidc/login?returnTo=%2F&switch=1',
    );
  });
});

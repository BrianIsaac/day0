import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertRealMode,
  resolveDeploymentProfile,
  resolveSurfaceMode,
} from '../../../src/lib/surface-mode';

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('surface mode gate', (): void => {
  it('defaults to mock', (): void => {
    expect(resolveSurfaceMode({})).toBe('mock');
  });

  it('allows real only in local no-auth development', (): void => {
    expect(
      resolveSurfaceMode({
        DAY0_SURFACE_MODE: 'real',
        NEXT_PUBLIC_DEV_NO_AUTH: 'true',
        NODE_ENV: 'development',
      }),
    ).toBe('real');
    expect(() => resolveSurfaceMode({ DAY0_SURFACE_MODE: 'real', NODE_ENV: 'production' })).toThrow(
      'restricted',
    );
  });

  it('refuses real mode on Vercel', (): void => {
    expect(() =>
      resolveSurfaceMode({
        DAY0_SURFACE_MODE: 'real',
        NEXT_PUBLIC_DEV_NO_AUTH: 'true',
        NODE_ENV: 'development',
        VERCEL: '1',
      }),
    ).toThrow('restricted');
  });

  it('rejects an unknown mode value', (): void => {
    expect(() => resolveSurfaceMode({ DAY0_SURFACE_MODE: 'staging' })).toThrow(
      'must be mock or real',
    );
  });

  it('throws at import time when real mode is requested outside local development', async (): Promise<void> => {
    vi.resetModules();
    vi.stubEnv('DAY0_SURFACE_MODE', 'real');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(import('../../../src/lib/surface-mode')).rejects.toThrow('restricted');
  });

  it('resolves real mode at import time under local no-auth development', async (): Promise<void> => {
    vi.resetModules();
    vi.stubEnv('DAY0_SURFACE_MODE', 'real');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', '');
    const loaded = await import('../../../src/lib/surface-mode');
    expect(loaded.SURFACE_MODE).toBe('real');
  });
});

const CUSTOMER_ISSUER = {
  DAY0_OIDC_ISSUER: 'https://sso.example.com/realms/ops',
  DAY0_OIDC_AUDIENCE: 'day0',
};

describe('the customer-local profile', (): void => {
  it('defaults to local development, the profile the dev triple describes', (): void => {
    expect(resolveDeploymentProfile({})).toBe('local-dev');
    expect(resolveDeploymentProfile({ DAY0_PROFILE: ' customer-local ' })).toBe('customer-local');
  });

  it('rejects an unknown profile', (): void => {
    expect(() => resolveDeploymentProfile({ DAY0_PROFILE: 'hosted' })).toThrow(
      'DAY0_PROFILE must be local-dev or customer-local',
    );
    expect(() => resolveSurfaceMode({ DAY0_PROFILE: 'hosted' })).toThrow('DAY0_PROFILE');
  });

  it('runs real mode under next start with the customer issuer and no local key', (): void => {
    expect(
      resolveSurfaceMode({
        DAY0_SURFACE_MODE: 'real',
        DAY0_PROFILE: 'customer-local',
        NODE_ENV: 'production',
        ...CUSTOMER_ISSUER,
      }),
    ).toBe('real');
  });

  it('runs real mode with the customer issuer and the local key on one deployment', (): void => {
    expect(
      resolveSurfaceMode({
        DAY0_SURFACE_MODE: 'real',
        DAY0_PROFILE: 'customer-local',
        NEXT_PUBLIC_DEV_NO_AUTH: 'true',
        NODE_ENV: 'development',
        ...CUSTOMER_ISSUER,
      }),
    ).toBe('real');
  });

  it('refuses real mode when the profile names no issuer to sign people in with', (): void => {
    expect(() =>
      resolveSurfaceMode({ DAY0_SURFACE_MODE: 'real', DAY0_PROFILE: 'customer-local' }),
    ).toThrow('DAY0_OIDC_ISSUER');
  });

  it('refuses real mode on the platform the hosted demo runs on', (): void => {
    expect(() =>
      resolveSurfaceMode({
        DAY0_SURFACE_MODE: 'real',
        DAY0_PROFILE: 'customer-local',
        VERCEL_ENV: 'production',
        ...CUSTOMER_ISSUER,
      }),
    ).toThrow('VERCEL_ENV');
  });

  it('does not take a customer machine for the hosted demo because it runs on AWS or Kubernetes', (): void => {
    expect(
      resolveSurfaceMode({
        DAY0_SURFACE_MODE: 'real',
        DAY0_PROFILE: 'customer-local',
        AWS_REGION: 'ap-southeast-1',
        KUBERNETES_SERVICE_HOST: '10.0.0.1',
        ...CUSTOMER_ISSUER,
      }),
    ).toBe('real');
  });

  it('leaves mock mode alone under either profile', (): void => {
    expect(resolveSurfaceMode({ DAY0_PROFILE: 'customer-local' })).toBe('mock');
  });

  it('resolves real mode at import time under next start with the customer issuer', async (): Promise<void> => {
    vi.resetModules();
    vi.stubEnv('DAY0_SURFACE_MODE', 'real');
    vi.stubEnv('DAY0_PROFILE', 'customer-local');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', '');
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER.DAY0_OIDC_ISSUER);
    vi.stubEnv('DAY0_OIDC_AUDIENCE', CUSTOMER_ISSUER.DAY0_OIDC_AUDIENCE);
    const loaded = await import('../../../src/lib/surface-mode');
    expect(loaded.SURFACE_MODE).toBe('real');
  });
});

describe('real-mode feature refusal', (): void => {
  it('refuses a feature unless the deployment runs in real mode', (): void => {
    expect(() => assertRealMode('Documentation linking', 'mock')).toThrow(
      'Documentation linking is a local real-mode feature; this deployment runs in mock mode.',
    );
    expect(() => assertRealMode('Documentation linking', 'real')).not.toThrow();
  });

  it('reads the deployment mode by default', (): void => {
    expect(() => assertRealMode('Documentation linking')).toThrow('runs in mock mode');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertRealMode, resolveSurfaceMode } from '../../../src/lib/surface-mode';

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

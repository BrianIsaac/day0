import { describe, expect, it } from 'vitest';
import { resolveSurfaceMode } from '../../../src/lib/surface-mode';

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
});

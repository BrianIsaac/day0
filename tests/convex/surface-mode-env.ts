import { vi } from 'vitest';
import type { SurfaceMode } from '../../src/lib/surface-mode';

/**
 * Re-evaluate the Convex modules under a chosen deployment surface mode.
 *
 * `SURFACE_MODE` is resolved once at module load, so the module registry is
 * reset and the environment stubbed before the harness imports anything.
 *
 * Args:
 *   mode: Surface mode the next module evaluation should resolve.
 */
export function useSurfaceMode(mode: SurfaceMode): void {
  vi.resetModules();
  vi.stubEnv('DAY0_SURFACE_MODE', mode);
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('NEXT_PUBLIC_VERCEL_ENV', '');
}

/** Restore the process environment and module registry after a mode test. */
export function restoreSurfaceMode(): void {
  vi.unstubAllEnvs();
  vi.resetModules();
}

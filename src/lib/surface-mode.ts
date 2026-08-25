export type SurfaceMode = 'mock' | 'real';

/**
 * Resolve and enforce the deployment-only surface mode.
 *
 * Args:
 *   values: Environment values to inspect.
 *
 * Returns:
 *   Validated surface mode.
 */
export function resolveSurfaceMode(
  values: Partial<NodeJS.ProcessEnv> = process.env,
): SurfaceMode {
  const mode = values.DAY0_SURFACE_MODE || 'mock';
  if (mode !== 'mock' && mode !== 'real')
    throw new Error('DAY0_SURFACE_MODE must be mock or real.');
  const onVercel = Boolean(values.VERCEL || values.NEXT_PUBLIC_VERCEL_ENV);
  if (
    mode === 'real' &&
    (values.NEXT_PUBLIC_DEV_NO_AUTH !== 'true' || values.NODE_ENV !== 'development' || onVercel)
  ) {
    throw new Error('DAY0_SURFACE_MODE=real is restricted to local no-auth development.');
  }
  return mode;
}

export const SURFACE_MODE: SurfaceMode = resolveSurfaceMode();

/**
 * Refuse a local-run feature on any deployment that is not in real mode.
 *
 * The hosted mock is reachable by any signed-in user, so features that make
 * the deployment fetch, clone or classify caller-chosen content must be
 * refused server-side rather than merely hidden by the client.
 *
 * Args:
 *   feature: Human-readable feature name for the refusal message.
 *   mode: Surface mode to check, defaulting to the deployment's mode.
 *
 * Raises:
 *   Error: If the mode is not `real`.
 */
export function assertRealMode(feature: string, mode: SurfaceMode = SURFACE_MODE): void {
  if (mode !== 'real') {
    throw new Error(`${feature} is a local real-mode feature; this deployment runs in ${mode} mode.`);
  }
}

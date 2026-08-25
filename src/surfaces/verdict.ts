export const LIVENESS_HOURS = 6;

export type PersistedSurfaceVerdict =
  | 'declared'
  | 'proposed'
  | 'approved'
  | 'connected'
  | 'ungranted'
  | 'absent'
  | 'listed-dead';

export interface SurfaceLiveness {
  credentialLanded: boolean;
  lastVerifiedAt?: number;
  verdict: PersistedSurfaceVerdict;
}

/**
 * Resolve the effective connection verdict used by work evaluation.
 *
 * Args:
 *   surface: Persisted connection and liveness fields.
 *   now: Current Unix timestamp in milliseconds.
 *
 * Returns:
 *   The effective verdict after credential and six-hour liveness checks.
 */
export function verdictFor(surface: SurfaceLiveness, now: number): PersistedSurfaceVerdict {
  if (surface.verdict === 'approved' && !surface.credentialLanded) return 'ungranted';
  if (surface.verdict !== 'connected' && surface.verdict !== 'approved') return surface.verdict;
  const liveAfter = now - LIVENESS_HOURS * 60 * 60 * 1_000;
  if (
    !surface.credentialLanded ||
    surface.lastVerifiedAt === undefined ||
    surface.lastVerifiedAt < liveAfter
  ) {
    return 'listed-dead';
  }
  return 'connected';
}

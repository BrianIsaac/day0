import type { AgentMetrics } from '../convex/metrics';

/**
 * A supervision duration as the cards print it: seconds under a minute,
 * minutes and seconds under an hour, hours and minutes beyond.
 *
 * Args:
 *   milliseconds: The duration, or `null` when it has not happened.
 *
 * Returns:
 *   The duration, or "not yet".
 */
export function formatMetricDuration(milliseconds: number | null): string {
  if (milliseconds === null) return 'not yet';
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} h` : `${hours} h ${remainingMinutes} min`;
}

/**
 * Audit-trail completeness as the cards print it: the rounded share and
 * the complete rows over the landed ones.
 *
 * Args:
 *   auditTrail: The complete and landed row counts and their fraction.
 *
 * Returns:
 *   For example "100% (26/26)", or "not yet" before anything landed.
 */
export function formatAuditTrail(auditTrail: AgentMetrics['auditTrail']): string {
  return auditTrail.fraction === null
    ? 'not yet'
    : `${Math.round(auditTrail.fraction * 100)}% (${auditTrail.complete}/${auditTrail.total})`;
}

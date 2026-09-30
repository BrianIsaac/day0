import type { AgentMetrics } from '@/metrics/types';

/**
 * How many decisions the manager made: every approval, a partial one among them, and every
 * rejection. Made on the dashboard or through a chat surface alike, so the home and the
 * employee's page count the same decisions (the hosted walk's m14).
 *
 * @param decisions - The approved and rejected counts.
 */
export function decidedCount(
  decisions: Pick<AgentMetrics['decisions'], 'approved' | 'rejected'>,
): number {
  return decisions.approved + decisions.rejected;
}

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

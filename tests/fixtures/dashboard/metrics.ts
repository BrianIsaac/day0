import type { AgentMetrics } from '../../../src/metrics/types';

/** A populated supervision card's figures, the P6-9 fixture. */
export const dashboardMetrics = (): AgentMetrics =>
  ({
    charter: {
      timeToFirstDraftedMs: 1,
      timeToFirstApprovedMs: 2,
      requestChanges: 0,
    },
    decisions: {
      requested: 0,
      approved: 2,
      rejected: 1,
      partiallyApproved: 0,
      cancelled: 0,
      medianLatencyMs: 60_000,
      p90LatencyMs: 60_000,
      byVia: {
        dashboard: { decided: 3, medianLatencyMs: 60_000, p90LatencyMs: 60_000 },
        channel: { decided: 0, medianLatencyMs: null, p90LatencyMs: null },
      },
    },
    actions: {
      autoApplied: 0,
      automatic: { reads: 0, managerMessages: 0, writes: 0 },
      sessionRestores: 0,
      held: 3,
      approved: 2,
      rejected: 1,
      refused: 0,
      blockedAfterRevocation: null,
      firstBlockAfterRevocationMs: null,
    },
    surfaces: { approved: 0, rejected: 0, absent: 0 },
    skills: { approved: 0, rejected: 0 },
    autonomyChanges: 0,
    auditTrail: { complete: 3, total: 3, fraction: 1 },
    pilot: {
      skillReuse: { runs: 3, reused: 1, rate: 1 / 3 },
      cycleTime: {
        ended: 3,
        medianToEndMs: 60_000,
        completed: 2,
        medianToCompletionMs: 120_000,
        p90ToCompletionMs: 180_000,
      },
      reorientation: { answered: 1, amended: 1, rate: 1 },
      hoursSaved: { estimatedItems: 0, hours: null },
      retrieval: { tokens: null, recall: null },
    },
  }) as unknown as AgentMetrics;

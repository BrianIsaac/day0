import type { Doc } from './_generated/dataModel';
import type { AgentMetrics, DecisionVia, OwnerMetrics, PilotFigures } from '../src/metrics/types';
import { RETRIEVAL_RECALL } from '../src/metrics/retrieval-recall';

/*
 * The company's figures pooled from its employees' (wave 18, 18-s): `companyMetricsOf`, the one
 * pooling the owner's query, the read by pages and the recompute all take, with the summaries the
 * per-employee figures read too (a latency's median and percentile, the decisions', the pilot's,
 * the actions' sum) and the shapes they pool (`DecisionTotals`, `PilotTotals`, `EmployeeRecords`,
 * `EmployeeFigures`). Moved out of `convex/metrics.ts` as they stood. Below it: `metrics.ts`
 * imports this module and this module imports no other `convex/` one.
 */

function latencySummary(values: readonly number[]): {
  medianLatencyMs: number | null;
  p90LatencyMs: number | null;
} {
  if (values.length === 0) return { medianLatencyMs: null, p90LatencyMs: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianLatencyMs =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  const p90LatencyMs = sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)];
  return { medianLatencyMs, p90LatencyMs };
}

/** The raw lists behind the decision figures, which a company figure pools before any median. */
export interface DecisionTotals {
  requested: number;
  approved: number;
  rejected: number;
  partiallyApproved: number;
  cancelled: number;
  latencies: number[];
  byVia: Record<DecisionVia, number[]>;
}

/** The decision figures from their raw lists: the counts, the latencies' median and 90th, by way. */
export function summariseDecisions(totals: DecisionTotals): AgentMetrics['decisions'] {
  const all = latencySummary(totals.latencies);
  const dashboard = latencySummary(totals.byVia.dashboard);
  const channel = latencySummary(totals.byVia.channel);
  return {
    requested: totals.requested,
    approved: totals.approved,
    rejected: totals.rejected,
    partiallyApproved: totals.partiallyApproved,
    cancelled: totals.cancelled,
    ...all,
    byVia: {
      dashboard: { decided: totals.byVia.dashboard.length, ...dashboard },
      channel: { decided: totals.byVia.channel.length, ...channel },
    },
  };
}

/** The raw lists behind the pilot figures, which a company figure pools before any median. */
export interface PilotTotals {
  runs: number;
  reused: number;
  /** Of the reused runs, those of a skill adopted from another employee (A14). */
  adopted: number;
  toEnd: number[];
  /** From the ask to the completion counted, of the items whose run answered done. */
  toCompletion: number[];
  /** The items whose completion counted answered partly done (RM23 (a)). */
  partlyDone: number;
  answered: number;
  amended: number;
  /**
   * The reorientation cards opened (a joined trigger not again), approved and dismissed, and the
   * cards deferred now: a card deferred and since opened again, decided or closed at a handover is
   * not counted deferred (the v0.20.0 hosted walk's finding 5: "1 card: 0 approved, 1 dismissed,
   * 1 deferred").
   */
  cards: { opened: number; approved: number; dismissed: number; deferred: number };
  estimatedItems: number;
  estimatedMinutes: number;
  /** The items whose prompts carried a documentation selection, and their characters summed. */
  retrievalItems: number;
  retrievalChars: number;
  /** Of those items, the ones a provider reported usage for, their characters and input tokens. */
  tokenItems: number;
  billedChars: number;
  inputTokens: number;
}

/**
 * The tokens half of the retrieval figure: over the items a provider reported usage for when any
 * did, so the characters and the tokens describe the same items; else the characters alone.
 */
function retrievalTokens(totals: PilotTotals): PilotFigures['retrieval']['tokens'] {
  if (totals.tokenItems > 0) {
    return {
      items: totals.tokenItems,
      charsPerItem: totals.billedChars / totals.tokenItems,
      inputTokensPerItem: totals.inputTokens / totals.tokenItems,
    };
  }
  if (totals.retrievalItems === 0) return null;
  return {
    items: totals.retrievalItems,
    charsPerItem: totals.retrievalChars / totals.retrievalItems,
    inputTokensPerItem: null,
  };
}

/** The pilot figures from their raw lists: counts, rates and medians. */
export function summarisePilot(totals: PilotTotals): PilotFigures {
  const completion = latencySummary(totals.toCompletion);
  return {
    skillReuse: {
      runs: totals.runs,
      reused: totals.reused,
      adopted: totals.adopted,
      rate: totals.runs > 0 ? totals.reused / totals.runs : null,
    },
    cycleTime: {
      ended: totals.toEnd.length,
      medianToEndMs: latencySummary(totals.toEnd).medianLatencyMs,
      completed: totals.toCompletion.length,
      partlyDone: totals.partlyDone,
      medianToCompletionMs: completion.medianLatencyMs,
      p90ToCompletionMs: completion.p90LatencyMs,
    },
    reorientation: {
      cards: { ...totals.cards },
      answered: totals.answered,
      amended: totals.amended,
      rate: totals.answered > 0 ? totals.amended / totals.answered : null,
    },
    hoursSaved: {
      estimatedItems: totals.estimatedItems,
      hours: totals.estimatedItems > 0 ? totals.estimatedMinutes / 60 : null,
    },
    retrieval: {
      tokens: retrievalTokens(totals),
      // The recall grades the selection, so it is shown only where a selection ran: real mode,
      // which alone records one (W14-R6); the hosted mock office never meets the selector.
      recall: totals.retrievalItems > 0 ? RETRIEVAL_RECALL : null,
    },
  };
}

function pooledPilot(rows: readonly PilotTotals[]): PilotTotals {
  return {
    runs: rows.reduce((total, row) => total + row.runs, 0),
    reused: rows.reduce((total, row) => total + row.reused, 0),
    adopted: rows.reduce((total, row) => total + row.adopted, 0),
    toEnd: rows.flatMap((row) => row.toEnd),
    toCompletion: rows.flatMap((row) => row.toCompletion),
    partlyDone: rows.reduce((total, row) => total + row.partlyDone, 0),
    answered: rows.reduce((total, row) => total + row.answered, 0),
    amended: rows.reduce((total, row) => total + row.amended, 0),
    cards: {
      opened: rows.reduce((total, row) => total + row.cards.opened, 0),
      approved: rows.reduce((total, row) => total + row.cards.approved, 0),
      dismissed: rows.reduce((total, row) => total + row.cards.dismissed, 0),
      deferred: rows.reduce((total, row) => total + row.cards.deferred, 0),
    },
    estimatedItems: rows.reduce((total, row) => total + row.estimatedItems, 0),
    estimatedMinutes: rows.reduce((total, row) => total + row.estimatedMinutes, 0),
    retrievalItems: rows.reduce((total, row) => total + row.retrievalItems, 0),
    retrievalChars: rows.reduce((total, row) => total + row.retrievalChars, 0),
    tokenItems: rows.reduce((total, row) => total + row.tokenItems, 0),
    billedChars: rows.reduce((total, row) => total + row.billedChars, 0),
    inputTokens: rows.reduce((total, row) => total + row.inputTokens, 0),
  };
}

/** One employee's durable records, as `forAgent` reads them or a trace carries them. */
export interface EmployeeRecords {
  agent: Pick<Doc<'agents'>, '_id' | 'name' | 'createdAt'>;
  events: readonly Doc<'events'>[];
  workItems: readonly Doc<'workItems'>[];
  charters: readonly Doc<'charters'>[];
  /** The employee's surfaces, which tell the manager DM from other writes; none reads every automatic write as a write. */
  surfaces?: readonly Doc<'surfaces'>[];
}

function pooledActions(rows: readonly AgentMetrics['actions'][]): AgentMetrics['actions'] {
  const sum = (pick: (row: AgentMetrics['actions']) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);
  const blocked = rows.flatMap((row) =>
    row.blockedAfterRevocation === null ? [] : [row.blockedAfterRevocation],
  );
  const firstBlocks = rows.flatMap((row) =>
    row.firstBlockAfterRevocationMs === null ? [] : [row.firstBlockAfterRevocationMs],
  );
  return {
    autoApplied: sum((row) => row.autoApplied),
    automatic: {
      reads: sum((row) => row.automatic.reads),
      managerMessages: sum((row) => row.automatic.managerMessages),
      writes: sum((row) => row.automatic.writes),
    },
    sessionRestores: sum((row) => row.sessionRestores),
    held: sum((row) => row.held),
    approved: sum((row) => row.approved),
    rejected: sum((row) => row.rejected),
    refused: sum((row) => row.refused),
    // Null while no employee's scope was ever revoked, as for one employee.
    blockedAfterRevocation: blocked.length > 0 ? blocked.reduce((total, n) => total + n, 0) : null,
    firstBlockAfterRevocationMs: firstBlocks.length > 0 ? Math.min(...firstBlocks) : null,
  };
}

/**
 * One employee's figures with the raw lists behind them, which a company figure pools before it
 * takes any median: what one page of the company's figures answers for each employee it read.
 */
export interface EmployeeFigures {
  readonly agent: EmployeeRecords['agent'];
  readonly metrics: AgentMetrics;
  readonly decisions: DecisionTotals;
  readonly pilot: PilotTotals;
}

/**
 * The company row pooled from each employee's figures, beside the employees' own: the one pooling
 * the query, the read by pages and the recompute all take, so they cannot disagree.
 *
 * @param figures - Each employee's figures with the lists behind them, in deploy order.
 * @param setAside - What the selection left out, carried into the result.
 */
export function companyMetricsOf(
  figures: readonly EmployeeFigures[],
  setAside: Pick<OwnerMetrics, 'excludedAgents' | 'omittedEmployees'>,
): OwnerMetrics {
  const metrics = figures.map((figure) => figure.metrics);
  const decisions: DecisionTotals = {
    requested: 0,
    approved: 0,
    rejected: 0,
    partiallyApproved: 0,
    cancelled: 0,
    latencies: [],
    byVia: { dashboard: [], channel: [] },
  };
  for (const { decisions: own } of figures) {
    decisions.requested += own.requested;
    decisions.approved += own.approved;
    decisions.rejected += own.rejected;
    decisions.partiallyApproved += own.partiallyApproved;
    decisions.cancelled += own.cancelled;
    decisions.latencies.push(...own.latencies);
    decisions.byVia.dashboard.push(...own.byVia.dashboard);
    decisions.byVia.channel.push(...own.byVia.channel);
  }
  const sum = (pick: (row: AgentMetrics) => number): number =>
    metrics.reduce((total, row) => total + pick(row), 0);
  const charterTimes = metrics.map((row) => row.charter.timeToFirstApprovedMs);
  const approvedTimes = charterTimes.filter((time): time is number => time !== null);
  const complete = sum((row) => row.auditTrail.complete);
  const total = sum((row) => row.auditTrail.total);
  return {
    employees: figures.map(({ agent, metrics: own }) => ({
      agentId: agent._id,
      name: agent.name,
      deployedAt: agent.createdAt,
      metrics: own,
    })),
    company: {
      employees: figures.length,
      charter: {
        timesToFirstApprovedMs: charterTimes,
        medianTimeToFirstApprovedMs: latencySummary(approvedTimes).medianLatencyMs,
        approvedEmployees: approvedTimes.length,
      },
      decisions: summariseDecisions(decisions),
      actions: pooledActions(metrics.map((row) => row.actions)),
      surfaces: {
        approved: sum((row) => row.surfaces.approved),
        rejected: sum((row) => row.surfaces.rejected),
        absent: sum((row) => row.surfaces.absent),
      },
      skills: {
        approved: sum((row) => row.skills.approved),
        rejected: sum((row) => row.skills.rejected),
      },
      autonomyChanges: sum((row) => row.autonomyChanges),
      auditTrail: { complete, total, fraction: total > 0 ? complete / total : null },
      pilot: summarisePilot(pooledPilot(figures.map((figure) => figure.pilot))),
    },
    excludedAgents: setAside.excludedAgents,
    omittedEmployees: setAside.omittedEmployees,
  };
}

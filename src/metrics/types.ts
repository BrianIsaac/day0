import type { Id } from '../../convex/_generated/dataModel';

/** Where a decision was taken: the dashboard, or a reply in the manager channel. */
export type DecisionVia = 'dashboard' | 'channel';

/** One employee's supervision figures, computed from its ledger by `convex/metrics.ts`. */
export interface AgentMetrics {
  /**
   * When the first write landed, approved by the manager or applied on its own: when the first
   * week reached Working. Null before one has.
   */
  workingSince: number | null;
  charter: {
    timeToFirstDraftedMs: number | null;
    timeToFirstApprovedMs: number | null;
    requestChanges: number;
  };
  decisions: {
    requested: number;
    approved: number;
    rejected: number;
    partiallyApproved: number;
    cancelled: number;
    medianLatencyMs: number | null;
    p90LatencyMs: number | null;
    byVia: Record<
      DecisionVia,
      { decided: number; medianLatencyMs: number | null; p90LatencyMs: number | null }
    >;
  };
  actions: {
    /** Every row that landed without a person's approval: `automatic` splits it. */
    autoApplied: number;
    /** The automatic rows by what they did: reads, messages to the manager, and writes to a system. */
    automatic: { reads: number; managerMessages: number; writes: number };
    /** Replayed browser calls that landed: a sign-in repeated in a new invocation, never a write of the work. */
    sessionRestores: number;
    held: number;
    approved: number;
    rejected: number;
    refused: number;
    blockedAfterRevocation: number | null;
    firstBlockAfterRevocationMs: number | null;
  };
  surfaces: { approved: number; rejected: number; absent: number };
  skills: { approved: number; rejected: number };
  autonomyChanges: number;
  auditTrail: { complete: number; total: number; fraction: number | null };
  /** A9's five pilot figures. */
  pilot: PilotFigures;
}

/**
 * The pilot figures decision A9 adds to the ledger's own, each recomputable
 * from an exported trace.
 */
export interface PilotFigures {
  /** Of the distinct (work item, skill) runs, those run with a skill made for another item. */
  skillReuse: { runs: number; reused: number; rate: number | null };
  /**
   * From the ask (`observedAt`: the provider's own time when intake had one)
   * to the item's first terminal event, and to its first completion.
   */
  cycleTime: {
    ended: number;
    medianToEndMs: number | null;
    completed: number;
    medianToCompletionMs: number | null;
    p90ToCompletionMs: number | null;
  };
  /** The charter questions the manager answered, and how many of the answers changed the charter. */
  reorientation: { answered: number; amended: number; rate: number | null };
  /** N11: the manager's optional estimates over completed items. An internal gauge, never a claim. */
  hoursSaved: { estimatedItems: number; hours: number | null };
  /** N11: counted once B3 records the selected blocks and the provider's usage; null until then. */
  retrieval: { tokens: null; recall: null };
}

/** One employee's figures beside the company's, in deploy order. */
export interface EmployeeMetrics {
  agentId: Id<'agents'>;
  name: string;
  deployedAt: number;
  metrics: AgentMetrics;
}

/** The company's pooled figures over its employees. */
export interface CompanyMetrics {
  employees: number;
  charter: {
    /** Each employee's time from deploy to its first approved charter, in deploy order. Never summed. */
    timesToFirstApprovedMs: Array<number | null>;
    /** The median of the approved times above, over `approvedEmployees` of them. */
    medianTimeToFirstApprovedMs: number | null;
    approvedEmployees: number;
  };
  /**
   * Pooled across employees, because one manager made every decision: the
   * latencies are that manager's one distribution, never a median of medians.
   */
  decisions: AgentMetrics['decisions'];
  /** Pooled counts. A replayed browser sign-in is never an automatic action. */
  actions: AgentMetrics['actions'];
  surfaces: AgentMetrics['surfaces'];
  skills: AgentMetrics['skills'];
  autonomyChanges: number;
  /** Pooled complete rows over pooled landed rows, replayed browser calls included. */
  auditTrail: AgentMetrics['auditTrail'];
  /** Pooled across employees before any median or rate is taken. */
  pilot: PilotFigures;
}

/** Every figure the owner's supervision page shows: each employee's and the company's. */
export interface OwnerMetrics {
  /** Each employee's own figures, in deploy order. */
  employees: EmployeeMetrics[];
  company: CompanyMetrics;
  /** The owner's evaluation agents and baseline arms, never part of the company. */
  excludedAgents: number;
  /** Employees older than the most recent `MAX_COMPANY_EMPLOYEES`, left out of every figure. */
  omittedEmployees: number;
}

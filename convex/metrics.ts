import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { query, type QueryCtx } from './_generated/server';
import { assertOwnsAgent, getCaller } from './ownership';

type UnknownRecord = Record<string, unknown>;
type DecisionVia = 'dashboard' | 'channel';

export interface AgentMetrics {
  charter: {
    timeToFirstDraftedMs: number | null;
    timeToFirstApprovedMs: number | null;
    revisions: number;
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
    autoApplied: number;
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
}

export interface LedgerObservation {
  workItemId: string;
  observedAt: number | null;
  runId: string | null;
  entry: UnknownRecord;
  /** Set on a replayed browser call: the key of the row whose session it re-established. */
  sessionRestoreOf?: string;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function asIndexes(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isInteger(item) && item >= 0)
    : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

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

function runIdFromIdempotencyKey(key: unknown): string | null {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  return parts.length >= 3 && parts[1] !== '' ? parts[1] : null;
}

function actionKeyFromIdempotencyKey(key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined;
  const parts = key.split(':');
  return parts.length >= 3 ? `${parts[1]}:${parts[2]}` : undefined;
}

/**
 * Every row of a ledger, a re-established browser session's replayed calls
 * each counted as the row it is, just before the row that needed the page.
 */
function ledgerEntries(output: unknown): Array<{ entry: UnknownRecord; sessionRestoreOf?: string }> {
  const applied = asRecord(output)?.applied;
  if (!Array.isArray(applied)) return [];
  return applied.flatMap((value) => {
    const row = asRecord(value);
    if (!row) return [];
    const steps = asRecord(row.sessionRestore)?.steps;
    const owner = asString(row.idempotencyKey);
    const replayed = Array.isArray(steps)
      ? steps.flatMap((step) => {
          const entry = asRecord(step);
          return entry ? [{ entry, ...(owner ? { sessionRestoreOf: owner } : {}) }] : [];
        })
      : [];
    return [...replayed, { entry: row }];
  });
}

/**
 * Every durable ledger row, deduplicated across its work row and completion
 * event. A replayed browser call is a transport call of its own, so it is a
 * row here too, marked with the row whose session it re-established.
 */
export function collectLedgerObservations(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
): LedgerObservation[] {
  const observations = new Map<string, LedgerObservation>();
  const add = (workItemId: string, output: unknown, observedAt: number | null): void => {
    ledgerEntries(output).forEach(({ entry, sessionRestoreOf }, index) => {
      const idempotencyKey = asString(entry.idempotencyKey);
      const key = idempotencyKey ?? `${workItemId}:${observedAt ?? 'current'}:${index}`;
      const existing = observations.get(key);
      if (existing && (existing.observedAt ?? Infinity) <= (observedAt ?? Infinity)) return;
      observations.set(key, {
        workItemId,
        observedAt,
        runId: runIdFromIdempotencyKey(idempotencyKey),
        entry,
        ...(sessionRestoreOf ? { sessionRestoreOf } : {}),
      });
    });
  };
  for (const event of [...events].sort(byWriteOrder)) {
    const payload = asRecord(event.payload);
    const workItemId = asString(payload?.workItemId);
    if (workItemId && payload?.output !== undefined) {
      add(workItemId, payload.output, event.createdAt);
    }
  }
  for (const item of [...workItems].sort(
    (left, right) =>
      left._creationTime - right._creationTime ||
      (left._id < right._id ? -1 : left._id > right._id ? 1 : 0),
  )) {
    add(item._id, item.output, null);
  }
  return [...observations.values()];
}

/**
 * Events in the order they happened: by `createdAt`, and events one
 * mutation wrote in the same millisecond in the order the backend wrote
 * them. The figures then do not depend on the order the rows were read in,
 * the backend's creation order or an export's id order.
 */
function byWriteOrder(left: Doc<'events'>, right: Doc<'events'>): number {
  return (
    left.createdAt - right.createdAt ||
    left._creationTime - right._creationTime ||
    (left._id < right._id ? -1 : left._id > right._id ? 1 : 0)
  );
}

interface DecisionTotals {
  requested: number;
  approved: number;
  rejected: number;
  partiallyApproved: number;
  cancelled: number;
  latencies: number[];
  byVia: Record<DecisionVia, number[]>;
}

function decisionResult(event: Doc<'events'>):
  | {
      workItemId: string;
      kind: 'plan' | 'actions';
      outcome: 'approved' | 'rejected';
      via: DecisionVia;
      partial: boolean;
      cancelled: boolean;
    }
  | undefined {
  const payload = asRecord(event.payload);
  const workItemId = asString(payload?.workItemId);
  const via = payload?.decidedVia;
  if (!workItemId || (via !== 'dashboard' && via !== 'channel')) return undefined;
  if (event.type === 'work.plan-approved') {
    return { workItemId, kind: 'plan', outcome: 'approved', via, partial: false, cancelled: false };
  }
  if (event.type === 'work.cancelled') {
    return { workItemId, kind: 'plan', outcome: 'rejected', via, partial: false, cancelled: true };
  }
  if (event.type === 'work.actions-rejected') {
    return {
      workItemId,
      kind: 'actions',
      outcome: 'rejected',
      via,
      partial: false,
      cancelled: false,
    };
  }
  if (event.type !== 'work.actions-approved') return undefined;
  if (!payload) return undefined;
  return {
    workItemId,
    kind: 'actions',
    outcome: 'approved',
    via,
    partial:
      asIndexes(payload.approvedIndexes).length > 0 &&
      asIndexes(payload.rejectedIndexes).length > 0,
    cancelled: false,
  };
}

function countDecision(
  totals: DecisionTotals,
  outcome: 'approved' | 'rejected',
  partial: boolean,
  cancelled: boolean,
): void {
  totals[outcome] += 1;
  if (partial) totals.partiallyApproved += 1;
  if (cancelled) totals.cancelled += 1;
}

/**
 * Every decision one agent asked for and every latency the manager took,
 * kept as the raw list so decisions of several employees can be pooled
 * into the one manager's distribution before any median is taken.
 */
function decisionTotals(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
): DecisionTotals {
  const totals: DecisionTotals = {
    requested: 0,
    approved: 0,
    rejected: 0,
    partiallyApproved: 0,
    cancelled: 0,
    latencies: [],
    byVia: { dashboard: [], channel: [] },
  };
  const pending = new Map<string, Doc<'events'>[]>();
  const requestIds = new Set<string>();
  const resultIds = new Set<string>();
  const resentIds = new Map<string, string>();
  const firstAsk = (decisionId: string): string => {
    let id = decisionId;
    for (let hops = 0; hops < 100; hops += 1) {
      const earlier = resentIds.get(id);
      if (!earlier) break;
      id = earlier;
    }
    return id;
  };
  for (const event of [...events].sort(byWriteOrder)) {
    const payload = asRecord(event.payload);
    if (event.type === 'work.decision-requesting') {
      const workItemId = asString(payload?.workItemId);
      const kind = payload?.kind;
      if (!workItemId || (kind !== 'plan' && kind !== 'actions')) continue;
      const decisionId = asString(payload?.decisionId);
      const supersedes = asString(payload?.supersedes);
      if (supersedes) {
        // A resend after an undelivered DM is the same ask: the manager's wait
        // began with the first request, so it keeps its place in the queue.
        if (decisionId) resentIds.set(decisionId, supersedes);
        continue;
      }
      totals.requested += 1;
      if (decisionId) requestIds.add(decisionId);
      const key = `${workItemId}:${kind}`;
      pending.set(key, [...(pending.get(key) ?? []), event]);
      continue;
    }
    const result = decisionResult(event);
    if (!result) continue;
    countDecision(totals, result.outcome, result.partial, result.cancelled);
    const key = `${result.workItemId}:${result.kind}`;
    const queue = pending.get(key) ?? [];
    const request = queue.shift();
    pending.set(key, queue);
    if (!request) continue;
    const decisionId = asString(asRecord(request.payload)?.decisionId);
    if (decisionId) resultIds.add(decisionId);
    const latency = Math.max(0, event.createdAt - request.createdAt);
    totals.latencies.push(latency);
    totals.byVia[result.via].push(latency);
  }
  for (const item of workItems) {
    const decision = item.decision;
    if (!decision) continue;
    const askId = firstAsk(decision.id);
    if (!requestIds.has(askId)) totals.requested += 1;
    if (!decision.decidedAt || !decision.outcome || !decision.decidedVia) continue;
    if (!resultIds.has(askId)) {
      countDecision(
        totals,
        decision.outcome,
        false,
        decision.kind === 'plan' && decision.outcome === 'rejected',
      );
      const latency = Math.max(0, decision.decidedAt - decision.requestedAt);
      totals.latencies.push(latency);
      totals.byVia[decision.decidedVia].push(latency);
    }
  }
  return totals;
}

function summariseDecisions(totals: DecisionTotals): AgentMetrics['decisions'] {
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

function eventActionKey(payload: UnknownRecord, index: number): string {
  return `${asString(payload.runId) ?? asString(payload.workItemId) ?? 'unknown'}:${index}`;
}

function actionMetrics(
  events: readonly Doc<'events'>[],
  ledger: readonly LedgerObservation[],
): AgentMetrics['actions'] {
  const held = new Set<string>();
  const approved = new Set<string>();
  const rejected = new Set<string>();
  const refused = new Set<string>();
  const refusalObservations = new Map<string, { reason: string; at: number }>();
  const lastPending = new Map<string, { payload: UnknownRecord; at: number }>();
  for (const event of [...events].sort(byWriteOrder)) {
    const payload = asRecord(event.payload);
    if (!payload) continue;
    if (event.type === 'work.actions-auto-applying' || event.type === 'work.actions-pending') {
      for (const index of asIndexes(payload.heldIndexes)) held.add(eventActionKey(payload, index));
      for (const index of asIndexes(payload.refusedIndexes))
        refused.add(eventActionKey(payload, index));
      if (Array.isArray(payload.refusals)) {
        for (const value of payload.refusals) {
          const row = asRecord(value);
          const index = row?.index;
          const reason = asString(row?.reason);
          if (!Number.isInteger(index) || (index as number) < 0 || !reason) continue;
          const key = eventActionKey(payload, index as number);
          const existing = refusalObservations.get(key);
          if (!existing || event.createdAt < existing.at) {
            refusalObservations.set(key, { reason, at: event.createdAt });
          }
        }
      }
      const workItemId = asString(payload.workItemId);
      if (workItemId) lastPending.set(workItemId, { payload, at: event.createdAt });
      continue;
    }
    if (event.type === 'work.actions-approved') {
      for (const index of asIndexes(payload.approvedIndexes)) {
        approved.add(eventActionKey(payload, index));
      }
      for (const index of asIndexes(payload.rejectedIndexes)) {
        rejected.add(eventActionKey(payload, index));
      }
      continue;
    }
    if (event.type !== 'work.actions-rejected') continue;
    const workItemId = asString(payload.workItemId);
    const pending = workItemId ? lastPending.get(workItemId) : undefined;
    if (!pending) continue;
    for (const index of asIndexes(pending.payload.heldIndexes)) {
      rejected.add(eventActionKey(pending.payload, index));
    }
  }

  for (const observation of ledger) {
    const reason = asString(observation.entry.reason);
    const key =
      actionKeyFromIdempotencyKey(observation.entry.idempotencyKey) ??
      `${observation.workItemId}:ledger:${refused.size}`;
    if (reason?.startsWith('no grant')) {
      refused.add(key);
      if (observation.observedAt !== null && !refusalObservations.has(key)) {
        refusalObservations.set(key, { reason, at: observation.observedAt });
      }
    }
  }

  const revocations = events.flatMap((event) => {
    if (event.type !== 'permission.revoked') return [];
    const scope = asString(asRecord(event.payload)?.scope);
    return scope ? [{ scope, at: event.createdAt }] : [];
  });
  const paired = [...refusalObservations.values()].flatMap((observation) => {
    const scope = /^no grant \(([^)]+)\)/.exec(observation.reason)?.[1];
    if (!scope) return [];
    const revoked = revocations
      .filter((event) => event.scope === scope && event.at <= observation.at)
      .sort((left, right) => right.at - left.at)[0];
    return revoked ? [{ latency: observation.at - revoked.at }] : [];
  });
  const landed = ({ entry }: LedgerObservation): boolean => entry.ok === true && entry.held !== true;
  // A replayed sign-in repeats a call the run already landed; it is counted
  // as a replay, never as a second automatic action.
  const autoApplied = ledger.filter(
    (observation) =>
      landed(observation) &&
      observation.sessionRestoreOf === undefined &&
      (observation.entry.authority === 'standing' || observation.entry.authority === 'autonomous'),
  ).length;
  const sessionRestores = ledger.filter(
    (observation) => landed(observation) && observation.sessionRestoreOf !== undefined,
  ).length;
  return {
    autoApplied,
    sessionRestores,
    held: held.size,
    approved: approved.size,
    rejected: rejected.size,
    refused: refused.size,
    blockedAfterRevocation: revocations.length > 0 ? paired.length : null,
    firstBlockAfterRevocationMs:
      paired.length > 0 ? Math.min(...paired.map((pair) => pair.latency)) : null,
  };
}

/**
 * One agent's summary together with the raw decision latencies behind it,
 * which a company figure pools before taking its median.
 */
function agentFigures(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
  charters: readonly Doc<'charters'>[],
): { metrics: AgentMetrics; decisions: DecisionTotals } {
  const deployedAt = events
    .filter((event) => event.type === 'agent.deployed')
    .map((event) => event.createdAt)
    .sort((left, right) => left - right)[0];
  const draftedEvents = events.filter((event) => event.type === 'charter.drafted');
  const firstDraftedAt = [
    ...draftedEvents.map((event) => event.createdAt),
    ...charters.map((charter) => charter.createdAt),
  ].sort((left, right) => left - right)[0];
  const firstApprovedAt = [
    ...events.filter((event) => event.type === 'charter.approved').map((event) => event.createdAt),
    ...charters.flatMap((charter) =>
      charter.approvedAt === undefined ? [] : [charter.approvedAt],
    ),
  ].sort((left, right) => left - right)[0];
  const ledger = collectLedgerObservations(events, workItems);
  const landed = ledger.filter(({ entry }) => entry.ok === true && entry.held !== true);
  const complete = landed.filter(({ entry, runId }) => {
    const authority = entry.authority;
    return (
      asString(entry.tool) !== undefined &&
      (authority === 'standing' || authority === 'manager' || authority === 'autonomous') &&
      asString(entry.effect) !== undefined &&
      runId !== null &&
      asString(entry.idempotencyKey) !== undefined
    );
  }).length;
  const timeFromDeploy = (at: number | undefined): number | null =>
    deployedAt === undefined || at === undefined ? null : Math.max(0, at - deployedAt);
  const decisions = decisionTotals(events, workItems);
  const metrics: AgentMetrics = {
    charter: {
      timeToFirstDraftedMs: timeFromDeploy(firstDraftedAt),
      timeToFirstApprovedMs: timeFromDeploy(firstApprovedAt),
      revisions: Math.max(0, Math.max(draftedEvents.length, charters.length) - 1),
      requestChanges: events.filter((event) => event.type === 'charter.request_changes').length,
    },
    decisions: summariseDecisions(decisions),
    actions: actionMetrics(events, ledger),
    surfaces: {
      approved: events.filter((event) => event.type === 'surface.approved').length,
      rejected: events.filter((event) => event.type === 'surface.rejected').length,
      absent: events.filter(
        (event) =>
          event.type === 'surface.oriented' && asRecord(event.payload)?.verdict === 'absent',
      ).length,
    },
    skills: {
      approved: events.filter((event) => event.type === 'skill.approved').length,
      rejected: events.filter((event) => event.type === 'skill.rejected').length,
    },
    autonomyChanges: events.filter((event) => event.type === 'agent.autonomy-changed').length,
    auditTrail: {
      complete,
      total: landed.length,
      fraction: landed.length > 0 ? complete / landed.length : null,
    },
  };
  return { metrics, decisions };
}

/** Compute the complete judge-facing summary from one agent's durable records. */
export function computeAgentMetrics(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
  charters: readonly Doc<'charters'>[],
): AgentMetrics {
  return agentFigures(events, workItems, charters).metrics;
}

/** The most employees the company figures cover: as many as the landing page lists. */
export const MAX_COMPANY_EMPLOYEES = 20;

/** One employee's durable records, as `forAgent` reads them. */
export interface EmployeeRecords {
  agent: Doc<'agents'>;
  events: readonly Doc<'events'>[];
  workItems: readonly Doc<'workItems'>[];
  charters: readonly Doc<'charters'>[];
}

export interface EmployeeMetrics {
  agentId: Id<'agents'>;
  name: string;
  deployedAt: number;
  metrics: AgentMetrics;
}

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
}

export interface OwnerMetrics {
  /** Each employee's own figures, in deploy order. */
  employees: EmployeeMetrics[];
  company: CompanyMetrics;
  /** The owner's evaluation agents and baseline arms, never part of the company. */
  excludedAgents: number;
  /** Employees older than the most recent `MAX_COMPANY_EMPLOYEES`, left out of every figure. */
  omittedEmployees: number;
}

export interface CompanySelection {
  /** The employees the figures cover, in deploy order. */
  employees: Doc<'agents'>[];
  excludedAgents: number;
  omittedEmployees: number;
}

/**
 * Whether an agent row belongs to an evaluation run rather than the company.
 *
 * Match the generated address and name together: an ordinary manager may
 * also have an address beginning with `eval-`.
 *
 * Args:
 *   agent: The agent row's boss address, name and arm.
 *
 * Returns:
 *   True for an evaluation agent.
 */
export function isEvaluationAgent(agent: Pick<Doc<'agents'>, 'bossEmail' | 'name' | 'arm'>): boolean {
  if (agent.arm === 'baseline') return true;
  if (agent.name === 'Day0 revocation evaluation') {
    return /^eval-revocation-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}z@day0\.local$/.test(
      agent.bossEmail,
    );
  }
  return (
    /^Day0 evaluation [1-9]\d*$/.test(agent.name) &&
    /^eval-day0-r[1-9]\d*-\d{13}@day0\.local$/.test(agent.bossEmail)
  );
}

function byDeployOrder(left: Doc<'agents'>, right: Doc<'agents'>): number {
  return left._creationTime - right._creationTime || (left._id < right._id ? -1 : 1);
}

/**
 * The employees one owner's company figures cover.
 *
 * Another owner's agents, evaluation agents and baseline arms are left out;
 * of the rest, the most recent `MAX_COMPANY_EMPLOYEES` are kept, as the
 * landing page lists them, and the older ones are counted as omitted so a
 * partial company figure is never silent. The query and the recompute script
 * both select through here.
 *
 * Args:
 *   agents: Agent rows, in any order; rows of other owners are ignored.
 *   owner: The owner's subject.
 *
 * Returns:
 *   The employees in deploy order and the counts left out.
 */
export function selectCompanyEmployees(
  agents: readonly Doc<'agents'>[],
  owner: string,
): CompanySelection {
  const owned = agents.filter((agent) => agent.userId === owner);
  const company = owned.filter((agent) => !isEvaluationAgent(agent)).sort(byDeployOrder);
  const kept = company.slice(Math.max(0, company.length - MAX_COMPANY_EMPLOYEES));
  return {
    employees: kept,
    excludedAgents: owned.length - company.length,
    omittedEmployees: company.length - kept.length,
  };
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
 * Compute each employee's figures and the company row from their records.
 *
 * Args:
 *   records: Each employee's durable records, in deploy order.
 *   setAside: What the selection left out, carried into the result.
 *
 * Returns:
 *   The employees' own figures beside the company row.
 */
export function computeCompanyMetrics(
  records: readonly EmployeeRecords[],
  setAside: Pick<OwnerMetrics, 'excludedAgents' | 'omittedEmployees'>,
): OwnerMetrics {
  const figures = records.map((record) => ({
    agent: record.agent,
    ...agentFigures(record.events, record.workItems, record.charters),
  }));
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
    },
    excludedAgents: setAside.excludedAgents,
    omittedEmployees: setAside.omittedEmployees,
  };
}

async function readEmployeeRecords(ctx: QueryCtx, agent: Doc<'agents'>): Promise<EmployeeRecords> {
  const [events, workItems, charters] = await Promise.all([
    ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
      .collect(),
    ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agent._id))
      .collect(),
    ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
      .collect(),
  ]);
  return { agent, events, workItems, charters };
}

export const forAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<AgentMetrics> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const { events, workItems, charters } = await readEmployeeRecords(ctx, agent);
    return computeAgentMetrics(events, workItems, charters);
  },
});

/**
 * The supervision figures of the caller's company: each employee's own
 * figures and the company row. An anonymous caller gets `null`.
 */
export const forOwner = query({
  args: {},
  handler: async (ctx): Promise<OwnerMetrics | null> => {
    const identity = await getCaller(ctx);
    if (!identity) return null;
    const agents = await ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', identity.subject))
      .collect();
    const selection = selectCompanyEmployees(agents, identity.subject);
    const records = await Promise.all(
      selection.employees.map((agent) => readEmployeeRecords(ctx, agent)),
    );
    return computeCompanyMetrics(records, selection);
  },
});

import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { query } from './_generated/server';
import { assertOwnsAgent } from './ownership';

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

function ledgerEntries(output: unknown): UnknownRecord[] {
  const applied = asRecord(output)?.applied;
  return Array.isArray(applied)
    ? applied.flatMap((entry): UnknownRecord[] => {
        const row = asRecord(entry);
        return row ? [row] : [];
      })
    : [];
}

/** Every durable ledger row, deduplicated across its work row and completion event. */
export function collectLedgerObservations(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
): LedgerObservation[] {
  const observations = new Map<string, LedgerObservation>();
  const add = (workItemId: string, output: unknown, observedAt: number | null): void => {
    ledgerEntries(output).forEach((entry, index) => {
      const idempotencyKey = asString(entry.idempotencyKey);
      const key = idempotencyKey ?? `${workItemId}:${observedAt ?? 'current'}:${index}`;
      const existing = observations.get(key);
      if (existing && (existing.observedAt ?? Infinity) <= (observedAt ?? Infinity)) return;
      observations.set(key, {
        workItemId,
        observedAt,
        runId: runIdFromIdempotencyKey(idempotencyKey),
        entry,
      });
    });
  };
  for (const event of events) {
    const payload = asRecord(event.payload);
    const workItemId = asString(payload?.workItemId);
    if (workItemId && payload?.output !== undefined) {
      add(workItemId, payload.output, event.createdAt);
    }
  }
  for (const item of workItems) add(item._id, item.output, null);
  return [...observations.values()];
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

function decisionMetrics(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
): AgentMetrics['decisions'] {
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
  for (const event of [...events].sort((left, right) => left.createdAt - right.createdAt)) {
    const payload = asRecord(event.payload);
    if (event.type === 'work.decision-requesting') {
      const workItemId = asString(payload?.workItemId);
      const kind = payload?.kind;
      if (!workItemId || (kind !== 'plan' && kind !== 'actions')) continue;
      totals.requested += 1;
      const decisionId = asString(payload?.decisionId);
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
    if (!requestIds.has(decision.id)) totals.requested += 1;
    if (!decision.decidedAt || !decision.outcome || !decision.decidedVia) continue;
    if (!resultIds.has(decision.id)) {
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
  for (const event of [...events].sort((left, right) => left.createdAt - right.createdAt)) {
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
  const autoApplied = ledger.filter(
    ({ entry }) =>
      entry.ok === true &&
      entry.held !== true &&
      (entry.authority === 'standing' || entry.authority === 'autonomous'),
  ).length;
  return {
    autoApplied,
    held: held.size,
    approved: approved.size,
    rejected: rejected.size,
    refused: refused.size,
    blockedAfterRevocation: revocations.length > 0 ? paired.length : null,
    firstBlockAfterRevocationMs:
      paired.length > 0 ? Math.min(...paired.map((pair) => pair.latency)) : null,
  };
}

/** Compute the complete judge-facing summary from one agent's durable records. */
export function computeAgentMetrics(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
  charters: readonly Doc<'charters'>[],
): AgentMetrics {
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
  return {
    charter: {
      timeToFirstDraftedMs: timeFromDeploy(firstDraftedAt),
      timeToFirstApprovedMs: timeFromDeploy(firstApprovedAt),
      revisions: Math.max(0, Math.max(draftedEvents.length, charters.length) - 1),
      requestChanges: events.filter((event) => event.type === 'charter.request_changes').length,
    },
    decisions: decisionMetrics(events, workItems),
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
}

export const forAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<AgentMetrics> => {
    await assertOwnsAgent(ctx, args.agentId);
    const [events, workItems, charters] = await Promise.all([
      ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('workItems')
        .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
        .collect(),
      ctx.db
        .query('charters')
        .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
        .collect(),
    ]);
    return computeAgentMetrics(events, workItems, charters);
  },
});

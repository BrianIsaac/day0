import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { query, type QueryCtx } from './_generated/server';
import {
  actionIntent,
  isGateRefusal,
  isManagerDm,
  parseSurfaceAction,
} from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import type { SurfaceRecord } from '../src/surfaces/types';
import { droppedReadRefusal } from '../src/work/stop';
import { ledgerPhases } from '../src/work/reconciliation';
import type { MockAction } from '../src/work/types';
import { assertOwnsAgent, getCaller } from './ownership';
import { isEventOf, isEventType, type EventType } from '../src/events/contract';
import type { AgentMetrics, DecisionVia, OwnerMetrics, PilotFigures } from '../src/metrics/types';

type UnknownRecord = Record<string, unknown>;
export interface LedgerObservation {
  workItemId: string;
  observedAt: number | null;
  runId: string | null;
  entry: UnknownRecord;
  /** The action the row applied, when the output carried it beside the row: what tells a read, the manager DM and a write apart. */
  action?: UnknownRecord;
  /** Set on a replayed browser call: the key of the row whose session it re-established. */
  sessionRestoreOf?: string;
}

/** One ledger row as a run's output carries it, with its action when the output has it. */
interface LedgerRow {
  entry: UnknownRecord;
  action?: UnknownRecord;
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

/** Each applied row of one list, paired with the action at its index. */
function pairedRows(applied: unknown, actions: unknown): LedgerRow[] {
  if (!Array.isArray(applied)) return [];
  const list = Array.isArray(actions) ? actions : [];
  return applied.flatMap((value, index) => {
    const entry = asRecord(value);
    if (!entry) return [];
    const action = asRecord(list[index]);
    return [{ entry, ...(action ? { action } : {}) }];
  });
}

/**
 * Every row of a ledger: both phases of a two-phase run (a pending closing
 * set keeps phase one under `initial`), the reads a failed re-read attempted,
 * and the writes earlier runs landed that the output carries forward
 * (`landedWrites`), so a retry that replaces the output never takes a landed
 * row out of the figures. A re-established browser session's replayed calls
 * are each counted as the row they are, just before the row that needed the
 * page.
 */
function ledgerEntries(output: unknown): LedgerRow[] {
  const record = asRecord(output);
  const failedReread = asRecord(record?.failedReread);
  const carried = Array.isArray(record?.landedWrites) ? record.landedWrites : [];
  const rows: LedgerRow[] = [
    ...ledgerPhases(output).flatMap(({ applied, actions }) => pairedRows(applied, actions)),
    ...pairedRows(failedReread?.applied, failedReread?.actions),
    ...carried.flatMap((value: unknown) => {
      const write = asRecord(value);
      return pairedRows([write?.applied], [write?.action]);
    }),
  ];
  return rows.flatMap((row) => {
    const steps = asRecord(row.entry.sessionRestore)?.steps;
    const owner = asString(row.entry.idempotencyKey);
    const replayed = Array.isArray(steps)
      ? steps.flatMap((step) => {
          const entry = asRecord(step);
          return entry ? [{ entry, ...(owner ? { sessionRestoreOf: owner } : {}) }] : [];
        })
      : [];
    return [...replayed, row];
  });
}

/**
 * The writes a manager's provider reconciliation confirmed landed, as ledger
 * rows. `work.provider-reconciled` records entries, not an output, so the
 * walk reads them here; a row the output also carries is the same row.
 */
function reconciledRows(payload: UnknownRecord): LedgerRow[] {
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  return entries.flatMap((value: unknown) => {
    const entry = asRecord(value);
    if (!entry || entry.outcome !== 'landed') return [];
    return [
      {
        entry: {
          tool: entry.tool,
          ok: true,
          reconciled: true,
          ...(asString(entry.effect) ? { effect: entry.effect } : {}),
          ...(asString(entry.providerId) ? { providerId: entry.providerId } : {}),
          ...(asString(entry.idempotencyKey) ? { idempotencyKey: entry.idempotencyKey } : {}),
        },
      },
    ];
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
  const add = (workItemId: string, rows: readonly LedgerRow[], observedAt: number | null): void => {
    rows.forEach(({ entry, action, sessionRestoreOf }, index) => {
      const idempotencyKey = asString(entry.idempotencyKey);
      const key = idempotencyKey ?? `${workItemId}:${observedAt ?? 'current'}:${index}`;
      const existing = observations.get(key);
      const earlier = (existing?.observedAt ?? Infinity) <= (observedAt ?? Infinity);
      // A reconciliation's copy of a row carries less than the row itself:
      // the row wins, keeping the earlier of the two moments it was seen.
      const fuller = existing?.entry.reconciled === true && entry.reconciled !== true;
      if (existing && earlier && !fuller) return;
      if (existing && !earlier && entry.reconciled === true && existing.entry.reconciled !== true) {
        return;
      }
      observations.set(key, {
        workItemId,
        observedAt: existing && earlier ? existing.observedAt : observedAt,
        runId: runIdFromIdempotencyKey(idempotencyKey),
        entry,
        ...(action ? { action } : {}),
        ...(sessionRestoreOf ? { sessionRestoreOf } : {}),
      });
    });
  };
  for (const event of [...events].sort(byWriteOrder)) {
    const payload = asRecord(event.payload);
    const workItemId = asString(payload?.workItemId);
    if (workItemId && payload?.output !== undefined) {
      add(workItemId, ledgerEntries(payload.output), event.createdAt);
    }
    if (workItemId && payload && isEventOf(event, 'work.provider-reconciled')) {
      add(workItemId, reconciledRows(payload), event.createdAt);
    }
  }
  for (const item of [...workItems].sort(
    (left, right) =>
      left._creationTime - right._creationTime ||
      (left._id < right._id ? -1 : left._id > right._id ? 1 : 0),
  )) {
    add(item._id, ledgerEntries(item.output), null);
  }
  return [...observations.values()];
}

/**
 * Events in the order they happened: by `createdAt`, and events one
 * mutation wrote in the same millisecond in the order the backend wrote
 * them. The figures then do not depend on the order the rows were read in,
 * the backend's creation order or an export's id order.
 */
export function byWriteOrder(left: Doc<'events'>, right: Doc<'events'>): number {
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
  if (isEventOf(event, 'work.plan-approved')) {
    return { workItemId, kind: 'plan', outcome: 'approved', via, partial: false, cancelled: false };
  }
  if (isEventOf(event, 'work.cancelled')) {
    return { workItemId, kind: 'plan', outcome: 'rejected', via, partial: false, cancelled: true };
  }
  if (isEventOf(event, 'work.actions-rejected')) {
    return {
      workItemId,
      kind: 'actions',
      outcome: 'rejected',
      via,
      partial: false,
      cancelled: false,
    };
  }
  if (!isEventOf(event, 'work.actions-approved')) return undefined;
  if (!payload) return undefined;
  // Approving none of the held actions lets none of them land: a rejection.
  const approvedAny = asIndexes(payload.approvedIndexes).length > 0;
  return {
    workItemId,
    kind: 'actions',
    outcome: approvedAny ? 'approved' : 'rejected',
    via,
    partial: approvedAny && asIndexes(payload.rejectedIndexes).length > 0,
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
    if (isEventOf(event, 'work.decision-requesting')) {
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
    if (isEventOf(event, 'work.plan-redrafting')) {
      // A re-draft withdraws the plan ask that was open: the manager is not
      // asked to decide it, so it is neither a request nor the start of the
      // wait the re-drafted plan's ask begins (wave 3.5 review M21).
      const workItemId = asString(payload?.workItemId);
      if (!workItemId) continue;
      const key = `${workItemId}:plan`;
      for (const withdrawn of pending.get(key) ?? []) {
        totals.requested -= 1;
        const withdrawnId = asString(asRecord(withdrawn.payload)?.decisionId);
        if (withdrawnId) requestIds.delete(withdrawnId);
      }
      pending.delete(key);
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

/**
 * One held, refused, approved or rejected action's key: the run and the
 * action's durable index, the one its idempotency key carries, so a refusal
 * the hold and the ledger both saw is one refusal. A closing set's indexes
 * start again at 0 while its idempotency keys continue after phase one's
 * actions, so its index is offset by the prerequisite count its run's
 * `work.dependent-authoring` event records; that also covers the second
 * pending event a closing set writes without the flag.
 */
function eventActionKey(
  payload: UnknownRecord,
  index: number,
  closingOffsets: ReadonlyMap<string, number>,
): string {
  const run = asString(payload.runId) ?? asString(payload.workItemId) ?? 'unknown';
  const offset = closingOffsets.get(run);
  if (offset !== undefined) return `${run}:${offset + index}`;
  return payload.dependentPhase === true ? `${run}:closing:${index}` : `${run}:${index}`;
}

/** What an automatic row did: read, told the manager, or wrote to a system. */
type AutomaticKind = 'read' | 'manager-message' | 'write';

/**
 * Classify an automatic row: by the class the send recorded on it, so a
 * later export reproduces the split whatever became of the surface's manager
 * DM (review M16); a row sent before the class was recorded, by its action
 * against the surface as it stands. A row whose action the output did not
 * keep is counted as a write, so the split never makes the agent look more
 * supervised than the ledger can show.
 */
function automaticKind(
  observation: LedgerObservation,
  surfaces: readonly SurfaceRecord[],
): AutomaticKind {
  const recorded = asString(observation.entry.actionClass);
  if (recorded === 'manager-dm') return 'manager-message';
  if (recorded === 'read') return 'read';
  if (recorded !== undefined) return 'write';
  if (!observation.action) return 'write';
  const parsed = parseSurfaceAction(observation.action as unknown as MockAction);
  if (!parsed.ok) return 'write';
  const surface = surfaces.find((row) => row.slug === parsed.action.surface);
  if (surface && isManagerDm(parsed.action, surface)) return 'manager-message';
  return actionIntent(parsed.action) === 'write' ? 'write' : 'read';
}

function actionMetrics(
  events: readonly Doc<'events'>[],
  ledger: readonly LedgerObservation[],
  surfaces: readonly SurfaceRecord[],
): AgentMetrics['actions'] {
  const held = new Set<string>();
  const approved = new Set<string>();
  const rejected = new Set<string>();
  const refused = new Set<string>();
  const refusalObservations = new Map<string, { reason: string; at: number }>();
  const lastPending = new Map<string, { payload: UnknownRecord; at: number }>();
  const closingOffsets = new Map<string, number>();
  for (const event of [...events].sort(byWriteOrder)) {
    const payload = asRecord(event.payload);
    if (!payload) continue;
    if (isEventOf(event, 'work.dependent-authoring')) {
      const run = asString(payload.runId);
      const offset = payload.prerequisiteActionCount;
      if (run) closingOffsets.set(run, Number.isInteger(offset) ? (offset as number) : 0);
      continue;
    }
    if (
      isEventOf(event, 'work.actions-auto-applying') ||
      isEventOf(event, 'work.actions-pending')
    ) {
      for (const index of asIndexes(payload.heldIndexes))
        held.add(eventActionKey(payload, index, closingOffsets));
      for (const index of asIndexes(payload.refusedIndexes))
        refused.add(eventActionKey(payload, index, closingOffsets));
      if (Array.isArray(payload.refusals)) {
        for (const value of payload.refusals) {
          const row = asRecord(value);
          const index = row?.index;
          const reason = asString(row?.reason);
          if (!Number.isInteger(index) || (index as number) < 0 || !reason) continue;
          const key = eventActionKey(payload, index as number, closingOffsets);
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
    if (isEventOf(event, 'work.actions-approved')) {
      // The decision's indexes are the held set's: key them in the run and
      // phase that set was held under, whatever id the approval carries.
      const workItemId = asString(payload.workItemId);
      const heldUnder = (workItemId ? lastPending.get(workItemId)?.payload : undefined) ?? payload;
      const approvedIndexes = asIndexes(payload.approvedIndexes);
      for (const index of approvedIndexes)
        approved.add(eventActionKey(heldUnder, index, closingOffsets));
      const rejectedIndexes =
        approvedIndexes.length > 0
          ? asIndexes(payload.rejectedIndexes)
          : [...asIndexes(payload.rejectedIndexes), ...asIndexes(heldUnder.heldIndexes)];
      for (const index of rejectedIndexes)
        rejected.add(eventActionKey(heldUnder, index, closingOffsets));
      continue;
    }
    if (!isEventOf(event, 'work.actions-rejected')) continue;
    const workItemId = asString(payload.workItemId);
    const pending = workItemId ? lastPending.get(workItemId) : undefined;
    if (!pending) continue;
    for (const index of asIndexes(pending.payload.heldIndexes)) {
      rejected.add(eventActionKey(pending.payload, index, closingOffsets));
    }
  }

  for (const observation of ledger) {
    const reason = asString(observation.entry.reason);
    const key =
      actionKeyFromIdempotencyKey(observation.entry.idempotencyKey) ??
      `${observation.workItemId}:ledger:${refused.size}`;
    // A rule that refuses at apply time (a write with nothing attributable,
    // a status change with no audit comment) is seen by no hold-time review,
    // so the ledger is the only place it is recorded.
    // A read the gate refused and the run went on without is kept as a held
    // row; the refusal under its line counts as any other does.
    const refusal =
      droppedReadRefusal(reason) ?? (observation.entry.held !== true ? reason : undefined);
    if (refusal && isGateRefusal(refusal)) {
      refused.add(key);
      if (observation.observedAt !== null && !refusalObservations.has(key)) {
        refusalObservations.set(key, { reason: refusal, at: observation.observedAt });
      }
    }
  }

  const revocations = events.flatMap((event) => {
    if (!isEventOf(event, 'permission.revoked')) return [];
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
  const landed = ({ entry }: LedgerObservation): boolean =>
    entry.ok === true && entry.held !== true;
  // A replayed sign-in repeats a call the run already landed; it is counted
  // as a replay, never as a second automatic action.
  const automaticRows = ledger.filter(
    (observation) =>
      landed(observation) &&
      observation.sessionRestoreOf === undefined &&
      (observation.entry.authority === 'standing' || observation.entry.authority === 'autonomous'),
  );
  const kinds = automaticRows.map((observation) => automaticKind(observation, surfaces));
  const count = (kind: AutomaticKind): number => kinds.filter((each) => each === kind).length;
  const sessionRestores = ledger.filter(
    (observation) => landed(observation) && observation.sessionRestoreOf !== undefined,
  ).length;
  return {
    autoApplied: automaticRows.length,
    automatic: {
      reads: count('read'),
      managerMessages: count('manager-message'),
      writes: count('write'),
    },
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

/** The work events that end an item's run: every terminal transition writes one. */
export const TERMINAL_WORK_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'work.completed',
  'work.failed',
  'work.cancelled',
  'work.withdrawn',
  'work.skipped',
  'work.actions-rejected',
  'work.actions-interrupted',
]);

/** The raw lists behind the pilot figures, which a company figure pools before any median. */
interface PilotTotals {
  runs: number;
  reused: number;
  toEnd: number[];
  toCompletion: number[];
  answered: number;
  amended: number;
  estimatedItems: number;
  estimatedMinutes: number;
}

function pilotTotals(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
): PilotTotals {
  const ordered = [...events].sort(byWriteOrder);
  const firstItemOfSkill = new Map<string, string>();
  const runs = new Set<string>();
  let reused = 0;
  const standingEnd = new Map<string, number>();
  const firstCompletion = new Map<string, number>();
  const discoveredAt = new Map<string, number>();
  let answered = 0;
  let amended = 0;
  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const workItemId = asString(payload?.workItemId);
    if (isEventOf(event, 'work.execution-claimed') && workItemId) {
      const skillId = asString(payload?.skillId);
      if (!skillId || runs.has(`${workItemId}:${skillId}`)) continue;
      runs.add(`${workItemId}:${skillId}`);
      const proposedFor = asString(payload?.proposedFor);
      const first = firstItemOfSkill.get(skillId);
      if (first === undefined) firstItemOfSkill.set(skillId, workItemId);
      // The item a skill was made for decides; a builtin, made for none,
      // is reused from its second item on.
      const reuse =
        proposedFor !== undefined
          ? proposedFor !== workItemId
          : (first ?? workItemId) !== workItemId;
      if (reuse) reused += 1;
      continue;
    }
    if (isEventOf(event, 'work.discovered') && workItemId && !discoveredAt.has(workItemId)) {
      discoveredAt.set(workItemId, event.createdAt);
      continue;
    }
    // An end the manager's Retry took back (a skip overruled with "Take it
    // anyway") did not end the item; its next end is the one that stands.
    if (isEventOf(event, 'work.retry') && workItemId) {
      standingEnd.delete(workItemId);
      continue;
    }
    if (isEventType(event.type) && TERMINAL_WORK_EVENTS.has(event.type) && workItemId) {
      if (!standingEnd.has(workItemId)) standingEnd.set(workItemId, event.createdAt);
      if (isEventOf(event, 'work.completed') && !firstCompletion.has(workItemId)) {
        firstCompletion.set(workItemId, event.createdAt);
      }
      continue;
    }
    if (isEventOf(event, 'charter.question-answered')) {
      answered += 1;
      if (payload?.amended === true) amended += 1;
    }
  }
  const askedAt = new Map(discoveredAt);
  for (const item of workItems) askedAt.set(item._id, item.observedAt);
  const durations = (ends: Map<string, number>): number[] =>
    [...ends].flatMap(([workItemId, at]) => {
      const start = askedAt.get(workItemId);
      return start === undefined ? [] : [Math.max(0, at - start)];
    });
  const estimates = workItems.flatMap((item) =>
    item.state === 'completed' && typeof item.manualEstimateMinutes === 'number'
      ? [item.manualEstimateMinutes]
      : [],
  );
  return {
    runs: runs.size,
    reused,
    toEnd: durations(standingEnd),
    toCompletion: durations(firstCompletion),
    answered,
    amended,
    estimatedItems: estimates.length,
    estimatedMinutes: estimates.reduce((total, minutes) => total + minutes, 0),
  };
}

function summarisePilot(totals: PilotTotals): PilotFigures {
  const completion = latencySummary(totals.toCompletion);
  return {
    skillReuse: {
      runs: totals.runs,
      reused: totals.reused,
      rate: totals.runs > 0 ? totals.reused / totals.runs : null,
    },
    cycleTime: {
      ended: totals.toEnd.length,
      medianToEndMs: latencySummary(totals.toEnd).medianLatencyMs,
      completed: totals.toCompletion.length,
      medianToCompletionMs: completion.medianLatencyMs,
      p90ToCompletionMs: completion.p90LatencyMs,
    },
    reorientation: {
      answered: totals.answered,
      amended: totals.amended,
      rate: totals.answered > 0 ? totals.amended / totals.answered : null,
    },
    hoursSaved: {
      estimatedItems: totals.estimatedItems,
      hours: totals.estimatedItems > 0 ? totals.estimatedMinutes / 60 : null,
    },
    retrieval: { tokens: null, recall: null },
  };
}

function pooledPilot(rows: readonly PilotTotals[]): PilotTotals {
  return {
    runs: rows.reduce((total, row) => total + row.runs, 0),
    reused: rows.reduce((total, row) => total + row.reused, 0),
    toEnd: rows.flatMap((row) => row.toEnd),
    toCompletion: rows.flatMap((row) => row.toCompletion),
    answered: rows.reduce((total, row) => total + row.answered, 0),
    amended: rows.reduce((total, row) => total + row.amended, 0),
    estimatedItems: rows.reduce((total, row) => total + row.estimatedItems, 0),
    estimatedMinutes: rows.reduce((total, row) => total + row.estimatedMinutes, 0),
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
  surfaces: readonly Doc<'surfaces'>[],
): { metrics: AgentMetrics; decisions: DecisionTotals; pilot: PilotTotals } {
  const deployedAt = events
    .filter((event) => isEventOf(event, 'agent.deployed'))
    .map((event) => event.createdAt)
    .sort((left, right) => left - right)[0];
  const draftedEvents = events.filter((event) => isEventOf(event, 'charter.drafted'));
  const firstDraftedAt = [
    ...draftedEvents.map((event) => event.createdAt),
    ...charters.map((charter) => charter.createdAt),
  ].sort((left, right) => left - right)[0];
  const firstApprovedAt = [
    ...events
      .filter((event) => isEventOf(event, 'charter.approved'))
      .map((event) => event.createdAt),
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
  const pilot = pilotTotals(events, workItems);
  const metrics: AgentMetrics = {
    charter: {
      timeToFirstDraftedMs: timeFromDeploy(firstDraftedAt),
      timeToFirstApprovedMs: timeFromDeploy(firstApprovedAt),
      revisions: Math.max(0, Math.max(draftedEvents.length, charters.length) - 1),
      requestChanges: events.filter((event) => isEventOf(event, 'charter.request_changes')).length,
    },
    decisions: summariseDecisions(decisions),
    actions: actionMetrics(events, ledger, surfaces.map(toSurfaceRecord)),
    surfaces: {
      approved: events.filter((event) => isEventOf(event, 'surface.approved')).length,
      rejected: events.filter((event) => isEventOf(event, 'surface.rejected')).length,
      absent: events.filter(
        (event) =>
          isEventOf(event, 'surface.oriented') && asRecord(event.payload)?.verdict === 'absent',
      ).length,
    },
    skills: {
      approved: events.filter((event) => isEventOf(event, 'skill.approved')).length,
      rejected: events.filter((event) => isEventOf(event, 'skill.rejected')).length,
    },
    autonomyChanges: events.filter((event) => isEventOf(event, 'agent.autonomy-changed')).length,
    auditTrail: {
      complete,
      total: landed.length,
      fraction: landed.length > 0 ? complete / landed.length : null,
    },
    pilot: summarisePilot(pilot),
  };
  return { metrics, decisions, pilot };
}

/** Compute the complete supervision summary from one agent's durable records. */
export function computeAgentMetrics(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
  charters: readonly Doc<'charters'>[],
  surfaces: readonly Doc<'surfaces'>[] = [],
): AgentMetrics {
  return agentFigures(events, workItems, charters, surfaces).metrics;
}

/** The most employees the company figures cover: as many as the landing page lists. */
export const MAX_COMPANY_EMPLOYEES = 20;

/** One employee's durable records, as `forAgent` reads them or a trace carries them. */
export interface EmployeeRecords {
  agent: Pick<Doc<'agents'>, '_id' | 'name' | 'createdAt'>;
  events: readonly Doc<'events'>[];
  workItems: readonly Doc<'workItems'>[];
  charters: readonly Doc<'charters'>[];
  /** The employee's surfaces, which tell the manager DM from other writes; none reads every automatic write as a write. */
  surfaces?: readonly Doc<'surfaces'>[];
}

/** What the company selection reads of an agent, from a row or from a trace. */
export type CompanyAgent = Pick<Doc<'agents'>, '_id' | '_creationTime' | 'userId'>;

export interface CompanySelection<Agent extends CompanyAgent = Doc<'agents'>> {
  /** The employees the figures cover, in deploy order. */
  employees: Agent[];
  excludedAgents: number;
  omittedEmployees: number;
}

/**
 * Whether an agent row belongs to an evaluation run rather than the company.
 *
 * Match an evaluation name and its reserved address together: an ordinary
 * manager may also have an address beginning with `eval-`. The revocation
 * trial's driver and manual review beds use different timestamp formats.
 *
 * Args:
 *   agent: The agent row's boss address, name and arm.
 *
 * Returns:
 *   True for an evaluation agent.
 */
export function isEvaluationAgent(
  agent: Pick<Doc<'agents'>, 'bossEmail' | 'name' | 'arm'>,
): boolean {
  if (agent.arm === 'baseline') return true;
  if (!agent.bossEmail.startsWith('eval-') || !agent.bossEmail.endsWith('@day0.local')) {
    return false;
  }
  if (agent.name === 'Day0 revocation evaluation') {
    return agent.bossEmail.startsWith('eval-revocation-');
  }
  return (
    /^Day0 evaluation [1-9]\d*$/.test(agent.name) &&
    /^eval-day0-r[1-9]\d*-\d{13}@day0\.local$/.test(agent.bossEmail)
  );
}

function byDeployOrder(left: CompanyAgent, right: CompanyAgent): number {
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
 *   isEvaluation: How an evaluation agent is told: by its row's reserved
 *     address, or by the flag a trace carries instead of the address.
 *
 * Returns:
 *   The employees in deploy order and the counts left out.
 */
export function selectCompanyEmployees<Agent extends CompanyAgent>(
  agents: readonly Agent[],
  owner: string,
  isEvaluation: (agent: Agent) => boolean,
): CompanySelection<Agent> {
  const owned = agents.filter((agent) => agent.userId === owner);
  const company = owned.filter((agent) => !isEvaluation(agent)).sort(byDeployOrder);
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
    ...agentFigures(record.events, record.workItems, record.charters, record.surfaces ?? []),
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
      pilot: summarisePilot(pooledPilot(figures.map((figure) => figure.pilot))),
    },
    excludedAgents: setAside.excludedAgents,
    omittedEmployees: setAside.omittedEmployees,
  };
}

async function readEmployeeRecords(ctx: QueryCtx, agent: Doc<'agents'>): Promise<EmployeeRecords> {
  const [events, workItems, charters, surfaces] = await Promise.all([
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
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
      .collect(),
  ]);
  return { agent, events, workItems, charters, surfaces };
}

export const forAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<AgentMetrics> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const { events, workItems, charters, surfaces } = await readEmployeeRecords(ctx, agent);
    return computeAgentMetrics(events, workItems, charters, surfaces);
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
      .withIndex('by_userId', (q) => q.eq('userId', identity.ownerKey))
      .collect();
    const selection = selectCompanyEmployees(agents, identity.ownerKey, isEvaluationAgent);
    const records = await Promise.all(
      selection.employees.map((agent) => readEmployeeRecords(ctx, agent)),
    );
    return computeCompanyMetrics(records, selection);
  },
});

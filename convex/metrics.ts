import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { action, internalQuery, query, type QueryCtx } from './_generated/server';
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
import { finishedAnswerOf } from '../src/work/work-done';
import type { MockAction } from '../src/work/types';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';
import { log } from '../src/lib/logger';
import { isEventOf, isEventType, type EventType } from '../src/events/contract';
import type { AgentMetrics, DecisionVia, OwnerMetrics } from '../src/metrics/types';
import { addDays, agentZone, dayStart } from '../src/lib/zone';
import { isEvaluationShapedAddress, normaliseManagerAddress } from '../src/agent/manager-address';
import {
  isWholeHistory,
  isWithinTenure,
  tenureWindowsOf,
  WHOLE_HISTORY,
  type AcceptedHandover,
  type TenureWindow,
} from '../src/metrics/tenure';
import {
  companyMetricsOf,
  summariseDecisions,
  summarisePilot,
  type DecisionTotals,
  type EmployeeFigures,
  type EmployeeRecords,
  type PilotTotals,
} from './companyFigures';

/*
 * The company's pooling (`companyMetricsOf`) and the summaries it shares with one employee's
 * figures are a module below, `convex/companyFigures.ts` (wave 18, 18-s), which this one imports;
 * the reads, the ledger walk, each employee's figures and the four registered functions stay here.
 */

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
  // When each item began waiting on the manager, by `${workItemId}:${kind}`: the start of the
  // wait for a decision made on the dashboard that no chat surface was asked for (walk m14).
  const waitingSince = new Map<string, number>();
  const requestIds = new Set<string>();
  const resultIds = new Set<string>();
  const resentIds = new Map<string, string>();
  // An approval that left a close the tripwire held for its card, by item: the card's decision on
  // that close is the rest of the same decision, not a second one (W13-R50), so it is folded into
  // this one, which reads approved in part when the close is withheld.
  const leftForCard = new Map<string, { runId: string | undefined; partial: boolean }>();
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
    if (isEventOf(event, 'work.plan-drafted')) {
      const workItemId = asString(payload?.workItemId);
      if (workItemId) waitingSince.set(`${workItemId}:plan`, event.createdAt);
      continue;
    }
    if (isEventOf(event, 'work.actions-pending')) {
      // Only a set holding something for the manager waits on them.
      const workItemId = asString(payload?.workItemId);
      if (workItemId && asIndexes(payload?.heldIndexes).length > 0) {
        waitingSince.set(`${workItemId}:actions`, event.createdAt);
      }
      // A set another run holds ends the wait for a close an earlier run left for its card: that
      // close was never decided, and the card's next decision is on this run's set, a decision of
      // its own (W14-R46: a later run's rejection was folded into the earlier run's approval).
      const left = workItemId ? leftForCard.get(workItemId) : undefined;
      if (workItemId && left !== undefined && left.runId !== asString(payload?.runId)) {
        leftForCard.delete(workItemId);
      }
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
      waitingSince.delete(key);
      continue;
    }
    const result = decisionResult(event);
    if (!result) continue;
    const key = `${result.workItemId}:${result.kind}`;
    const queue = pending.get(key) ?? [];
    const request = queue.shift();
    pending.set(key, queue);
    const earlier = result.kind === 'actions' ? leftForCard.get(result.workItemId) : undefined;
    // The card's decision on the close an approval left: an approval of the same run, or the run
    // rejected on the card (its event names no run, and only the close is left to decide). It
    // adds no decision and no latency of its own: the wait was for the one decision already timed.
    const rejectedOnCard = isEventOf(event, 'work.actions-rejected');
    if (earlier !== undefined && (rejectedOnCard || earlier.runId === asString(payload?.runId))) {
      leftForCard.delete(result.workItemId);
      waitingSince.delete(key);
      const askId = asString(asRecord(request?.payload)?.decisionId);
      if (askId) resultIds.add(askId);
      if (!earlier.partial && (rejectedOnCard || asIndexes(payload?.rejectedIndexes).length > 0)) {
        totals.partiallyApproved += 1;
      }
      continue;
    }
    countDecision(totals, result.outcome, result.partial, result.cancelled);
    if (result.kind === 'actions') {
      if (asIndexes(payload?.leftForCard).length > 0) {
        leftForCard.set(result.workItemId, {
          runId: asString(payload?.runId),
          partial: result.partial,
        });
      } else {
        leftForCard.delete(result.workItemId);
      }
    }
    const waitStart = waitingSince.get(key);
    waitingSince.delete(key);
    if (!request) {
      // Decided on the dashboard with no ask on a chat surface: the manager's wait began when
      // the item started waiting on them, so the page and the home both have one to quote.
      if (waitStart !== undefined) {
        const latency = Math.max(0, event.createdAt - waitStart);
        totals.latencies.push(latency);
        totals.byVia[result.via].push(latency);
      }
      continue;
    }
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

/**
 * Whether a ledger row is one the employee applied on its own: landed, under standing or
 * autonomous authority, and not a replayed sign-in. The one rule the automatic counts read.
 */
function isAutomaticRow(observation: LedgerObservation): boolean {
  return (
    observation.entry.ok === true &&
    observation.entry.held !== true &&
    observation.sessionRestoreOf === undefined &&
    (observation.entry.authority === 'standing' || observation.entry.authority === 'autonomous')
  );
}

/**
 * Whether a ledger row is a write to a system that landed under an authority the ledger names:
 * the manager's approval, a standing permission or autonomy. A replayed sign-in, a row held or
 * waiting for approval, a failed apply, a message to the manager and a read are not; nor is a
 * reconciliation copy, which carries no authority of its own (the full row it copies does).
 */
function isLandedWrite(
  observation: LedgerObservation,
  surfaces: readonly SurfaceRecord[],
): boolean {
  const { entry } = observation;
  return (
    entry.ok === true &&
    entry.held !== true &&
    entry.awaitingApproval !== true &&
    observation.sessionRestoreOf === undefined &&
    (entry.authority === 'manager' ||
      entry.authority === 'standing' ||
      entry.authority === 'autonomous') &&
    automaticKind(observation, surfaces) === 'write'
  );
}

/** The first week's Working, as one figure: whether a supervised write landed, and when. */
interface FirstLandedWrite {
  readonly landed: boolean;
  /** When the first did, by its row's landing time; null while no landed row can be timed. */
  readonly at: number | null;
}

/**
 * When a landed row landed: the time the apply path stamped on it (`landedAt`), or, for a row
 * sent before the stamp was recorded, the first event that carried it; null for such an older
 * row seen only on its work item.
 */
function landingTimeOf(observation: LedgerObservation): number | null {
  const stamped = observation.entry.landedAt;
  return typeof stamped === 'number' && Number.isFinite(stamped) ? stamped : observation.observedAt;
}

/**
 * When the employee's first supervised write landed (the first week's "First supervised write:
 * landed" and Working): the first write ledger row that actually landed, the manager's or its
 * own, never an approval, whose apply may yet fail or wait. A row is dated by its own landing
 * time, so a write carried by a later event, or seen only on its work item (an auto-phase write
 * whose held rest was then rejected), keeps the moment it landed; an older row with no stamp
 * that no event carried has landed with no time.
 */
function firstLandedWriteOf(
  ledger: readonly LedgerObservation[],
  surfaces: readonly SurfaceRecord[],
): FirstLandedWrite {
  const writes = ledger.filter((observation) => isLandedWrite(observation, surfaces));
  const times = writes.flatMap((observation) => {
    const at = landingTimeOf(observation);
    return at === null ? [] : [at];
  });
  return { landed: writes.length > 0, at: times.length > 0 ? Math.min(...times) : null };
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
  const automaticRows = ledger.filter(isAutomaticRow);
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

/**
 * The retrieval figure's tokens half from the documentation each item's prompts carried and the
 * input tokens its model calls were billed (wave 14, 14-R): only items with a selection count.
 */
function retrievalTotals(
  documentationChars: ReadonlyMap<string, number>,
  inputTokens: ReadonlyMap<string, number>,
): Pick<
  PilotTotals,
  'retrievalItems' | 'retrievalChars' | 'tokenItems' | 'billedChars' | 'inputTokens'
> {
  const billed = [...documentationChars].flatMap(([workItemId, chars]) => {
    const tokens = inputTokens.get(workItemId);
    return tokens === undefined ? [] : [{ chars, tokens }];
  });
  return {
    retrievalItems: documentationChars.size,
    retrievalChars: [...documentationChars.values()].reduce((total, chars) => total + chars, 0),
    tokenItems: billed.length,
    billedChars: billed.reduce((total, item) => total + item.chars, 0),
    inputTokens: billed.reduce((total, item) => total + item.tokens, 0),
  };
}

function pilotTotals(
  events: readonly Doc<'events'>[],
  workItems: readonly Doc<'workItems'>[],
): PilotTotals {
  const ordered = [...events].sort(byWriteOrder);
  const firstItemOfSkill = new Map<string, string>();
  const runs = new Set<string>();
  let reused = 0;
  let adopted = 0;
  const standingEnd = new Map<string, number>();
  // The completion each item's answer is read from: the first that did the work, in whole or in
  // part, or the first such since the manager last sent it back (the month's landings read the
  // same one, `landedThisMonth`). Done answers by when they finished; partly done ones named
  // beside them.
  const firstCompletion = new Map<string, number>();
  const completedOnce = new Set<string>();
  const partlyFinished = new Set<string>();
  const discoveredAt = new Map<string, number>();
  let answered = 0;
  let amended = 0;
  const cards = { opened: 0, approved: 0, dismissed: 0, deferred: 0 };
  /** The cards whose newest decision is a deferral, by id. */
  const deferredCards = new Set<string>();
  const documentationChars = new Map<string, number>();
  const inputTokens = new Map<string, number>();
  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const workItemId = asString(payload?.workItemId);
    if (isEventOf(event, 'work.documentation-selected') && workItemId) {
      const chars = typeof payload?.chars === 'number' ? payload.chars : 0;
      documentationChars.set(workItemId, (documentationChars.get(workItemId) ?? 0) + chars);
      continue;
    }
    if (
      isEventOf(event, 'work.model-call') &&
      workItemId &&
      typeof payload?.inputTokens === 'number'
    ) {
      inputTokens.set(workItemId, (inputTokens.get(workItemId) ?? 0) + payload.inputTokens);
      continue;
    }
    if (isEventOf(event, 'work.execution-claimed') && workItemId) {
      const skillId = asString(payload?.skillId);
      if (!skillId || runs.has(`${workItemId}:${skillId}`)) continue;
      runs.add(`${workItemId}:${skillId}`);
      const proposedFor = asString(payload?.proposedFor);
      const first = firstItemOfSkill.get(skillId);
      if (first === undefined) firstItemOfSkill.set(skillId, workItemId);
      // The item a skill was made for decides; a builtin, made for none,
      // is reused from its second item on. An adopted skill was first made
      // for another employee's work, so every run of it is reuse (A14).
      const fromAnother = payload?.skillAdopted === true;
      const reuse =
        fromAnother ||
        (proposedFor !== undefined
          ? proposedFor !== workItemId
          : (first ?? workItemId) !== workItemId);
      if (reuse) reused += 1;
      if (fromAnother) adopted += 1;
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
      // A send-back takes the item's answer back with its end, whatever the answer was: the
      // completion that follows is the one the figures read, as the Work tab reads the item's
      // latest answer (W16-R17's not-done first; the v0.20.0 walk's finding 4, where a partly-done
      // item sent back and finished stayed "1 partly done" on the home beside "Done 3" on the tab).
      completedOnce.delete(workItemId);
      firstCompletion.delete(workItemId);
      partlyFinished.delete(workItemId);
      continue;
    }
    if (isEventType(event.type) && TERMINAL_WORK_EVENTS.has(event.type) && workItemId) {
      if (!standingEnd.has(workItemId)) standingEnd.set(workItemId, event.createdAt);
      if (isEventOf(event, 'work.completed') && !completedOnce.has(workItemId)) {
        // One reading, the run's answer held to its ledger (RM23 (a)): only a done answer is a
        // completion the cycle time measures; a partly done one is named beside it; a not-done
        // one did none of the work, so a completion after it is still the item's answer.
        const answer = finishedAnswerOf(event.payload.output);
        if (answer !== 'not-done') completedOnce.add(workItemId);
        if (answer === 'done') firstCompletion.set(workItemId, event.createdAt);
        else if (answer === 'partial') partlyFinished.add(workItemId);
      }
      continue;
    }
    if (isEventOf(event, 'charter.question-answered')) {
      answered += 1;
      if (payload?.amended === true) amended += 1;
      continue;
    }
    // The reorientation figure counts cards (16-O; A9): a trigger that joined a card is not a card.
    if (isEventOf(event, 'reorientation.opened')) {
      if (payload?.joined !== true) cards.opened += 1;
      continue;
    }
    // A handover closes every standing card with no line of the card's own, a deferred one too.
    if (isEventOf(event, 'manager.transferred')) {
      deferredCards.clear();
      continue;
    }
    const cardId = asString(payload?.reorientationId) ?? '';
    if (isEventOf(event, 'reorientation.deferred')) deferredCards.add(cardId);
    else if (isEventOf(event, 'reorientation.reopened')) deferredCards.delete(cardId);
    else if (isEventOf(event, 'reorientation.approved')) {
      cards.approved += 1;
      deferredCards.delete(cardId);
    } else if (isEventOf(event, 'reorientation.dismissed')) {
      cards.dismissed += 1;
      deferredCards.delete(cardId);
    }
  }
  cards.deferred = deferredCards.size;
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
    adopted,
    toEnd: durations(standingEnd),
    toCompletion: durations(firstCompletion),
    partlyDone: partlyFinished.size,
    answered,
    amended,
    cards,
    estimatedItems: estimates.length,
    estimatedMinutes: estimates.reduce((total, minutes) => total + minutes, 0),
    ...retrievalTotals(documentationChars, inputTokens),
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
  const surfaceRecords = surfaces.map(toSurfaceRecord);
  const firstWrite = firstLandedWriteOf(ledger, surfaceRecords);
  const metrics: AgentMetrics = {
    writeLanded: firstWrite.landed,
    workingSince: firstWrite.at,
    charter: {
      timeToFirstDraftedMs: timeFromDeploy(firstDraftedAt),
      timeToFirstApprovedMs: timeFromDeploy(firstApprovedAt),
      requestChanges: events.filter((event) => isEventOf(event, 'charter.request_changes')).length,
    },
    decisions: summariseDecisions(decisions),
    actions: actionMetrics(events, ledger, surfaceRecords),
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

/**
 * The most employees the one read a card subscribes to covers (`forOwner`): it stays bounded, and
 * says how many it left out. The company's figures over every employee are read by pages
 * (`forOwnerByPages`; wave 17, RM33 (a), F-2), and the recompute reads every trace it is given.
 */
export const MAX_COMPANY_EMPLOYEES = 20;

/** What the company selection reads of an agent, from a row or from a trace. */
export type CompanyAgent = Pick<Doc<'agents'>, '_id' | '_creationTime' | 'userId'>;

/** The employees one owner's company figures cover, and what was left out. */
export interface CompanySelection<Agent extends CompanyAgent = Doc<'agents'>> {
  /** The employees the figures cover, in deploy order. */
  employees: Agent[];
  /** The spans the owner held each employee, by its id: its whole history unless it was handed over (D12). */
  tenures: ReadonlyMap<string, readonly TenureWindow[]>;
  excludedAgents: number;
  omittedEmployees: number;
}

/**
 * Whether an agent row belongs to an evaluation run rather than the company.
 *
 * Match an evaluation name and its reserved address together: an ordinary
 * manager may also have an address beginning with `eval-`. The address is
 * read through the one evaluation-address check and its one spelling
 * (`src/agent/manager-address.ts`), so a row an older release stored in
 * another case still reads as what it is. The revocation trial's driver and
 * manual review beds use different timestamp formats.
 *
 * @param agent - The agent row's boss address, name and arm.
 * @returns True for an evaluation agent.
 */
export function isEvaluationAgent(
  agent: Pick<Doc<'agents'>, 'bossEmail' | 'name' | 'arm'>,
): boolean {
  if (agent.arm === 'baseline') return true;
  const address = normaliseManagerAddress(agent.bossEmail);
  if (address === undefined || !isEvaluationShapedAddress(address)) return false;
  if (agent.name === 'Day0 revocation evaluation') {
    return address.startsWith('eval-revocation-');
  }
  return (
    /^Day0 evaluation [1-9]\d*$/.test(agent.name) &&
    /^eval-day0-r[1-9]\d*-\d{13}@day0\.local$/.test(address)
  );
}

function byDeployOrder(left: CompanyAgent, right: CompanyAgent): number {
  return left._creationTime - right._creationTime || (left._id < right._id ? -1 : 1);
}

/**
 * The employees one owner's company figures cover.
 *
 * An employee counts toward each owner who held it, within that owner's
 * spans (D12 (a)): one never handed over is wholly its owner's, and one
 * handed over is its old owner's up to the acceptance and its new owner's
 * from it, so the old owner's past figures never change after the fact.
 * Employees the owner never held, evaluation agents and baseline arms are
 * left out. With no `limit`, every employee is kept: the recompute reads
 * every trace it is given (RM33 (a)). With one, of those the owner holds now
 * the most recent `limit` are kept, and of those it handed over the most
 * recent as many again, so a departure never takes the place of an employee
 * it holds; the older ones are counted as omitted, so a read that is bounded
 * is never silent about it. The query and the recompute script both select
 * through here.
 *
 * @param agents - Agent rows, in any order: the owner's own and any it handed over; rows the
 *   owner never held are ignored.
 * @param owner - The owner's key.
 * @param isEvaluation - How an evaluation agent is told: by its row's reserved address, or by
 *   the flag a trace carries instead of the address.
 * @param handovers - The accepted handovers of those agents; none reads every agent as never
 *   handed over.
 * @param limit - The most employees of each kind a bounded read keeps; none keeps them all.
 * @returns The employees in deploy order, the spans the owner held each, and the counts left out.
 */
export function selectCompanyEmployees<Agent extends CompanyAgent>(
  agents: readonly Agent[],
  owner: string,
  isEvaluation: (agent: Agent) => boolean,
  handovers: readonly AcceptedHandover[] = [],
  limit?: number,
): CompanySelection<Agent> {
  const held = agents.flatMap((agent) => {
    const own = handovers.filter((handover) => handover.agentId === agent._id);
    const windows = tenureWindowsOf(owner, agent.userId, own);
    return windows.length > 0 ? [{ agent, windows }] : [];
  });
  const company = held
    .filter(({ agent }) => !isEvaluation(agent))
    .sort((left, right) => byDeployOrder(left.agent, right.agent));
  const holdsNow = ({ windows }: (typeof company)[number]): boolean =>
    windows.some((window) => window.until === null);
  const mostRecent = (employees: typeof company): typeof company =>
    limit === undefined ? employees : employees.slice(Math.max(0, employees.length - limit));
  const kept = [
    ...mostRecent(company.filter(holdsNow)),
    ...mostRecent(company.filter((employee) => !holdsNow(employee))),
  ].sort((left, right) => byDeployOrder(left.agent, right.agent));
  return {
    employees: kept.map(({ agent }) => agent),
    tenures: new Map(kept.map(({ agent, windows }) => [agent._id, windows])),
    excludedAgents: held.length - company.length,
    omittedEmployees: company.length - kept.length,
  };
}

/**
 * One employee's figures from its records, with the lists a company figure pools.
 *
 * @param record - The employee's durable records, already cut to the reader's spans.
 */
export function employeeFiguresOf(record: EmployeeRecords): EmployeeFigures {
  return {
    agent: record.agent,
    ...agentFigures(record.events, record.workItems, record.charters, record.surfaces ?? []),
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
  return companyMetricsOf(records.map(employeeFiguresOf), setAside);
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

/**
 * One employee's figures as the manager who holds it now reads them on its page. The decisions,
 * which the page says the reader made, count within the spans that manager held it (D12 (a), the
 * cut the company figure makes), so a handover never credits the new manager with the old one's
 * (the v0.13.0 walk). Everything else describes the employee and counts over its whole record.
 *
 * @param records - The employee's whole records.
 * @param handovers - The employee's accepted handovers, in any order.
 * @param currentOwner - The employee's owner now, the reader; with none, nothing is cut.
 */
export function figuresForCurrentManager(
  records: EmployeeRecords,
  handovers: readonly AcceptedHandover[],
  currentOwner: string | undefined,
): AgentMetrics {
  const { events, workItems, charters, surfaces = [] } = records;
  const whole = computeAgentMetrics(events, workItems, charters, surfaces);
  if (currentOwner === undefined) return whole;
  const windows = tenureWindowsOf(currentOwner, currentOwner, handovers);
  if (isWholeHistory(windows)) return whole;
  if (windows.length === 0) {
    // The owner now holds no span of its own handovers: the rows disagree, so nothing is cut
    // rather than every decision dropped.
    log.warn('an employee page read by an owner its handovers never name', {
      agentId: records.agent._id,
      handovers: handovers.length,
    });
    return whole;
  }
  const held = recordsWithinTenure(records, windows);
  return { ...whole, decisions: summariseDecisions(decisionTotals(held.events, held.workItems)) };
}

/** The events that start a manager's wait on a decision, which a decision made later is timed from. */
const WAIT_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'work.decision-requesting',
  'work.plan-drafted',
  'work.actions-pending',
]);

/**
 * One employee's records of one day in its zone (N12): the events logged from that day's
 * midnight to the next, and the earlier asks of the decisions made that day, so a plan asked
 * yesterday and approved today counts once, today, and its wait from the ask. The work rows are
 * read as a closed span reads them ({@link recordsWithinTenure}): their ledgers only from the
 * day's events, and their own decision records not at all, which the events already carry.
 *
 * @param records - The employee's records, already cut to the reader's spans.
 * @param day - The day, `YYYY-MM-DD`.
 * @param zone - The employee's zone.
 */
export function recordsOfDay(records: EmployeeRecords, day: string, zone: string): EmployeeRecords {
  const from = dayStart(day, zone);
  const until = dayStart(addDays(day, 1), zone);
  const ofDay = records.events.filter(
    (event) => event.createdAt >= from && event.createdAt < until,
  );
  const decidedOnDay = new Set(
    ofDay.flatMap((event) => {
      const result = decisionResult(event);
      return result === undefined ? [] : [result.workItemId];
    }),
  );
  return {
    ...records,
    events: [...asksStillOpen(records.events, from, decidedOnDay), ...ofDay],
    workItems: records.workItems.map(
      (item): Doc<'workItems'> => ({
        ...item,
        output: undefined,
        decision: undefined,
        manualEstimateMinutes: undefined,
      }),
    ),
    charters: [],
  };
}

/**
 * The asks of the items decided on a day that were still open at its start (W16-R16): for each item
 * and kind, the requests no decision or redraft before the day closed, oldest first as
 * `decisionTotals` pairs them, and the start of the wait where one is still running. Carrying every
 * earlier ask paired the day's decision with an ask an earlier decision had already answered, so a
 * re-asked decision read days long.
 *
 * @param events - The employee's records' events.
 * @param from - The day's start.
 * @param decided - The items decided on the day.
 */
function asksStillOpen(
  events: readonly Doc<'events'>[],
  from: number,
  decided: ReadonlySet<string>,
): Doc<'events'>[] {
  const open = new Map<string, { requests: Doc<'events'>[]; wait?: Doc<'events'> }>();
  for (const event of [...events].sort(byWriteOrder)) {
    if (event.createdAt >= from) continue;
    const payload = asRecord(event.payload);
    const workItemId = asString(payload?.workItemId);
    if (workItemId === undefined || !decided.has(workItemId)) continue;
    if (isEventOf(event, 'work.plan-redrafting')) {
      // A redraft withdraws every plan ask that was open.
      open.delete(`${workItemId}:plan`);
      continue;
    }
    const result = decisionResult(event);
    if (result !== undefined) {
      // A decision answers the oldest request, as the fold pairs them, and ends the wait.
      const key = `${workItemId}:${result.kind}`;
      const requests = (open.get(key)?.requests ?? []).slice(1);
      if (requests.length === 0) open.delete(key);
      else open.set(key, { requests });
      continue;
    }
    if (!isEventType(event.type) || !WAIT_EVENTS.has(event.type)) continue;
    if (isEventOf(event, 'work.decision-requesting')) {
      const kind = payload?.kind;
      // A resend after an undelivered DM is the same ask as the request it supersedes.
      if ((kind !== 'plan' && kind !== 'actions') || asString(payload?.supersedes) !== undefined) {
        continue;
      }
      const key = `${workItemId}:${kind}`;
      const ask = open.get(key) ?? { requests: [] };
      open.set(key, { ...ask, requests: [...ask.requests, event] });
      continue;
    }
    // Only a set holding something for the manager starts a wait, as the fold reads it.
    const held = isEventOf(event, 'work.actions-pending');
    if (held && asIndexes(payload?.heldIndexes).length === 0) continue;
    const key = `${workItemId}:${held ? 'actions' : 'plan'}`;
    open.set(key, { requests: open.get(key)?.requests ?? [], wait: event });
  }
  return [...open.values()].flatMap((ask) => [
    ...(ask.wait === undefined ? [] : [ask.wait]),
    ...ask.requests,
  ]);
}

/** A day as the page names it, `YYYY-MM-DD`, that is a day of the calendar. */
function isDayKey(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && addDays(day, 0) === day;
}

/**
 * The last day a day's figures are read for: the day before the last a day key can name, since a
 * day is counted to the start of the day after it (W16-R32).
 */
const LAST_COUNTED_DAY = '9999-12-30';

/**
 * Why a day argument is refused, in the words the page shows, or undefined for a day the figures
 * can count: a day of the calendar whose next day has a name.
 *
 * @param day - The day as the caller named it.
 */
export function dayRefusal(day: string): string | undefined {
  if (!isDayKey(day)) return `${day} is not a day; name it as YYYY-MM-DD`;
  if (day > LAST_COUNTED_DAY) return `${day} is past the last day Day0 counts; name an earlier day`;
  return undefined;
}

/**
 * Public, the employee's owner only (`assertOwnsAgent`): the employee's supervision figures, its
 * decisions counted within the spans the caller held it ({@link figuresForCurrentManager}). With
 * `day`, the employee's own today as its page reads it (16-F), the figures of that day in the
 * employee's zone beside them, under `today`. Writes nothing.
 */
export const forAgent = query({
  args: { agentId: v.id('agents'), day: v.optional(v.string()) },
  handler: async (ctx, args): Promise<AgentMetrics> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    // The guard first: a caller it refuses learns nothing of the arguments (12-G).
    const { day } = args;
    const refusal = day === undefined ? undefined : dayRefusal(day);
    if (refusal !== undefined) throw new ConvexError(refusal);
    const [records, transfers] = await Promise.all([
      readEmployeeRecords(ctx, agent),
      acceptedTransfersOf(ctx, agent._id),
    ]);
    // The guard has proved the caller owns the employee, so the row's owner is the reader.
    const handovers = handoversFromTransfers(transfers);
    const figures = figuresForCurrentManager(records, handovers, agent.userId);
    if (day === undefined) return figures;
    // The day's decisions are the reader's as the whole record's are: within the spans it held
    // the employee, or the whole record where the rows name no span of its own.
    const held =
      agent.userId === undefined ? [] : tenureWindowsOf(agent.userId, agent.userId, handovers);
    const windows = held.length > 0 ? held : [WHOLE_HISTORY];
    const ofDay = computeAgentMetrics(
      ...recordsArgs(recordsOfDay(recordsWithinTenure(records, windows), day, agentZone(agent))),
    );
    return { ...figures, today: { day, decisions: ofDay.decisions, actions: ofDay.actions } };
  },
});

/** One employee's records as `computeAgentMetrics` takes them. */
function recordsArgs(records: EmployeeRecords): Parameters<typeof computeAgentMetrics> {
  return [records.events, records.workItems, records.charters, records.surfaces ?? []];
}

/**
 * One employee's records within the spans one owner held it (D12 (a)).
 *
 * The events are the dated record, so each counts toward the owner whose
 * span holds its `createdAt`; a charter counts its draft and its approval
 * the same way. A work row counts toward the span it was created in. In the
 * span that runs to now it is read as it is; in a span that has closed it is
 * read as that span left it, because the next owner may go on working it:
 * its ledger and its decision are taken from the span's events alone, and
 * its estimate counts only when the row was completed within the span. So
 * nothing the next owner does reaches the old owner's figures, and nothing
 * the old owner did leaves them. The surfaces only tell a manager DM from a
 * write and pass through. An employee never handed over keeps every record,
 * as before.
 *
 * @param records - The employee's whole records.
 * @param windows - The owner's spans, from {@link selectCompanyEmployees}.
 * @returns The records the owner's figures count.
 */
export function recordsWithinTenure(
  records: EmployeeRecords,
  windows: readonly TenureWindow[],
): EmployeeRecords {
  if (isWholeHistory(windows)) return records;
  const within = (at: number): boolean => isWithinTenure(at, windows);
  const events = records.events.filter((event) => within(event.createdAt));
  const completedWithin = new Set(
    events
      .filter((event) => isEventOf(event, 'work.completed'))
      .flatMap((event) => asString(asRecord(event.payload)?.workItemId) ?? []),
  );
  const workItems = records.workItems.flatMap((item): Doc<'workItems'>[] => {
    const span = windows.find((window) => isWithinTenure(item.createdAt, [window]));
    if (span === undefined) return [];
    if (span.until === null) return [item];
    const completed = completedWithin.has(item._id);
    return [
      {
        ...item,
        state: completed ? 'completed' : item.state,
        output: undefined,
        decision: undefined,
        manualEstimateMinutes: completed ? item.manualEstimateMinutes : undefined,
      },
    ];
  });
  return {
    ...records,
    events,
    workItems,
    charters: records.charters
      .filter((charter) => within(charter.createdAt))
      .map((charter) =>
        charter.approvedAt === undefined || within(charter.approvedAt)
          ? charter
          : { ...charter, approvedAt: undefined },
      ),
  };
}

/** The states of a request the named manager has accepted: moved, or waiting for runs in flight. */
const ACCEPTED_TRANSFER_STATES = ['accepting', 'accepted'] as const;

/**
 * The handovers the figures cut an employee's history at, from its
 * `managerTransfers` rows: every accepted request, moved or still waiting for
 * its runs in flight, cut at its acceptance (`decidedAt`). A row in another
 * state is no handover. An accepted row without its acceptance time or the
 * acceptor's key cannot be placed; it is left out and logged.
 *
 * @param rows - Request rows of any employees, in any state.
 */
export function handoversFromTransfers(
  rows: readonly Doc<'managerTransfers'>[],
): AcceptedHandover[] {
  return rows.flatMap((row): AcceptedHandover[] => {
    if (row.state !== 'accepting' && row.state !== 'accepted') return [];
    if (row.toOwnerKey === undefined || row.decidedAt === undefined) {
      log.warn('an accepted handover without its acceptance is left out of the figures', {
        transferId: row._id,
        state: row.state,
      });
      return [];
    }
    return [
      {
        agentId: row.agentId,
        fromOwnerKey: row.fromOwnerKey,
        toOwnerKey: row.toOwnerKey,
        acceptedAt: row.decidedAt,
      },
    ];
  });
}

/** One employee's accepted requests, moved or waiting for runs in flight. */
async function acceptedTransfersOf(
  ctx: QueryCtx,
  agentId: Doc<'agents'>['_id'],
): Promise<Doc<'managerTransfers'>[]> {
  const byState = await Promise.all(
    ACCEPTED_TRANSFER_STATES.map(
      async (state) =>
        await ctx.db
          .query('managerTransfers')
          .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
          .collect(),
    ),
  );
  return byState.flat();
}

/**
 * The employees an owner's figures may count: those it owns now and those it
 * handed over that still exist, with the accepted handovers of each. A handed
 * over employee since retired has no records left and is not among them; an
 * evaluation employee is never handed over, so none of its requests is read.
 */
async function heldEmployees(
  ctx: QueryCtx,
  owner: string,
): Promise<{ agents: Doc<'agents'>[]; handovers: AcceptedHandover[] }> {
  // Unbounded like the company's own employee read before it: an owner's accepted requests are
  // one per employee it handed over, each of them one employee it once deployed or took on.
  const [owned, ...given] = await Promise.all([
    ctx.db
      .query('agents')
      .withIndex('by_userId', (q) => q.eq('userId', owner))
      .collect(),
    ...ACCEPTED_TRANSFER_STATES.map(
      async (state) =>
        await ctx.db
          .query('managerTransfers')
          .withIndex('by_from_owner_state', (q) => q.eq('fromOwnerKey', owner).eq('state', state))
          .collect(),
    ),
  ]);
  const ownedIds = new Set<string>(owned.map((agent) => agent._id));
  const departedIds = [...new Set(given.flat().map((row) => row.agentId))].filter(
    (agentId) => !ownedIds.has(agentId),
  );
  const departed = (
    await Promise.all(departedIds.map(async (agentId) => await ctx.db.get(agentId)))
  ).filter((agent): agent is Doc<'agents'> => agent !== null);
  const agents = [...owned, ...departed];
  const rows = await Promise.all(
    agents
      .filter((agent) => !isEvaluationAgent(agent))
      .map(async (agent) => await acceptedTransfersOf(ctx, agent._id)),
  );
  return { agents, handovers: handoversFromTransfers(rows.flat()) };
}

/**
 * Public, any signed-in caller; reads only the caller's own: the supervision figures of
 * the caller's company, each employee's own figures and the company row, each
 * employee counted within the spans the caller held it (D12 (a)). Bounded, so a card can
 * subscribe to it: it covers the most recent `MAX_COMPANY_EMPLOYEES` employees and says how many
 * it left out (`omittedEmployees`); `forOwnerByPages` reads them all. Writes
 * nothing. A caller with no identity is refused (`getCallerOrThrow`, 12-G).
 */
export const forOwner = query({
  args: {},
  handler: async (ctx): Promise<OwnerMetrics> => {
    const identity = await getCallerOrThrow(ctx);
    const { agents, handovers } = await heldEmployees(ctx, identity.ownerKey);
    const selection = selectCompanyEmployees(
      agents,
      identity.ownerKey,
      isEvaluationAgent,
      handovers,
      MAX_COMPANY_EMPLOYEES,
    );
    const records = await Promise.all(
      selection.employees.map(async (agent) =>
        recordsWithinTenure(
          await readEmployeeRecords(ctx, agent),
          selection.tenures.get(agent._id) ?? [],
        ),
      ),
    );
    return computeCompanyMetrics(records, selection);
  },
});

/** How many employees' whole records one page of the company's figures reads. */
const COMPANY_PAGE_EMPLOYEES = 5;

/**
 * The walk of an owner's employees for the figures by pages: those it holds now, in deploy
 * order, then those it handed over, by the state of the request that moved each.
 */
const FIGURES_PHASES = ['held', ...ACCEPTED_TRANSFER_STATES] as const;

/** Where the walk stands: the phase, and the backend's cursor inside it. */
interface FiguresCursor {
  readonly phase: (typeof FIGURES_PHASES)[number];
  readonly cursor: string | null;
}

/** One page of the company's figures: each employee read, in the order read, and what follows. */
interface OwnerFiguresPage {
  /** Each employee's figures, with the row's creation time, which orders the whole company. */
  readonly employees: ReadonlyArray<EmployeeFigures & { readonly creationTime: number }>;
  /** The evaluation agents and baseline arms the page passed over. */
  readonly excludedAgents: number;
  /** Where the next page starts, or null after the last. */
  readonly next: string | null;
}

/** A figures cursor read back from the string a page handed out. */
function figuresCursorOf(cursor: string | null): FiguresCursor {
  if (cursor === null) return { phase: 'held', cursor: null };
  const parsed = JSON.parse(cursor) as Partial<FiguresCursor>;
  const phase = FIGURES_PHASES.find((candidate) => candidate === parsed.phase);
  if (phase === undefined || (parsed.cursor !== null && typeof parsed.cursor !== 'string')) {
    throw new Error('not a cursor of the company’s figures');
  }
  return { phase, cursor: parsed.cursor };
}

/** The cursor of the page after one: further into its phase, the next phase, or the end. */
function figuresCursorAfter(
  at: FiguresCursor,
  read: { readonly isDone: boolean; readonly continueCursor: string },
): string | null {
  if (!read.isDone) return JSON.stringify({ phase: at.phase, cursor: read.continueCursor });
  const following = FIGURES_PHASES[FIGURES_PHASES.indexOf(at.phase) + 1];
  return following === undefined ? null : JSON.stringify({ phase: following, cursor: null });
}

/**
 * One employee's figures within the spans an owner held it (D12 (a)), or undefined for an
 * employee the owner never held.
 */
async function employeeFiguresWithin(
  ctx: QueryCtx,
  owner: string,
  agent: Doc<'agents'>,
): Promise<OwnerFiguresPage['employees'][number] | undefined> {
  const handovers = handoversFromTransfers(await acceptedTransfersOf(ctx, agent._id));
  const windows = tenureWindowsOf(owner, agent.userId, handovers);
  if (windows.length === 0) return undefined;
  const records = recordsWithinTenure(await readEmployeeRecords(ctx, agent), windows);
  return { ...employeeFiguresOf(records), creationTime: agent._creationTime };
}

/**
 * One page of the figures of the caller's company (wave 17, 17-F; RM33 (a), F-2): at most
 * `COMPANY_PAGE_EMPLOYEES` employees' whole records, each counted within the spans the caller
 * held it, with the lists a company figure pools. The employees the caller holds now come first,
 * in deploy order; then those it handed over that still exist, an employee it holds again left to
 * the first walk. Internal; `forOwnerByPages` runs it under the caller's identity, and every
 * read is keyed by the caller's own owner key. Reads; writes nothing.
 */
export const ownerFiguresPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<OwnerFiguresPage> => {
    const { ownerKey } = await getCallerOrThrow(ctx);
    const at = figuresCursorOf(args.cursor);
    const paging = { cursor: at.cursor, numItems: COMPANY_PAGE_EMPLOYEES };
    if (at.phase === 'held') {
      const read = await ctx.db
        .query('agents')
        .withIndex('by_userId', (q) => q.eq('userId', ownerKey))
        .paginate(paging);
      const company = read.page.filter((agent) => !isEvaluationAgent(agent));
      const figures = await Promise.all(
        company.map(async (agent) => await employeeFiguresWithin(ctx, ownerKey, agent)),
      );
      return {
        employees: figures.filter((employee) => employee !== undefined),
        excludedAgents: read.page.length - company.length,
        next: figuresCursorAfter(at, read),
      };
    }
    const phase = at.phase;
    const read = await ctx.db
      .query('managerTransfers')
      .withIndex('by_from_owner_state', (q) => q.eq('fromOwnerKey', ownerKey).eq('state', phase))
      .paginate(paging);
    const departed = await Promise.all(
      [...new Set(read.page.map((row) => row.agentId))].map(
        async (agentId) => await ctx.db.get(agentId),
      ),
    );
    const figures = await Promise.all(
      departed
        // Retired since, held again by the caller (the first walk's), or never the company's.
        .filter(
          (agent): agent is Doc<'agents'> =>
            agent !== null && agent.userId !== ownerKey && !isEvaluationAgent(agent),
        )
        .map(async (agent) => await employeeFiguresWithin(ctx, ownerKey, agent)),
    );
    return {
      employees: figures.filter((employee) => employee !== undefined),
      excludedAgents: 0,
      next: figuresCursorAfter(at, read),
    };
  },
});

/**
 * Public, any signed-in caller; reads only the caller's own: the supervision figures of the
 * caller's whole company, every employee read by pages (wave 17, 17-F; RM33 (a), F-2), where
 * `forOwner` covers the most recent twenty. The action carries the cursor from page to page and
 * pools once every page is in, with the pooling `forOwner` and the recompute take, so the three
 * agree; no query subscribes to every employee's whole record. Each employee is counted within
 * the spans the caller held it (D12 (a)), once however often the walk meets it. Each page is a
 * read of its own, so the answer is no one instant's: an employee handed to the caller after the
 * walk passed the employees it holds is in the next read, not this one. Writes nothing. A caller
 * with no identity is refused (`getCallerOrThrow`, 12-G).
 */
export const forOwnerByPages = action({
  args: {},
  handler: async (ctx): Promise<OwnerMetrics> => {
    await getCallerOrThrow(ctx);
    const read = new Map<string, OwnerFiguresPage['employees'][number]>();
    let excludedAgents = 0;
    let cursor: string | null = null;
    do {
      const page: OwnerFiguresPage = await ctx.runQuery(internal.metrics.ownerFiguresPage, {
        cursor,
      });
      for (const employee of page.employees) read.set(employee.agent._id, employee);
      excludedAgents += page.excludedAgents;
      cursor = page.next;
    } while (cursor !== null);
    const inDeployOrder = [...read.values()].sort(
      (left, right) =>
        left.creationTime - right.creationTime || (left.agent._id < right.agent._id ? -1 : 1),
    );
    return companyMetricsOf(
      inDeployOrder.map(({ agent, metrics, decisions, pilot }) => ({
        agent,
        metrics,
        decisions,
        pilot,
      })),
      { excludedAgents, omittedEmployees: 0 },
    );
  },
});

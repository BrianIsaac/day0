/**
 * The apply's ledger as it is written, one row at a time (P4-2).
 *
 * An apply sends its approved actions one after another and used to hand its
 * whole ledger over only at the end, so a throw, a dead action or a Stop part
 * way lost what had already landed: the recovery marked every approved row's
 * outcome unknown, including the ones that had answered a moment before. Each
 * row is now reported as soon as it is decided and kept on the work item's
 * output under the apply's claim, and the recovery reads it back: a row that
 * reported stays as it reported, and only a row that never did is unknown.
 */

import type { ActionAuthority, ActionClass, AppliedAction } from '../surfaces/types';

/** One row of an apply in flight, as it is reported: what the recovery needs of the ledger row. */
export interface ReportedRow {
  readonly tool: string;
  readonly idempotencyKey: string;
  readonly ok: boolean;
  readonly held?: boolean;
  readonly outcomeUnknown?: boolean;
  readonly awaitingApproval?: boolean;
  readonly effect?: string;
  readonly reason?: string;
  readonly providerId?: string;
  readonly landedAt?: number;
  readonly authority?: ActionAuthority;
  readonly actionClass?: ActionClass;
  readonly redaction?: 'structural-only';
}

/** A reported row as it is kept, with its index in the phase's actions. */
export interface PersistedOutcome extends ReportedRow {
  readonly index: number;
}

/** The rows one apply attempt has reported so far, kept on the work item's output. */
export interface ApplyProgress {
  /** The apply claim (`applyAttemptId`) the rows belong to. */
  readonly attemptId: string;
  readonly outcomes: readonly PersistedOutcome[];
}

/** The key of the output field that holds the apply in flight's rows. */
export const APPLY_PROGRESS_KEY = 'applyProgress';

/**
 * The row an apply reports, cut to what is kept while the apply runs.
 *
 * The browser floor's element names, its session replay and a repair's refused
 * arguments are left out: the finished ledger carries them, and a recovered
 * one only needs to say what reached the provider.
 *
 * @param row - The ledger row, already scrubbed of the owner's values.
 */
export function reportedRow(row: AppliedAction): ReportedRow {
  return {
    tool: row.tool,
    idempotencyKey: row.idempotencyKey,
    ok: row.ok,
    ...(row.held !== undefined ? { held: row.held } : {}),
    ...(row.outcomeUnknown !== undefined ? { outcomeUnknown: row.outcomeUnknown } : {}),
    ...(row.awaitingApproval !== undefined ? { awaitingApproval: row.awaitingApproval } : {}),
    ...(row.effect !== undefined ? { effect: row.effect } : {}),
    ...(row.reason !== undefined ? { reason: row.reason } : {}),
    ...(row.providerId !== undefined ? { providerId: row.providerId } : {}),
    ...(row.landedAt !== undefined ? { landedAt: row.landedAt } : {}),
    ...(row.authority !== undefined ? { authority: row.authority } : {}),
    ...(row.actionClass !== undefined ? { actionClass: row.actionClass } : {}),
    ...(row.redaction !== undefined ? { redaction: row.redaction } : {}),
  };
}

/**
 * The output with one more reported row of the attempt, replacing an earlier report of the same
 * index (a repaired read reports again). Rows of an earlier attempt are dropped.
 *
 * @param output - The work item's output as stored.
 * @param attemptId - The apply claim the row belongs to.
 * @param outcome - The row.
 */
export function withReportedOutcome(
  output: unknown,
  attemptId: string,
  outcome: PersistedOutcome,
): Record<string, unknown> {
  const base = (output ?? {}) as Record<string, unknown>;
  const kept = applyProgressOf(base, attemptId)?.outcomes ?? [];
  const progress: ApplyProgress = {
    attemptId,
    outcomes: [...kept.filter((row) => row.index !== outcome.index), outcome],
  };
  return { ...base, [APPLY_PROGRESS_KEY]: progress };
}

/**
 * The rows an attempt reported, when the output holds that attempt's progress.
 *
 * @param output - The work item's output as stored.
 * @param attemptId - The apply claim to read; another attempt's rows are not this one's.
 */
export function applyProgressOf(output: unknown, attemptId: string): ApplyProgress | undefined {
  const progress = (output as { [APPLY_PROGRESS_KEY]?: unknown } | undefined)?.[APPLY_PROGRESS_KEY];
  if (typeof progress !== 'object' || progress === null) return undefined;
  const { attemptId: kept, outcomes } = progress as { attemptId?: unknown; outcomes?: unknown };
  if (kept !== attemptId || !Array.isArray(outcomes)) return undefined;
  return progress as ApplyProgress;
}

/**
 * The ledger rows an attempt reported, by index, as ledger rows again.
 *
 * @param output - The work item's output as stored.
 * @param attemptId - The apply claim to read.
 */
export function reportedRows(output: unknown, attemptId: string): Map<number, AppliedAction> {
  const rows = new Map<number, AppliedAction>();
  for (const { index, ...row } of applyProgressOf(output, attemptId)?.outcomes ?? []) {
    rows.set(index, row);
  }
  return rows;
}

/**
 * The output without an apply's progress, once its ledger is written in full.
 *
 * @param output - The work item's output as stored.
 */
export function withoutApplyProgress(output: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(output).filter(([key]) => key !== APPLY_PROGRESS_KEY));
}

import type { MockAction } from '../work/types';
import { actionIntent, parseSurfaceAction } from './policy';
import type { AppliedAction, SurfaceRecord } from './types';

/**
 * Evidence taken again when a retry resumes at the closing phase.
 *
 * A resumed closing set is authored from the prerequisite ledger the failed
 * attempt left, and on 17 September that ledger's tile read was four minutes
 * old: REVOPS-7 had saved 74% since, and the reply quoted 68%. Before the
 * closing phase is prepared, the carried reads are applied again under the
 * new run and replace the rows they re-read.
 */

/** A re-read on resume that did not land, with the rows the attempt recorded. */
export interface FailedReread {
  reason: string;
  at: number;
  /** The reads attempted, and each one's ledger row, the replay that preceded it nested in it. */
  actions: MockAction[];
  applied: AppliedAction[];
}

function landed(row: AppliedAction | undefined): row is AppliedAction {
  return row?.ok === true && row.held !== true && row.awaitingApproval !== true;
}

/**
 * The carried reads a resumed closing phase takes again: every landed read,
 * except that on a browser-driven surface only the last `browser_snapshot`
 * is. That snapshot is the page the run left, the page a replayed sign-in and
 * last navigate open again; an earlier snapshot was of a page the replay does
 * not reach, and a navigate or hover is only the way to the page.
 *
 * Args:
 *   actions: The carried prerequisite actions.
 *   applied: Their ledger rows, index-aligned.
 *   surfaces: The agent's surfaces, to tell a browser-driven one.
 *
 * Returns:
 *   The indexes to read again, in ledger order.
 */
export function carriedReadIndexes(
  actions: readonly MockAction[],
  applied: readonly (AppliedAction | undefined)[],
  surfaces: readonly SurfaceRecord[],
): number[] {
  const reads: number[] = [];
  const lastSnapshot = new Map<string, number>();
  actions.forEach((action, index): void => {
    if (!landed(applied[index])) return;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || actionIntent(parsed.action) !== 'read') return;
    const surface = surfaces.find((row) => row.slug === parsed.action.surface);
    if (surface?.path !== 'browser-driven') {
      reads.push(index);
      return;
    }
    if (parsed.action.kind === 'mcp.call' && parsed.action.tool === 'browser_snapshot') {
      lastSnapshot.set(surface.slug, index);
    }
  });
  return [...reads, ...lastSnapshot.values()].sort((a, b) => a - b);
}

/**
 * The stop reason for a carried read that could not be taken again.
 *
 * Args:
 *   surface: The surface the read was of, or several joined.
 *   reason: Why it did not land.
 *
 * Returns:
 *   The reason the run stops with.
 */
export function rereadStopReason(surface: string, reason: string): string {
  return `could not re-read ${surface} before the closing set: ${reason}`;
}

/**
 * The carried ledger with each re-read in place of the row it re-read, or
 * the first re-read that did not land.
 *
 * Args:
 *   carried: The resumed prerequisite ledger.
 *   rows: The re-read invocation's ledger, index-aligned with the carried actions.
 *   indexes: The indexes that were read again.
 *   at: When they were read again.
 *
 * Returns:
 *   The refreshed ledger, or the failure with every row the attempt recorded.
 */
export function withRereads(
  carried: { actions: readonly MockAction[]; applied: readonly AppliedAction[] },
  rows: readonly AppliedAction[],
  indexes: readonly number[],
  at: number,
): { ok: true; applied: AppliedAction[] } | { ok: false; failed: FailedReread } {
  const applied = [...carried.applied];
  for (const index of indexes) {
    const previous = carried.applied[index]!;
    applied[index] = {
      ...rows[index]!,
      refreshed: {
        previous: {
          ...(previous.effect !== undefined ? { effect: previous.effect } : {}),
          idempotencyKey: previous.idempotencyKey,
        },
        at,
      },
    };
  }
  const failedIndex = indexes.find((index) => !landed(applied[index]));
  if (failedIndex === undefined) return { ok: true, applied };
  const action = carried.actions[failedIndex]!;
  const parsed = parseSurfaceAction(action);
  const surface = parsed.ok ? parsed.action.surface : String(action.args.surface ?? action.tool);
  const row = applied[failedIndex]!;
  return {
    ok: false,
    failed: {
      reason: rereadStopReason(surface, row.reason ?? 'the read did not land'),
      at,
      actions: indexes.map((index) => carried.actions[index]!),
      applied: indexes.map((index) => applied[index]!),
    },
  };
}

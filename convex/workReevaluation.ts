import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { AWAITING_CHARTER, scheduleNextStep } from './workLoop';
import {
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
  SCOPE_JUDGEMENT_UNAVAILABLE,
} from '../src/work/types';
import { missingSurfaceResolvedBy } from '../src/surfaces/identity';
import { appendEvent } from './eventLog';

/*
 * Re-evaluation of parked work (the wave 14 review's D-6, the standard's 9.2): a policy change, a
 * connecting surface or a released claim sends the skipped and deferred rows whose verdict read it
 * back for a fresh evaluation, once per change key; moved out of `convex/work.ts` unchanged. Its
 * continuation is still scheduled as `work:reevaluatePending`, which stays registered in
 * `convex/work.ts`. This module sits below `convex/work.ts`: `convex/work.ts` imports it and it
 * never imports `./work`, so the move closes no import cycle. It registers no function.
 */

/** Parked rows examined per state in one re-evaluation call; the rest continue by schedule. */
export const REEVALUATION_BATCH = 100;

/**
 * What changed, for a re-evaluation of the work parked under the old policy.
 * `claim-released` is a colleague letting go of an item this employee was
 * refused; its key is the released claim's id.
 */
export type ReevaluationTrigger = 'charter' | 'documentation' | 'surface' | 'claim-released';

/**
 * The most re-admission keys a row remembers. Four kinds of change stamp a
 * row (a policy change, a connecting surface, the verdict write and Check for
 * new work, a registered skill); a row that has been sent back more often
 * than this forgets its oldest key, and that change could buy it one more
 * evaluation, never a loop.
 */
export const SPENT_REEVALUATION_KEYS = 16;

/**
 * Whether a change has already sent a row back for a fresh evaluation.
 *
 * Args:
 *   row: The work item.
 *   key: The idempotency key of the change.
 *
 * Returns:
 *   True when the key is among those the row has spent.
 */
export function reevaluationSpent(
  row: Pick<Doc<'workItems'>, 'reevaluation'>,
  key: string,
): boolean {
  const stamp = row.reevaluation;
  return stamp !== undefined && (stamp.key === key || (stamp.spent ?? []).includes(key));
}

/**
 * The stamp of a re-admission, carrying the keys the row spent before it.
 *
 * Each of the four stampers has a once-per-change bound keyed on the row.
 * One key would let a re-admission of another kind between two visits reset
 * that bound, so the stamp keeps them all, newest last and bounded.
 *
 * Args:
 *   row: The work item as it stands.
 *   trigger: What sent it back.
 *   key: The idempotency key of the change.
 *   at: When.
 *
 * Returns:
 *   The `reevaluation` record to store.
 */
export function reevaluationStamp(
  row: Pick<Doc<'workItems'>, 'reevaluation'>,
  trigger: string,
  key: string,
  at: number,
): NonNullable<Doc<'workItems'>['reevaluation']> {
  const before = row.reevaluation ? (row.reevaluation.spent ?? [row.reevaluation.key]) : [];
  const spent = [...before.filter((entry) => entry !== key), key].slice(-SPENT_REEVALUATION_KEYS);
  return { trigger, key, at, spent };
}

/** What a re-evaluation of the parked and skipped rows takes: the employee, the trigger and its key. */
export interface ReevaluatePendingArgs {
  agentId: Id<'agents'>;
  trigger: ReevaluationTrigger;
  /** One value per policy change; the same key never re-admits a row twice. */
  key: string;
  /** The surface that connected, for the `surface` trigger. */
  surfaceId?: Id<'surfaces'>;
  /** Creation-time watermarks a continuation resumes from, per state. */
  after?: { skipped?: number; deferred?: number };
  now?: number;
}

/** How many rows a re-evaluation examined and readmitted. */
export interface ReevaluatePendingResult {
  readmitted: number;
  examined: number;
  /** True when a batch filled and the rest was scheduled. */
  continued: boolean;
}

export interface ParkedVerdict {
  decision?: string;
  reason?: string;
  missingSurface?: string;
  missingPermissions?: string[];
  claimedBy?: { claimId?: string };
}

interface SurfaceTrigger {
  surface: Doc<'surfaces'>;
  siblings: Doc<'surfaces'>[];
}

/**
 * Whether a parked row's verdict can change under this trigger.
 *
 * An out-of-scope skip reads the charter, the documented systems and the
 * connected surfaces, so any of the three sends it back. A quality-fit skip
 * reads the charter's role. A deferral waits on one surface or one grant and
 * returns when that surface connects. A skip refused at the claim returns
 * only when the claim that refused it is released, whatever else changes. A
 * low-value or already-claimed skip reads none of these and stays where it is.
 */
function verdictReturnsOn(
  row: Doc<'workItems'>,
  trigger: ReevaluationTrigger,
  key: string,
  surface: SurfaceTrigger | undefined,
): boolean {
  const verdict = (row.verdict ?? {}) as ParkedVerdict;
  const reason = typeof verdict.reason === 'string' ? verdict.reason : (row.skipReason ?? '');
  if (row.state === 'skipped') {
    if (trigger === 'claim-released') return verdict.claimedBy?.claimId === key;
    if (reason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)) return true;
    if (reason.startsWith(QUALITY_FIT_SKIP_PREFIX)) return trigger === 'charter';
    return false;
  }
  if (row.state === 'deferred' && reason === AWAITING_CHARTER) return trigger === 'charter';
  // An evaluation the scope judgement could not answer was parked after its
  // attempts; a charter change asks the judgement again (E-70 D2).
  if (row.state === 'deferred' && reason === SCOPE_JUDGEMENT_UNAVAILABLE) {
    return trigger === 'charter';
  }
  if (row.state !== 'deferred' || trigger !== 'surface' || !surface) return false;
  if (reason === 'awaiting-connection' && verdict.missingSurface !== undefined) {
    return missingSurfaceResolvedBy(verdict.missingSurface, surface.surface, surface.siblings);
  }
  if (reason === 'awaiting-permission') {
    return (verdict.missingPermissions ?? []).includes(`${surface.surface.slug}:read`);
  }
  return false;
}

/**
 * Send the work parked under the old policy back for a fresh evaluation.
 *
 * Skipped and deferred rows whose verdict read the thing that changed return
 * to `discovered` with the verdict cleared; the row identity, its waivers and
 * its history stay. Each row is stamped with the trigger key, so the same
 * change firing twice re-admits nothing the second time. A batch of
 * `REEVALUATION_BATCH` rows per state is examined here; when a batch fills,
 * the rest is scheduled as a continuation carrying only ids and watermarks.
 *
 * Args:
 *   ctx: Mutation context.
 *   args: The trigger, its key and, for a surface, which one connected.
 *
 * Returns:
 *   How many rows were re-admitted and examined, and whether a continuation was scheduled.
 */
export async function reevaluatePendingInTransaction(
  ctx: MutationCtx,
  args: ReevaluatePendingArgs,
): Promise<ReevaluatePendingResult> {
  const now = args.now ?? Date.now();
  let surface: SurfaceTrigger | undefined;
  if (args.trigger === 'surface') {
    const row = args.surfaceId ? await ctx.db.get(args.surfaceId) : null;
    if (!row || row.agentId !== args.agentId) {
      throw new Error('a surface trigger names a surface of the agent');
    }
    const siblings = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', args.agentId))
      .collect();
    surface = { surface: row, siblings };
  }

  const after: { skipped?: number; deferred?: number } = { ...args.after };
  let readmitted = 0;
  let examined = 0;
  let continued = false;
  for (const state of ['skipped', 'deferred'] as const) {
    const watermark = after[state];
    const rows = await ctx.db
      .query('workItems')
      .withIndex('by_agent_state', (index) => {
        const range = index.eq('agentId', args.agentId).eq('state', state);
        return watermark === undefined ? range : range.gt('_creationTime', watermark);
      })
      .take(REEVALUATION_BATCH);
    for (const row of rows) {
      examined += 1;
      if (reevaluationSpent(row, args.key)) continue;
      if (!verdictReturnsOn(row, args.trigger, args.key, surface)) continue;
      const previous = (row.verdict ?? {}) as ParkedVerdict;
      await ctx.db.patch(row._id, {
        state: 'discovered',
        verdict: undefined,
        skipReason: undefined,
        // A skip that returns is judged afresh, whatever the row was told
        // before it; a deferral that returns waited on a connection, which
        // the scope judgement never read, and keeps its in-scope verdict.
        ...(row.state === 'skipped' ? { scopeAdmission: undefined } : {}),
        reevaluation: reevaluationStamp(row, args.trigger, args.key, now),
        evaluationAttempts: undefined,
        evaluationUnavailableAt: undefined,
        evaluationUnavailableCause: undefined,
      });
      await appendEvent(ctx, {
        agentId: args.agentId,
        type: 'work.requeued',
        payload: {
          workItemId: row._id,
          trigger: args.trigger,
          key: args.key,
          previousState: row.state,
          ...(surface ? { surfaceId: surface.surface._id, slug: surface.surface.slug } : {}),
          ...(previous.missingSurface ? { previousMissingSurface: previous.missingSurface } : {}),
        },
        createdAt: now,
      });
      await scheduleNextStep(ctx, { ...row, state: 'discovered', verdict: undefined });
      readmitted += 1;
    }
    if (rows.length === REEVALUATION_BATCH) {
      after[state] = rows[rows.length - 1]._creationTime;
      continued = true;
    } else {
      delete after[state];
    }
  }
  if (continued) {
    await ctx.scheduler.runAfter(0, internal.work.reevaluatePending, {
      agentId: args.agentId,
      trigger: args.trigger,
      key: args.key,
      ...(args.surfaceId ? { surfaceId: args.surfaceId } : {}),
      after,
    });
  }
  if (readmitted > 0) {
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'work.reevaluation',
      payload: { trigger: args.trigger, key: args.key, readmitted, examined },
      createdAt: now,
    });
  }
  return { readmitted, examined, continued };
}

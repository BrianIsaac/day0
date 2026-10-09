import type { ExecutionPlan, PlanStepOutcome } from '../src/work/types';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { scheduleNextStep } from './workLoop';
import { actionIdempotencyKey } from '../src/work/idempotency';
import {
  HELD_CLOSE_AGAINST_WORDS,
  HELD_NOT_APPROVED,
  HELD_WRITE,
  isSurfaceTool,
  parseSurfaceAction,
  reviewActions,
  type ActionVerdict,
} from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { closingChanges } from '../src/work/work-done';
import { leftForCardOf, withoutLeftForCard } from '../src/work/held-close';
import { verdictFor } from '../src/surfaces/verdict';
import type { AppliedAction } from '../src/surfaces/types';
import { autonomousActionsOn } from '../src/work/autonomy';
import { transitionWithheld } from '../src/work/obligations';
import { transitionDirectedByNote } from '../src/work/transition-direction';
import { replyTargetFor } from '../src/work/reply-target';
import { heldWithReportedWrites } from '../src/work/evidence-claims';
import type { MockAction } from '../src/work/types';
import { reportedRows, withoutApplyProgress } from '../src/work/apply-progress';
import { browserComponentRefusal, withBrowserComponentState } from '../src/surfaces/browser';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { outcomeUnknownReasonFor, type ApplyEnd } from '../src/work/reconciliation';
import { accessEnded } from '../src/work/surface-access';
import { appendEvent } from './eventLog';
import { actionsOf, ledgerOf, verdictList } from './workLedger';

/*
 * A run's held set at the gate and at the apply (the wave 14 review's D-6, the standard's 9.2):
 * the verdicts decided in the hold transaction, the surface an approved write still waits to
 * connect, the set parked on that connection, and the ledger an apply that did not finish leaves;
 * moved out of `convex/work.ts` unchanged. The registered hold and apply functions in
 * `convex/work.ts` and `convex/workRuns.ts` call these. This module sits below `convex/work.ts`:
 * `convex/work.ts` imports it and it never imports `./work`, so the move closes no import cycle.
 * It registers no function.
 */

/**
 * Decide, inside the hold transaction, what the gate will do with each action.
 *
 * The surfaces, grants and the agent's autonomous-actions toggle are read in
 * the same transaction that holds the run, so the verdicts describe the run
 * the manager is about to review (or that is about to apply on its own) and
 * a row refused here is refused at approval rather than failing at apply.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item being held.
 *   actions: The actions the skill emitted.
 *   planStepOutcomes: The closing set's step accounting, for a retry note that directs the state change.
 *   closeAgainstWords: Whether the tripwire sent this set's close to the manager (12-D): its
 *     state change is then held whatever the switch says.
 *
 * Returns:
 *   The verdicts, one per action, and the toggle they were decided under.
 */
export async function reviewHeldActions(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  actions: MockAction[],
  planStepOutcomes: readonly PlanStepOutcome[] | undefined,
  closeAgainstWords = false,
): Promise<{
  verdicts: ActionVerdict[];
  autonomousActions: boolean;
  transitionDirectedByNote: boolean;
}> {
  const [agent, surfaceRows, grantRows] = await Promise.all([
    ctx.db.get(row.agentId),
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
      .collect(),
    ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', row.agentId))
      .collect(),
  ]);
  if (!agent) throw new Error('agent not found');
  if (SURFACE_MODE === 'mock') {
    // Every mock write waits for the manager; a close the tripwire sent there says why it does.
    const closes = new Set(
      closeAgainstWords ? closingChanges(actions).map((change) => change.index) : [],
    );
    return {
      verdicts: actions.map((_, index) => ({
        disposition: 'held',
        reason: closes.has(index) ? HELD_CLOSE_AGAINST_WORDS : HELD_WRITE,
      })),
      autonomousActions: false,
      transitionDirectedByNote: false,
    };
  }
  const grants = new Set(grantRows.filter((grant) => !grant.revokedAt).map((grant) => grant.scope));
  const autonomousActions = autonomousActionsOn(agent);
  const browserRefusal = browserComponentRefusal(process.env.DAY0_BROWSER_MCP_URL);
  const plan = row.plan as ExecutionPlan | undefined;
  // A retry note that directs the state change in so many words is the
  // manager's decision already given; the hold then reads as any other write.
  const directed = plan
    ? transitionDirectedByNote({ plan, planStepOutcomes, feedback: row.managerFeedback, actions })
    : false;
  return {
    // A message that reports a held write of its own set waits with it (W12X-2).
    verdicts: heldWithReportedWrites(
      actions,
      reviewActions(
        actions,
        surfaceRows.map((surface) =>
          toSurfaceRecord(withBrowserComponentState(surface, browserRefusal)),
        ),
        grants,
        Date.now(),
        {
          autonomousActions,
          replyTarget: replyTargetFor(row),
          transitionWithheld: plan ? transitionWithheld(plan) && !directed : false,
          closeAgainstWords,
        },
      ),
    ),
    autonomousActions,
    transitionDirectedByNote: directed,
  };
}

/**
 * Whether a surface with each effective verdict waits on its manager to approve or connect it:
 * the states a connection ends, as opposed to a connection that lapsed (`listed-dead`) or a system
 * that is gone (`absent`), which the gate refuses as before. Keyed over every verdict, so one the
 * type gains does not compile until it is placed.
 */
const AWAITING_CONNECTION_VERDICTS: Readonly<Record<ReturnType<typeof verdictFor>, boolean>> = {
  declared: true,
  proposed: true,
  approved: true,
  ungranted: true,
  connected: false,
  'listed-dead': false,
  absent: false,
};

/**
 * The surface an approved write would go through that waits for its connection, if any: the
 * first approved row naming a surface of the employee's whose access has not ended and whose
 * effective verdict is one a connection ends ({@link AWAITING_CONNECTION_VERDICTS}).
 *
 * @param db - The claim's reader.
 * @param row - The work item, its set approved by the manager.
 * @param now - The claim's time.
 * @returns The surface's slug, or undefined when every approved write's surface is connected,
 *   ended or unknown (the gate decides those).
 */
export async function surfaceAwaitingConnection(
  db: QueryCtx['db'],
  row: Doc<'workItems'>,
  now: number,
): Promise<string | undefined> {
  const actions = actionsOf(row.output) as MockAction[];
  const surfaces = await db
    .query('surfaces')
    .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
    .collect();
  for (const index of row.approvedIndexes ?? []) {
    const action = actions[index];
    if (action === undefined || !isSurfaceTool(action.tool)) continue;
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) continue;
    const surface = surfaces.find((candidate) => candidate.slug === parsed.action.surface);
    if (surface === undefined || accessEnded(surface, now)) continue;
    if (AWAITING_CONNECTION_VERDICTS[verdictFor(toSurfaceRecord(surface), now)]) {
      return surface.slug;
    }
  }
  return undefined;
}

/**
 * Park an approved set on the connection its write needs (U-3 of the transfer plan): the item is
 * `deferred` with the evaluator's own verdict (`awaiting-connection` and the `missingSurface`),
 * so connecting the surface returns it to evaluation (`requeueDeferredWork`); nothing was sent,
 * and the approval goes with the set, since the run is planned again from the item.
 *
 * @param ctx - The apply claim's mutation context.
 * @param row - The work item, `actions-pending` with its set approved.
 * @param missingSurface - The surface the write waits on.
 */
export async function parkOnConnection(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  missingSurface: string,
): Promise<void> {
  const verdict = {
    decision: 'defer' as const,
    reason: 'awaiting-connection' as const,
    missingSurface,
  };
  await ctx.db.patch(row._id, {
    state: 'deferred',
    waitingSince: Date.now(),
    verdict,
    // Returned to evaluation, the item is planned again, as a send-back to drafting plans it.
    plan: undefined,
    planPendingAt: undefined,
    planDraftedWithout: undefined,
    managerAnswers: undefined,
    pendingRunId: undefined,
    approvedIndexes: undefined,
    actionVerdicts: undefined,
    applyPhase: undefined,
    executionRunId: undefined,
    applyAttemptId: undefined,
    applyClaimedAt: undefined,
    decision: undefined,
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.evaluated',
    payload: { workItemId: row._id, decision: verdict.decision, verdict },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, { ...row, state: 'deferred' });
}

/** The output of an apply whose outcome is unknown, with its ledger as recovery records it. */
export interface InterruptedApplyLedger {
  readonly output: {
    actions?: Array<{ tool?: unknown }>;
    actionIndexOffset?: unknown;
    [key: string]: unknown;
  };
  readonly applied: AppliedAction[];
}

/**
 * The ledger of an apply that was claimed and did not finish: a row this phase approved keeps the
 * outcome the apply reported for it before it stopped (P4-2) and is recorded with its outcome
 * unknown when it reported none, a row an earlier phase recorded keeps its entry, and every other
 * row keeps why it was not applied, as the apply's dead-man switch records it.
 *
 * @param row - The work item, `executing` with an apply claimed.
 * @param pendingRunId - The run the approval belongs to.
 * @param end - What ended the apply: an interruption the recovery found, or a stop; the unreported
 *   rows' reason says which (`outcomeUnknownReasonFor`).
 */
export function interruptedApplyLedger(
  row: Doc<'workItems'>,
  pendingRunId: Id<'events'>,
  end: ApplyEnd,
): InterruptedApplyLedger {
  const output = (row.output ?? {}) as {
    actions?: Array<{ tool?: unknown }>;
    actionIndexOffset?: unknown;
    [key: string]: unknown;
  };
  const approved = new Set(row.approvedIndexes ?? []);
  const count = output.actions?.length ?? 0;
  const verdicts = verdictList(row.actionVerdicts, count);
  const prior = ledgerOf(row.output);
  const actionIndexOffset =
    typeof output.actionIndexOffset === 'number' &&
    Number.isInteger(output.actionIndexOffset) &&
    output.actionIndexOffset >= 0
      ? output.actionIndexOffset
      : 0;
  // In the auto phase a held row was never offered to the manager, so it
  // keeps the reason the gate held it for; so does a close an approval left
  // for its card (12-H), which the manager has not decided. In the approved
  // phase any other unapproved held row is one the manager left out.
  const leftForCard = new Set(leftForCardOf(row.output));
  const heldReasonFor = (index: number): string => {
    const verdict = verdicts[index];
    if (verdict.disposition === 'refused') return verdict.reason;
    if (verdict.disposition === 'held' && (row.applyPhase === 'auto' || leftForCard.has(index))) {
      return verdict.reason;
    }
    return HELD_NOT_APPROVED;
  };
  // A row the apply reported before it stopped is kept as it reported (P4-2).
  const reported = row.applyAttemptId
    ? reportedRows(row.output, row.applyAttemptId)
    : new Map<number, AppliedAction>();
  const applied = (output.actions ?? []).map((action, index): AppliedAction => {
    const earlier = prior[index];
    if (earlier && !earlier.awaitingApproval && !approved.has(index)) return earlier;
    const kept = approved.has(index) ? reported.get(index) : undefined;
    if (kept) return kept;
    return {
      tool: typeof action.tool === 'string' ? action.tool : 'unknown',
      ok: !approved.has(index),
      ...(approved.has(index)
        ? { reason: outcomeUnknownReasonFor(end) }
        : { held: true, reason: heldReasonFor(index) }),
      idempotencyKey: actionIdempotencyKey({
        workItemId: row._id,
        runId: row.executionRunId ?? pendingRunId,
        actionIndex: index + actionIndexOffset,
      }),
    };
  });
  return { output: withoutLeftForCard(withoutApplyProgress(output)), applied };
}

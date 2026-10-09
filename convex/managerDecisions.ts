import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { planAgreementsAtApproval } from './workingAgreements';
import { keepCorrectionInTransaction } from './corrections';
import { scheduleApply, scheduleNextStep } from './workLoop';
import {
  awaitingIndexes,
  isCloseHeldAgainstWords,
  LEFT_FOR_CARD_KEY,
  leftForCardOf,
  wholeSetApproval,
  withoutLeftForCard,
} from '../src/work/held-close';
import { type DecisionKind, MANAGER_FEEDBACK_MAX_CHARS } from '../src/work/manager-channel';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { appendEvent } from './eventLog';
import { actionsOf, indexesWith, ledgerOf, verdictList } from './workLedger';
import { releaseExternalClaim, releaseItemClaim, settleWriteTargetClaims } from './workClaims';
import { scheduleRequestClose, settleBatchesHolding } from './decisionRequests';

/*
 * The manager's decision as applied in the deciding transaction (the wave 14 review's D-6, the
 * standard's 9.2): a plan approved or turned down, a held set approved row by row or rejected, the
 * same whether the card or the channel decided, with the request marked decided and the manager's
 * words kept; moved out of `convex/work.ts` unchanged. The registered decisions
 * (`work:approveActions`, `work:approveActionsBatch`, `work:rejectActions`, `work:cancelPlan`,
 * and `planApproval:approvePlan` above `convex/work.ts`) call these. This module sits below
 * `convex/work.ts`: `convex/work.ts` imports it and it never imports `./work`, so the move closes
 * no import cycle. It registers no function.
 */

/** The manager's words as kept: whitespace collapsed and capped at `MANAGER_FEEDBACK_MAX_CHARS`. */
export function managerText(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MANAGER_FEEDBACK_MAX_CHARS);
}

type DecisionVia = 'dashboard' | 'channel';

function decidedPatch(
  row: Doc<'workItems'>,
  kind: DecisionKind,
  via: DecisionVia,
  outcome: 'approved' | 'rejected',
  messageTs?: string,
): { decision?: NonNullable<Doc<'workItems'>['decision']> } {
  if (!row.decision || row.decision.kind !== kind || row.decision.decidedAt) return {};
  return {
    decision: {
      ...row.decision,
      decidedAt: Date.now(),
      outcome,
      decidedVia: via,
      ...(via === 'channel' && messageTs ? { decidedTs: messageTs } : {}),
    },
  };
}

/** One answer the manager gave with plan approval, as the row carries it. */
export type ManagerAnswerRow = NonNullable<Doc<'workItems'>['managerAnswers']>[number];

/**
 * Approve a pending plan in the caller's transaction, by the card or in the manager channel, with
 * the answers the approval gave, and schedule its run. Internal to the backend: `approvePlan`
 * (`convex/planApproval.ts`) and the channel's decisions call it. Writes the row's state, its
 * answers and decision, the request's close and `work.plan-approved`.
 */
export async function approvePlanInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  via: DecisionVia,
  messageTs?: string,
  answers: ManagerAnswerRow[] = [],
): Promise<void> {
  if (row.state !== 'plan-pending') {
    throw new Error(`workItem state is ${row.state}; expected plan-pending`);
  }
  // An agreement retired since the plan was drafted no longer binds the run (W13-R29).
  const settledPlan = await planAgreementsAtApproval(ctx, row);
  await ctx.db.patch(row._id, {
    state: 'plan-approved',
    ...(settledPlan === undefined ? {} : { plan: settledPlan }),
    ...(answers.length > 0 ? { managerAnswers: answers } : {}),
    ...decidedPatch(row, 'plan', via, 'approved', messageTs),
  });
  await scheduleRequestClose(ctx, row._id);
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.plan-approved',
    payload: {
      workItemId: row._id,
      decidedVia: via,
      ...(answers.length > 0
        ? {
            answered: answers.map((entry) => ({
              question: entry.question,
              questionId: entry.questionId,
            })),
          }
        : {}),
    },
    createdAt: Date.now(),
  });
  // Whichever way the manager approved, the server runs the plan; the page no
  // longer has to be open for it.
  await scheduleNextStep(ctx, { ...row, state: 'plan-approved' });
}

/** Why a work item is `cancelled` after the manager turned its plan down. */
export const PLAN_CANCELLED_REASON = 'plan cancelled by the manager';

function planCancelledReason(reason: string): string {
  const detail = reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  return detail ? `${PLAN_CANCELLED_REASON}: ${detail}` : PLAN_CANCELLED_REASON;
}

export async function cancelPlanInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  via: DecisionVia,
  reason: string,
  messageTs?: string,
): Promise<void> {
  if (row.state !== 'plan-pending') {
    throw new Error(`workItem state is ${row.state}; expected plan-pending`);
  }
  const skipReason = planCancelledReason(reason);
  const feedback = managerText(reason);
  if (feedback) {
    await keepCorrectionInTransaction(ctx, row, {
      kind: 'plan-rejection',
      text: feedback,
      origin: via,
    });
  }
  const now = Date.now();
  await ctx.db.patch(row._id, {
    state: 'cancelled',
    skipReason,
    ...(SURFACE_MODE === 'real'
      ? { planRejectedAt: now, rejectedAt: row.rejectedAt ?? row.planRejectedAt ?? now }
      : {}),
    // Kept in full, as a rejection reason is, for the plan Retry drafts next.
    ...(feedback
      ? { managerFeedback: { reason: feedback, at: Date.now(), kind: 'plan-rejection' as const } }
      : {}),
    ...decidedPatch(row, 'plan', via, 'rejected', messageTs),
  });
  await scheduleRequestClose(ctx, row._id);
  await releaseExternalClaim(ctx, row._id, Date.now());
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.cancelled',
    payload: { workItemId: row._id, reason: skipReason, decidedVia: via },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, { ...row, state: 'cancelled' });
}

/**
 * How much of a held set an approval decides (wave 12, 12-H; R-12D-1): `card` is the card's own
 * choice, row by row, beside the sentence a tripped close carries; `whole-set` is an approval made
 * without that sentence (a Slack approval by the typed code, a button or the batch code, and the
 * Needs you batch), which never sends a close the tripwire held and leaves it for its card.
 */
type ApprovalScope = 'card' | 'whole-set';

/** How an approval of held actions was made: where, by which reply or press, and how much of the set. */
interface ApprovalMade {
  readonly via: DecisionVia;
  /** The channel reply or press that decided, when one did. */
  readonly messageTs?: string;
  /** Absent: the card's own choice, row by row. */
  readonly scope?: ApprovalScope;
}

/** Why a whole-set approval refuses a close the tripwire held: it is decided on its card. */
export const CLOSE_DECIDED_ON_CARD = 'is a ticket close Day0 held, so it is decided on its card';

/**
 * Approve held actions of one parked set and schedule their apply, inside the caller's transaction.
 *
 * Only a held row still waiting can be approved: one an earlier approval of this set already sent
 * or withheld is decided. A whole-set approval ({@link ApprovalScope}) leaves every waiting close the
 * tripwire held for its card: recorded on the output (`leftForCard`) for the apply to park it again,
 * and on the approval's event, never among the rows the manager left out.
 *
 * @param ctx - The decision's transaction.
 * @param row - The parked item.
 * @param args - The run the approval was shown and the rows it approves.
 * @param decision - Where the decision was made, the channel reply or press that made it, and how
 *   much of the set it decides.
 */
export async function approveActionsInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  args: {
    workItemId: Id<'workItems'>;
    pendingRunId: Id<'events'>;
    approvedIndexes: number[];
  },
  decision: ApprovalMade,
): Promise<{ ok: true; approvedIndexes: number[] }> {
  const { via, messageTs, scope = 'card' } = decision;
  if (row.state !== 'actions-pending') {
    throw new Error(`workItem state is ${row.state}; expected actions-pending`);
  }
  if (!row.pendingRunId) throw new Error('workItem has no pending run');
  if (row.pendingRunId !== args.pendingRunId) {
    throw new Error('pending run changed; refresh the action list');
  }
  if (row.approvedIndexes !== undefined) {
    throw new Error('actions have already been approved');
  }
  const actions = actionsOf(row.output);
  const verdicts = verdictList(row.actionVerdicts, actions.length);
  const awaiting = awaitingIndexes(verdicts, ledgerOf(row.output));
  const approvedIndexes = [...new Set(args.approvedIndexes)].sort((a, b) => a - b);
  for (const index of approvedIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= actions.length) {
      throw new Error(`action index ${index} is outside the pending list`);
    }
    const verdict = verdicts[index];
    if (verdict.disposition === 'refused') {
      throw new Error(
        `action ${index + 1} is refused (${verdict.reason}); approve the others by selection`,
      );
    }
    if (verdict.disposition === 'auto') {
      throw new Error(`action ${index + 1} was applied automatically and cannot be approved again`);
    }
    if (!awaiting.includes(index)) {
      throw new Error(`action ${index + 1} was already decided by an earlier approval`);
    }
    if (scope === 'whole-set' && isCloseHeldAgainstWords(verdict)) {
      throw new Error(`action ${index + 1} ${CLOSE_DECIDED_ON_CARD}`);
    }
  }
  const leftForCard =
    scope === 'whole-set' ? wholeSetApproval(verdicts, ledgerOf(row.output)).leftForCard : [];
  if (approvedIndexes.length === 0 && leftForCard.length > 0) {
    throw new Error('only a ticket close Day0 held is waiting, and it is decided on its card');
  }
  const rejectedIndexes = awaiting.filter(
    (index) => !approvedIndexes.includes(index) && !leftForCard.includes(index),
  );
  await ctx.db.patch(args.workItemId, {
    approvedIndexes,
    applyPhase: 'approved',
    // The mark is this approval's alone: an earlier one's, on a set a handover returned to held,
    // never decides what this apply parks.
    ...(leftForCard.length > 0
      ? {
          output: {
            ...withoutLeftForCard(row.output as Record<string, unknown>),
            [LEFT_FOR_CARD_KEY]: [...leftForCard],
          },
        }
      : leftForCardOf(row.output).length > 0
        ? { output: withoutLeftForCard(row.output as Record<string, unknown>) }
        : {}),
    ...decidedPatch(row, 'actions', via, 'approved', messageTs),
  });
  const approved = await ctx.db.get(args.workItemId);
  if (approved) await settleBatchesHolding(ctx, approved);
  await scheduleRequestClose(ctx, args.workItemId);
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.actions-approved',
    payload: {
      workItemId: args.workItemId,
      runId: row.pendingRunId,
      approvedIndexes,
      rejectedIndexes,
      refusedIndexes: indexesWith(verdicts, 'refused'),
      autoIndexes: indexesWith(verdicts, 'auto'),
      ...(leftForCard.length > 0 ? { leftForCard: [...leftForCard] } : {}),
      decidedVia: via,
    },
    createdAt: Date.now(),
  });
  await scheduleApply(ctx, args.workItemId, row.pendingRunId, 'approved');
  return { ok: true, approvedIndexes };
}

export async function rejectActionsInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  args: { workItemId: Id<'workItems'>; pendingRunId: Id<'events'>; reason: string },
  via: DecisionVia,
  messageTs?: string,
): Promise<{ ok: true }> {
  if (row.state !== 'actions-pending') {
    throw new Error(`workItem state is ${row.state}; expected actions-pending`);
  }
  if (row.approvedIndexes !== undefined) {
    throw new Error('actions have already been approved');
  }
  if (!row.pendingRunId) throw new Error('workItem has no pending run');
  if (row.pendingRunId !== args.pendingRunId) {
    throw new Error('pending run changed; refresh the action list');
  }
  const feedback = managerText(args.reason);
  const reason = feedback.slice(0, 200);
  const skipReason = reason ? `rejected by the manager: ${reason}` : 'rejected by the manager';
  const applied = ledgerOf(row.output);
  const output =
    applied.length > 0
      ? {
          ...(row.output as Record<string, unknown>),
          applied: applied.map((entry) =>
            entry?.awaitingApproval
              ? { ...entry, awaitingApproval: undefined, reason: skipReason }
              : entry,
          ),
        }
      : undefined;
  const now = Date.now();
  await settleWriteTargetClaims(ctx, args.workItemId, now);
  await ctx.db.patch(args.workItemId, {
    state: 'failed',
    waitingSince: Date.now(),
    skipReason,
    ...(SURFACE_MODE === 'real' ? { rejectedAt: row.rejectedAt ?? row.planRejectedAt ?? now } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(feedback
      ? {
          managerFeedback: {
            reason: feedback,
            at: Date.now(),
            runId: args.pendingRunId,
            kind: 'rejection' as const,
          },
        }
      : {}),
    pendingRunId: undefined,
    approvedIndexes: undefined,
    actionVerdicts: undefined,
    applyPhase: undefined,
    executionRunId: undefined,
    applyAttemptId: undefined,
    applyClaimedAt: undefined,
    ...decidedPatch(row, 'actions', via, 'rejected', messageTs),
  });
  const rejected = await ctx.db.get(args.workItemId);
  if (rejected) await settleBatchesHolding(ctx, rejected);
  await scheduleRequestClose(ctx, args.workItemId);
  if (feedback) {
    await keepCorrectionInTransaction(ctx, row, {
      kind: 'rejection',
      text: feedback,
      origin: via,
      runId: args.pendingRunId,
    });
  }
  await releaseItemClaim(ctx, args.workItemId, now);
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.actions-rejected',
    payload: { workItemId: args.workItemId, reason: skipReason, decidedVia: via },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, { ...row, state: 'failed' });
  return { ok: true };
}

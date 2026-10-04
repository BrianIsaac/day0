import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsWorkItem, getCallerOrThrow } from './ownership';
import {
  HANDOVER_IN_PROGRESS_REASON,
  HANDOVER_STOP_REASON,
  isBeingHandedOver,
  settleHandoverAfterRun,
} from './transferInFlight';
import { keepCorrectionInTransaction } from './corrections';
import {
  armApplySwitch,
  EXECUTION_STALL_MS,
  scheduleApply,
  scheduleNextStep,
  stepMayRun,
} from './workLoop';
import { appendEvent } from './eventLog';
import {
  actionsOf,
  assertSameAgent,
  failInTransaction,
  indexesWith,
  interruptedApplyLedger,
  managerText,
  NOTHING_TO_DECIDE_REASON,
  parkOnConnection,
  queueManagerNote,
  refusedReasonEntries,
  rememberReplacedRequest,
  retakeExternalClaim,
  reviewHeldActions,
  scheduleDecisionRequest,
  settleWriteTargetClaims,
  SKILL_OUT_OF_USE_REASONS,
  SKILL_UNDER_REVISION_REASON,
  surfaceAwaitingConnection,
  verdictList,
} from './work';
import { closingResume } from '../src/work/closing-resume';
import type { ExecutionPlan, PlanStepOutcome } from '../src/work/types';
import { EVALUATION_ATTEMPTS_SPENT } from '../src/work/queue-order';
import { toSurfaceRecord } from '../src/surfaces/records';
import { verdictFor } from '../src/surfaces/verdict';
import { autonomousActionsOn } from '../src/work/autonomy';
import { isOpenQuestionStop } from '../src/work/obligations';
import { replyTargetFor } from '../src/work/reply-target';
import {
  type MockAction,
  type ReplyTarget,
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
} from '../src/work/types';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { skillBodyHash } from '../src/work/skill-body';
import {
  answeredEntries,
  ledgerPhases,
  providerReconciliationEntries,
  reconciliationAnswered,
  reconciliationOwed,
  retryRequiresProviderReconciliation,
} from '../src/work/reconciliation';
import { landedWritesOf, unsentWritesOf } from '../src/work/landed-writes';
import {
  isStoppable,
  landedNoteRows,
  landedWork,
  managerStopReason,
  stopDetail,
} from '../src/work/stop';
import { landedNoteText } from '../src/work/manager-notes';
import type { WithheldRow, WorkActionsAutoApplyingPayload } from '../src/events/contract';
import { reportedRow, withReportedOutcome } from '../src/work/apply-progress';

/**
 * A work item's runs (F8, E4: the claim, execute, apply, retry, reconcile, dismiss and stop
 * regions of `convex/work.ts`, moved here by wave 12's 12-W).
 *
 * A run is claimed (`claimForExecution`), held at the exact-action gate (`setActionsPending`),
 * applied (`claimApprovedActions`, then the apply action in `workActions.ts`) and ended
 * (`setCompleted`, `setFailed`, the stop primitive `stopRunsInTransaction`); a failed one is
 * reconciled, retried or dismissed by the manager. The helpers these share with the rest of the
 * work loop stay in `convex/work.ts`, which this module imports and which never imports it.
 */

/**
 * The output a retry carries when the manager answered the reconciliation entry by entry: the
 * landed writes as they answered them (`landedWritesOf` with the answers) kept in `landedWrites`,
 * which the retried run reads as already on the provider, and the writes they answered not sent
 * in `unsentWrites`, which it sends afresh (W12-R13) and never counts landed (W12-R4). Not-sent
 * writes an earlier reconciliation carried are replaced: what became of them is in this ledger.
 *
 * @param output - The output the retry starts from.
 * @param row - The failed row and its reconciliation.
 * @returns The output with the carried writes, or undefined when nothing was answered.
 */
function carriedAfterReconciliation(
  output: unknown,
  row: Doc<'workItems'>,
): Record<string, unknown> | undefined {
  const answered = (row.providerReconciliation?.entries ?? []).filter(
    (entry) => entry.answer !== undefined,
  );
  if (answered.length === 0 || !output || typeof output !== 'object') return undefined;
  const unsentWrites = unsentWritesOf(row.output, answered);
  return {
    ...Object.fromEntries(Object.entries(output).filter(([key]) => key !== 'unsentWrites')),
    landedWrites: landedWritesOf(row.output, answered),
    ...(unsentWrites.length > 0 ? { unsentWrites } : {}),
  };
}

/** Public, owner-guarded: retries a failed or stopped item, keeping the manager's optional note as feedback for the next run. */
export const retryFailed = mutation({
  args: { workItemId: v.id('workItems'), feedback: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    // A note given with Retry is the manager's answer to what the last run
    // asked, or a direction for the next one; it reaches the retried run the
    // way a rejection reason does.
    const feedback = managerText(args.feedback);
    const recoverable = ['failed', 'skipped', 'cancelled', 'completed'];
    // A row parked because its evaluations kept dying waits for this Retry.
    const spentEvaluation =
      row.state === 'deferred' &&
      (row.verdict as { reason?: unknown } | undefined)?.reason === EVALUATION_ATTEMPTS_SPENT;
    if (!recoverable.includes(row.state) && !spentEvaluation) {
      throw new Error(`workItem state is ${row.state}; expected one of ${recoverable.join(', ')}`);
    }
    // Finished work is sent back only with a direction: a retry that changes
    // nothing would repeat what already landed.
    if (row.state === 'completed' && !feedback) {
      throw new Error('a completed item is sent back with a note saying what to change');
    }
    if (reconciliationOwed(row)) {
      throw new Error(
        'retry refused because an external effect may already have landed; reconcile the provider first',
      );
    }
    const verdict = row.verdict as { decision?: string; reason?: unknown } | undefined;
    // A cancelled plan is one the manager turned down: Retry drafts a new plan
    // that goes back to them, and never runs the rejected one.
    const redraft = row.state === 'cancelled' && row.plan !== undefined;
    const next: Doc<'workItems'>['state'] =
      row.plan && !redraft
        ? 'plan-approved'
        : verdict?.decision === 'claim'
          ? 'claimed'
          : 'discovered';
    if (next !== 'discovered') await retakeExternalClaim(ctx, row);
    // Retrying a skip is the manager overruling the agent's judgement: a
    // quality-fit skip says the work is worth doing, an out-of-scope skip says
    // the work is theirs to give. The re-evaluation leaves that one rule out.
    const skipReason =
      row.state === 'skipped' && typeof verdict?.reason === 'string' ? verdict.reason : '';
    const waived: 'quality-fit' | 'scope' | undefined = skipReason.startsWith(
      QUALITY_FIT_SKIP_PREFIX,
    )
      ? 'quality-fit'
      : skipReason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)
        ? 'scope'
        : undefined;
    // A write the manager says was not sent leaves the ledger a resumed closing set would author
    // from untrue, so the retry runs the plan again from its first phase.
    const answeredNotSent = (row.providerReconciliation?.entries ?? []).some(
      (entry) => entry.answer === 'not-sent',
    );
    const resume =
      SURFACE_MODE === 'real' && row.state === 'failed' && row.plan && !answeredNotSent
        ? closingResume(
            row.output,
            row.plan as ExecutionPlan,
            row.skipReason && stopDetail(row.skipReason),
            (
              await ctx.db
                .query('surfaces')
                .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
                .take(100)
            )
              .map(toSurfaceRecord)
              .filter((surface) => verdictFor(surface, Date.now()) === 'connected'),
          )
        : undefined;
    // The writes the manager confirmed on the provider are carried into the retry, so a write
    // answered landed is never sent again however its row reads (P4-1).
    const carried = carriedAfterReconciliation(resume ?? row.output, row);
    if (redraft) await rememberReplacedRequest(ctx, row, Date.now());
    await ctx.db.patch(args.workItemId, {
      state: next,
      // A retried item begins a new run, which the queue orders by (x4); one sent back to
      // evaluation holds no run.
      claimedAt: next === 'discovered' ? undefined : Date.now(),
      ...(carried ? { output: carried } : resume ? { output: resume } : {}),
      ...(redraft
        ? {
            plan: undefined,
            decision: undefined,
            planPendingAt: undefined,
            managerAnswers: undefined,
          }
        : {}),
      skipReason: undefined,
      executionRunId: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      providerReconciliation: undefined,
      // A dismissal was of the failure; the item Retry sends back is live again.
      ...(row.dismissedAt !== undefined ? { dismissedAt: undefined } : {}),
      ...(waived === 'quality-fit' ? { qualityFitWaivedAt: Date.now() } : {}),
      ...(waived === 'scope' ? { scopeWaivedAt: Date.now() } : {}),
      ...(feedback
        ? {
            managerFeedback: {
              reason: feedback,
              at: Date.now(),
              kind: 'retry-note' as const,
              // Only a note on a question stop answers the question (review D2).
              ...(row.state === 'failed' &&
              row.skipReason !== undefined &&
              isOpenQuestionStop(stopDetail(row.skipReason))
                ? { answersQuestion: true }
                : {}),
            },
          }
        : {}),
      // A retry starts every step afresh; no claim from an earlier attempt holds it back.
      ...(row.evaluationClaimedAt !== undefined ? { evaluationClaimedAt: undefined } : {}),
      ...(row.draftClaimedAt !== undefined ? { draftClaimedAt: undefined } : {}),
      evaluationAttempts: undefined,
      evaluationUnavailableAt: undefined,
      evaluationUnavailableCause: undefined,
    });
    // The note is also kept for the employee's later work of the same kind.
    if (feedback) await keepCorrectionInTransaction(ctx, row, 'retry-note', feedback);
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.retry',
      payload: {
        workItemId: args.workItemId,
        resumeState: next,
        fromState: row.state,
        ...(waived ? { waived } : {}),
        ...(feedback ? { feedback } : {}),
      },
      createdAt: Date.now(),
    });
    await scheduleNextStep(ctx, { ...row, state: next, ...(redraft ? { plan: undefined } : {}) });
    return { ok: true, resumeState: next };
  },
});

/** The manager's answer for one reconciliation entry, by its place in the run (U17 D1). */
const entryAnswerValidator = v.object({
  phase: v.union(v.literal('single'), v.literal('prerequisite'), v.literal('closing')),
  actionIndex: v.number(),
  answer: v.union(v.literal('landed'), v.literal('not-sent')),
});

/**
 * Public, owner-guarded (`assertOwnsWorkItem`): records the manager's check of the provider before
 * a retry, entry by entry (U17 D1): for each write the run's ledger names, whether it landed or
 * was not sent. A write of unknown outcome must be answered; a landed one is taken as landed
 * unless answered otherwise. Writes `providerReconciliation` with each entry's `answer` and a
 * `work.provider-reconciled` event, once. Refuses, as a `ConvexError` the card says, a
 * confirmation that leaves a write of unknown outcome unanswered.
 */
export const reconcileFailed = mutation({
  args: {
    workItemId: v.id('workItems'),
    confirmed: v.boolean(),
    answers: v.optional(v.array(entryAnswerValidator)),
  },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'failed' && row.state !== 'completed') {
      throw new Error(`workItem state is ${row.state}; expected failed or completed`);
    }
    if (!args.confirmed) throw new Error('explicit provider verification is required');
    // One recorded before the per-entry answers is asked again and replaced (D-9 (a)).
    if (reconciliationAnswered(row.providerReconciliation)) {
      return { ok: true, reconciledEntries: row.providerReconciliation?.entries.length ?? 0 };
    }
    const entries = providerReconciliationEntries(row.output);
    if (!retryRequiresProviderReconciliation(row.output, row.skipReason)) {
      throw new Error('no provider effects require reconciliation');
    }
    if (entries.length === 0) {
      throw new Error('the applied ledger does not identify provider effects to reconcile');
    }
    const answered = answeredEntries(entries, args.answers ?? []);
    if (!answered.ok) {
      throw new ConvexError(
        'Say for each write whose outcome is unknown whether it landed or was not sent.',
      );
    }
    const identity = await getCallerOrThrow(ctx);
    const confirmedAt = Date.now();
    // `actor` is the owner key, one per owner, not the person; U13 D2 adds the session.
    const providerReconciliation = {
      actor: identity.ownerKey,
      confirmedAt,
      entries: answered.entries,
    };
    await ctx.db.patch(args.workItemId, { providerReconciliation });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.provider-reconciled',
      payload: {
        workItemId: args.workItemId,
        actor: identity.ownerKey,
        confirmedAt,
        entries: answered.entries,
      },
      createdAt: confirmedAt,
    });
    return { ok: true, reconciledEntries: entries.length };
  },
});

/**
 * Public, owner-guarded (`assertOwnsWorkItem`): the manager dismisses a failed item (N7), which
 * takes it out of the needs-you inbox and the roster's needs-you figure while it stays in the
 * record and on the Work tab, where Retry still sends it back. Writes `dismissedAt` and a
 * `work.dismissed` event once; a second dismissal changes nothing. Refuses, as a `ConvexError` the card says, an item no longer failed
 * and one whose write may have landed before the provider is reconciled.
 */
export const dismissFailed = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'failed') {
      throw new ConvexError(
        'Only a stopped or rejected item can be dismissed; this one has moved on.',
      );
    }
    if (row.dismissedAt !== undefined) return { ok: true, dismissedAt: row.dismissedAt };
    // The inbox's entry is the one prompt that a write may have landed; it
    // stays until the manager has checked the provider.
    if (reconciliationOwed(row)) {
      throw new ConvexError(
        'A write on this item may have landed: confirm it against the provider before you dismiss it.',
      );
    }
    const dismissedAt = Date.now();
    await ctx.db.patch(args.workItemId, { dismissedAt });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.dismissed',
      payload: { workItemId: args.workItemId },
      createdAt: dismissedAt,
    });
    return { ok: true, dismissedAt };
  },
});

/**
 * Take exclusive ownership of an approved work item, or report that somebody
 * else already has it.
 *
 * This is the whole of the concurrency control for execution. A mutation is a
 * transaction, so the state check and the move to `executing` cannot be split
 * by a second caller; an action that reads `plan-approved` and writes
 * `executing` as two calls can be, and both callers then run the skill and
 * apply every action. React Strict Mode plus the dashboard's auto-progress
 * effect supplies that second caller for free in development.
 *
 * The winner gets a `runId` - the id of the claim event, which is durable,
 * unique per claim and derived from nothing the caller controls. Adapter
 * calls key their idempotency off it, so an external effect can be recognised
 * as already-applied if the run is interrupted before its completion lands.
 * The event records the skill's registration time, the hash of its body and
 * the library version it holds, with whether that version was adopted, so the
 * ledger says which body the run used; a skill sent back for revision, retired
 * or replaced by its revision is refused, and every claim counts a use on the
 * skill ("used N times").
 */
export const claimForExecution = internalMutation({
  args: { workItemId: v.id('workItems'), skillId: v.id('skills') },
  handler: async (
    ctx,
    args,
  ): Promise<{ claimed: true; runId: Id<'events'> } | { claimed: false; reason: string }> => {
    const { item, skill } = await assertSameAgent(ctx, args.workItemId, args.skillId);
    if (item.state !== 'plan-approved') {
      return {
        claimed: false,
        reason:
          item.state === 'executing'
            ? 'another execution already claimed this work item'
            : `workItem state is ${item.state}; expected plan-approved`,
      };
    }
    // The executor picked from the registered list before this transaction;
    // a Retire or a revision registering in between took the row out of use,
    // and a Revise cleared the body the run would otherwise use (P8-8).
    if (skill.state === 'retired' || skill.state === 'superseded') {
      return { claimed: false, reason: SKILL_OUT_OF_USE_REASONS[skill.state] };
    }
    if (skill.state !== 'registered' || skill.body === '') {
      return { claimed: false, reason: SKILL_UNDER_REVISION_REASON };
    }
    // A handover the new manager accepted waits for the runs in flight and starts
    // none (D18): the plan returns to them at the move (D13).
    if (await isBeingHandedOver(ctx.db, item.agentId)) {
      return { claimed: false, reason: HANDOVER_IN_PROGRESS_REASON };
    }
    // A paused employee, or a paused deployment, starts no run (12-P): the plan stays approved
    // for the resume's pass, or the sweep's once the deployment's jobs run again.
    const permission = await stepMayRun(ctx.db, item.agentId);
    if (!permission.mayRun) return { claimed: false, reason: permission.reason };
    const now = Date.now();
    const version = skill.versionId === undefined ? null : await ctx.db.get(skill.versionId);
    const runId = await appendEvent(ctx, {
      agentId: item.agentId,
      type: 'work.execution-claimed',
      payload: {
        workItemId: args.workItemId,
        skillId: args.skillId,
        ...(skill.registeredAt !== undefined ? { skillRegisteredAt: skill.registeredAt } : {}),
        skillBodyHash: skillBodyHash(skill.body),
        ...(version !== null ? { skillVersionId: version._id, skillVersion: version.version } : {}),
        ...(skill.adoptedAt !== undefined ? { skillAdopted: true as const } : {}),
        // The item the skill was made for: a run for any other item is a reuse (A9).
        ...(skill.proposedFor !== undefined ? { proposedFor: skill.proposedFor } : {}),
      },
      createdAt: now,
    });
    // "used N times": every claim is a use, counted in the claim's own transaction.
    await ctx.db.patch(args.skillId, { useCount: (skill.useCount ?? 0) + 1, lastUsedAt: now });
    await ctx.db.patch(args.workItemId, {
      state: 'executing',
      skillId: args.skillId,
      executionRunId: runId,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
    });
    return { claimed: true, runId };
  },
});

/**
 * The rows a finished run held and never sent, by phase and index, with why: what
 * `work.actions-withheld` lists.
 *
 * @param output - The run's output as `setCompleted` received it, in either of its shapes.
 */
function withheldRows(output: unknown): WithheldRow[] {
  return ledgerPhases(output).flatMap(({ phase, applied }) =>
    applied.flatMap((row, index): WithheldRow[] =>
      row.held === true
        ? [
            {
              phase,
              index,
              tool: typeof row.tool === 'string' ? row.tool : 'unknown',
              ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
              ...(typeof row.effect === 'string' ? { effect: row.effect } : {}),
            },
          ]
        : [],
    ),
  );
}

/**
 * Mark a run done, and refuse to when nothing is behind it.
 *
 * The rule - every action the run emitted changed the work environment - was
 * enforced by the caller that happens to run the skill today. That leaves it
 * one caller away from being lost, and it reads as satisfied by a run that
 * emitted no actions at all: vacuously, every action succeeded. `completed`
 * then means "the model finished a turn", which is precisely the state a
 * person cannot tell apart from work that happened.
 *
 * So the rule lives with the write instead. An empty ledger is a bug in the
 * caller rather than an outcome of the work, hence a throw: the action's own
 * error path turns it into a visible `failed` row rather than a silent one.
 */
export const setCompleted = internalMutation({
  args: { workItemId: v.id('workItems'), runId: v.optional(v.id('events')), output: v.any() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (
      row.state !== 'executing' ||
      (args.runId !== undefined && row.executionRunId !== args.runId)
    ) {
      throw new Error('execution run changed before completion');
    }
    const applied = (
      (args.output ?? {}) as {
        applied?: Array<{
          tool: string;
          ok: boolean;
          held?: boolean;
          reason?: string;
          effect?: string;
        }>;
      }
    ).applied;
    if (!applied || applied.length === 0) {
      throw new Error(
        'cannot complete a work item whose run applied nothing to the work environment',
      );
    }
    // A held row is accounted for: the manager chose not to send it, or the
    // gate held a public post for them, and the ledger says so. It is neither
    // a landed change nor a failure.
    const failed = applied.filter((a) => !a.ok && !a.held);
    if (failed.length > 0) {
      throw new Error(
        `cannot complete a work item with ${failed.length} action(s) that did not change the work environment`,
      );
    }
    await settleWriteTargetClaims(ctx, args.workItemId, Date.now());
    await ctx.db.patch(args.workItemId, {
      state: 'completed',
      output: args.output,
      pendingRunId: undefined,
      approvedIndexes: undefined,
      actionVerdicts: undefined,
      applyPhase: undefined,
      executionRunId: undefined,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      // The feedback this run answered stays on the item as its record; the
      // mark keeps a later run from reading it as a live direction.
      ...(row.managerFeedback && row.managerFeedback.addressedAt === undefined
        ? { managerFeedback: { ...row.managerFeedback, addressedAt: Date.now() } }
        : {}),
      managerAnswers: undefined,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.completed',
      payload: { workItemId: args.workItemId, output: args.output },
      createdAt: Date.now(),
    });
    // What the run held and never sent is a line of its own under "Refused and withheld" (D4).
    const withheld = withheldRows(args.output);
    if (withheld.length > 0) {
      await appendEvent(ctx, {
        agentId: row.agentId,
        type: 'work.actions-withheld',
        payload: {
          workItemId: args.workItemId,
          ...(args.runId !== undefined ? { runId: args.runId } : {}),
          withheld,
        },
        createdAt: Date.now(),
      });
    }
    await scheduleNextStep(ctx, { ...row, state: 'completed' });
    await settleHandoverAfterRun(ctx, row.agentId);
    const surfaces = (
      await ctx.db
        .query('surfaces')
        .withIndex('by_agent', (q) => q.eq('agentId', row.agentId))
        .collect()
    ).map(toSurfaceRecord);
    const landed = landedWork(args.output, surfaces);
    if (landed.length > 0) {
      await queueManagerNote(ctx, row, 'landed', (agentName) =>
        landedNoteText({
          agentName,
          title: row.title,
          rows: landedNoteRows(args.output, surfaces, replyTargetFor(row)),
          outcome: 'completed',
        }),
      );
    }
  },
});

/** Internal: ends a run as failed or stopped with its reason, writes the terminal event and releases the item's claims. */
export const setFailed = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    reason: v.string(),
    // Kept when the skill produced a draft the run then failed to apply, so
    // the boss can read what was written before deciding whether to retry.
    output: v.optional(v.any()),
    runId: v.optional(v.id('events')),
    /**
     * Whether the run stopped: nothing landed and nothing is left to decide.
     * Read from the ledger when absent; the comparison arm passes false, since
     * it has no gate and no manager loop for a stop to mean anything to.
     */
    stopped: v.optional(v.boolean()),
    onlyIfStalled: v.optional(v.boolean()),
    /**
     * The claim of the draft that failed (`draftClaimedAt`): a draft fails only the row that
     * still carries its claim, so a draft stopped and superseded by a Retry fails nothing.
     */
    draftClaimedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (args.draftClaimedAt !== undefined && row.draftClaimedAt !== args.draftClaimedAt) return;
    if (args.runId && row.executionRunId !== args.runId) return;
    // A pre-claim failure (such as no matching skill) cannot stop a run
    // another scheduled caller claimed after the failing caller read the row.
    if (!args.runId && row.executionRunId) return;
    if (args.onlyIfStalled) {
      if (
        row.state !== 'executing' ||
        !args.runId ||
        row.pendingRunId ||
        row.applyAttemptId ||
        row.applyClaimedAt ||
        row.applyPhase
      )
        return;
      const claim = await ctx.db.get(args.runId);
      if (!claim || Date.now() - claim.createdAt < EXECUTION_STALL_MS) return;
    }
    // A row that already reached an end state keeps it. Nothing legitimately
    // fails a completed run, and a losing caller must not add a second failure
    // record for a failure the winner already wrote.
    const terminal = ['completed', 'failed', 'cancelled', 'skipped'];
    if (terminal.includes(row.state)) return;
    await failInTransaction(ctx, row, args);
  },
});

/**
 * Stop every run of the employee still executing when its handover's deadline passes (decision
 * D18), through the stop every run's end shares ({@link failInTransaction}) with
 * {@link HANDOVER_STOP_REASON}: the run id and the apply attempt are cleared, so the run's own
 * next mutation is refused and writes nothing. A run whose apply was claimed may have sent its
 * approved rows, so its ledger records their outcome as unknown, as the apply's dead-man switch
 * would ({@link interruptedApplyLedger}), and it is not recorded as a stop; any other run is a
 * stop when nothing it ran landed.
 *
 * @param ctx - The settle's mutation context.
 * @param agentId - The employee being handed over.
 * @returns How many runs were stopped.
 */
export async function stopRunsForHandover(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
): Promise<number> {
  const running = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'executing'))
    .collect();
  await stopRunsInTransaction(ctx, running, HANDOVER_STOP_REASON);
  return running.length;
}

/**
 * Stop runs under way, in the caller's transaction, through the stop every run's end shares
 * ({@link failInTransaction}): the run id and the apply attempt are cleared, so the run's own
 * next mutation is refused and writes nothing, and the item fails with the reason and the Retry
 * a stopped run offers. A run whose apply was claimed may have sent its approved rows, so its
 * ledger records their outcome as unknown, as the apply's dead-man switch would
 * ({@link interruptedApplyLedger}), and it is not recorded as a stop; any other run is a stop when
 * nothing it ran landed. A handover's deadline stops an employee's runs this way
 * ({@link stopRunsForHandover}), and a Withdraw the runs of the version it withdraws
 * (`skillControls.withdraw`; the wave 10 review, M4).
 *
 * @param ctx - The caller's mutation context.
 * @param rows - The items whose runs stop: executing, or holding the actions a run drafted.
 * @param reason - Why, in the words the item and the record carry after `stopped: `.
 */
export async function stopRunsInTransaction(
  ctx: MutationCtx,
  rows: readonly Doc<'workItems'>[],
  reason: string,
): Promise<void> {
  for (const row of rows) {
    if (row.applyAttemptId !== undefined && row.pendingRunId !== undefined) {
      const { output, applied } = interruptedApplyLedger(row, row.pendingRunId, 'stopped');
      await failInTransaction(ctx, row, {
        reason,
        output: { ...output, applied },
        stopped: false,
      });
    } else {
      await failInTransaction(ctx, row, {
        reason,
        ...(row.output !== undefined ? { output: row.output } : {}),
      });
    }
  }
}

/**
 * Hold an executing run at the exact-action gate and apply what the gate allows.
 *
 * Called by the action that ran the day0 skill instead of applying anything
 * itself. The draft, notes and literal `actions` are persisted with
 * the run id and one verdict per row. Rows the gate classifies `auto` are
 * approved here and applied by the same scheduled path a manager's approval
 * uses, while the row stays `executing`; when nothing is `auto` the row moves
 * to `actions-pending` at once. The hold event records whether autonomous
 * actions were on, so the audit trail shows the mode the verdicts were
 * decided under. Guarded on `executing` so a late caller cannot reopen a run
 * the manager has already decided.
 */
export const setActionsPending = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    runId: v.id('events'),
    output: v.any(),
    authoringAttemptId: v.optional(v.id('events')),
  },
  handler: async (ctx, args): Promise<{ pending: boolean; phase?: 'auto' | 'manager' }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'executing') return { pending: false };
    if (row.executionRunId !== args.runId || row.pendingRunId !== undefined) {
      return { pending: false };
    }
    const dependent = args.authoringAttemptId !== undefined;
    // A closing set must not accept a delayed approval of phase one's indexes.
    const pendingId = args.authoringAttemptId ?? args.runId;
    if (
      dependent
        ? row.applyAttemptId !== args.authoringAttemptId ||
          (args.output as { phase?: unknown }).phase !== 'dependent'
        : row.applyAttemptId !== undefined
    ) {
      return { pending: false };
    }
    const actions = (args.output as { actions?: unknown[] }).actions;
    if (!Array.isArray(actions)) throw new Error('output.actions must be a list');
    const {
      verdicts: actionVerdicts,
      autonomousActions,
      transitionDirectedByNote,
    } = await reviewHeldActions(
      ctx,
      row,
      actions as MockAction[],
      (args.output as { planStepOutcomes?: PlanStepOutcome[] }).planStepOutcomes,
    );
    const autoIndexes = indexesWith(actionVerdicts, 'auto');
    const heldIndexes = indexesWith(actionVerdicts, 'held');
    const refusedIndexes = indexesWith(actionVerdicts, 'refused');
    const refusals = refusedReasonEntries(actionVerdicts, actions.length).map(
      ([index, reason]) => ({ index, reason }),
    );
    const payload: WorkActionsAutoApplyingPayload = {
      workItemId: args.workItemId,
      runId: args.runId,
      actionCount: actions.length,
      autoIndexes,
      heldIndexes,
      refusedIndexes,
      ...(refusals.length > 0 ? { refusals } : {}),
      autonomousActions,
      ...(dependent ? { dependentPhase: true } : {}),
      ...(transitionDirectedByNote ? { transitionDirectedByNote: true } : {}),
    };
    if (autoIndexes.length > 0) {
      await ctx.db.patch(args.workItemId, {
        output: args.output,
        pendingRunId: pendingId,
        approvedIndexes: autoIndexes,
        applyPhase: 'auto',
        actionVerdicts,
        applyAttemptId: undefined,
        applyClaimedAt: undefined,
      });
      await appendEvent(ctx, {
        agentId: row.agentId,
        type: 'work.actions-auto-applying',
        payload,
        createdAt: Date.now(),
      });
      await scheduleApply(ctx, args.workItemId, pendingId, 'auto');
      return { pending: true, phase: 'auto' };
    }
    // A phase-one run that holds nothing for the manager (no actions, or every
    // one refused by the gate) has nothing to decide: parked, it would hold
    // the slot with both approve controls disabled and no request sent (P5-3).
    if (!dependent && heldIndexes.length === 0) {
      await appendEvent(ctx, {
        agentId: row.agentId,
        type: 'work.actions-pending',
        payload,
        createdAt: Date.now(),
      });
      await failInTransaction(ctx, row, {
        reason:
          refusals.length > 0
            ? `${NOTHING_TO_DECIDE_REASON}: Day0's gate refused every action (${refusals[0].reason}), so nothing was sent`
            : `${NOTHING_TO_DECIDE_REASON}: it emitted no actions`,
        output: args.output,
      });
      return { pending: false };
    }
    await ctx.db.patch(args.workItemId, {
      state: 'actions-pending',
      waitingSince: Date.now(),
      output: args.output,
      pendingRunId: pendingId,
      approvedIndexes: undefined,
      applyPhase: undefined,
      actionVerdicts,
      applyAttemptId: undefined,
      applyClaimedAt: undefined,
      // Whatever decision the row carries answered an earlier park (the plan,
      // or phase one's set); this set has not been asked about (review M5).
      decision: undefined,
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.actions-pending',
      payload,
      createdAt: Date.now(),
    });
    await scheduleDecisionRequest(ctx, row, 'actions');
    await settleHandoverAfterRun(ctx, row.agentId);
    return { pending: true, phase: 'manager' };
  },
});

/**
 * Take the approved actions for application, exactly once.
 *
 * The apply action is scheduled by `setActionsPending` (the auto phase) and
 * by `approveActions` (the manager's), and may be scheduled again after a
 * restart; whichever caller records the apply attempt on the row is the one
 * that applies. In the auto phase the row is still `executing` and the fence
 * is the absent attempt id; in the approved phase it moves the row from
 * `actions-pending` back to `executing`. The caller gets everything it needs
 * from the row so it never re-reads state that may have moved. The toggle is
 * read here, in the claim's transaction, so the apply backstop sees the
 * manager's latest word rather than the one the hold was decided under.
 */
export const claimApprovedActions = internalMutation({
  args: { workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<
    | {
        claimed: true;
        agentId: Id<'agents'>;
        runId: Id<'events'>;
        pendingRunId: Id<'events'>;
        applyAttemptId: Id<'events'>;
        phase: 'auto' | 'approved';
        approvedIndexes: number[];
        heldIndexes: number[];
        heldReasons: Array<[number, string]>;
        autonomousActions: boolean;
        replyTarget?: ReplyTarget;
        output: unknown;
      }
    | { claimed: false; reason: string }
  > => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    const autoPhase =
      row.state === 'executing' && row.applyPhase === 'auto' && row.applyAttemptId === undefined;
    if (row.state !== 'actions-pending' && !autoPhase) {
      return { claimed: false, reason: `workItem state is ${row.state}; expected actions-pending` };
    }
    if (!row.pendingRunId) return { claimed: false, reason: 'workItem has no pending run' };
    if (!row.approvedIndexes) return { claimed: false, reason: 'no actions have been approved' };
    // A paused employee, or a paused deployment, starts no apply in either phase (12-P): held at
    // this claim, never between two actions of one apply, and the set, approved or auto, waits for
    // the resume's pass, or the sweep's once the deployment's jobs run again.
    const permission = await stepMayRun(ctx.db, row.agentId);
    if (!permission.mayRun) return { claimed: false, reason: permission.reason };
    // A manager's approval does not start its apply while the employee is being handed over
    // (D18): the set returns to held at the move (D13). The auto phase belongs to a run already
    // executing, which the move waits for.
    if (!autoPhase && (await isBeingHandedOver(ctx.db, row.agentId))) {
      return { claimed: false, reason: HANDOVER_IN_PROGRESS_REASON };
    }
    // An approved write on a surface that waits for its connection (one a handover cut, for
    // one) parks on it rather than meeting the gate's refusal: connecting it returns the item
    // (U-3). The auto phase's rows were judged connected at the hold, so the gate keeps them.
    const missingSurface = autoPhase
      ? undefined
      : await surfaceAwaitingConnection(ctx.db, row, Date.now());
    if (missingSurface !== undefined) {
      await parkOnConnection(ctx, row, missingSurface);
      return { claimed: false, reason: `parked until ${missingSurface} is connected` };
    }
    // A missing agent row is the apply action's failure to report (it fences
    // the run as outcome-unknown); the claim only needs the switch's value.
    const agent = await ctx.db.get(row.agentId);
    const applyAttemptId = await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.actions-applying',
      payload: {
        workItemId: args.workItemId,
        runId: row.executionRunId ?? row.pendingRunId,
        phase: autoPhase ? 'auto' : 'approved',
      },
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.workItemId, {
      state: 'executing',
      applyAttemptId,
      applyClaimedAt: Date.now(),
    });
    // The switch counts from the claim: an apply that started late still has
    // its whole window before its outcomes are recorded as unknown (P9-1).
    await armApplySwitch(ctx, args.workItemId, row.pendingRunId, autoPhase ? 'auto' : 'approved');
    const count = actionsOf(row.output).length;
    return {
      claimed: true,
      agentId: row.agentId,
      runId: row.executionRunId ?? row.pendingRunId,
      pendingRunId: row.pendingRunId,
      applyAttemptId,
      phase: autoPhase ? 'auto' : 'approved',
      approvedIndexes: row.approvedIndexes,
      heldIndexes: indexesWith(verdictList(row.actionVerdicts, count), 'held'),
      heldReasons: refusedReasonEntries(row.actionVerdicts, count),
      autonomousActions: agent ? autonomousActionsOn(agent) : false,
      replyTarget: replyTargetFor(row),
      output: row.output,
    };
  },
});

/** One ledger row an apply in flight reports (`ReportedRow`, `src/work/apply-progress.ts`). */
const reportedRowValidator = v.object({
  tool: v.string(),
  idempotencyKey: v.string(),
  ok: v.boolean(),
  held: v.optional(v.boolean()),
  outcomeUnknown: v.optional(v.boolean()),
  awaitingApproval: v.optional(v.boolean()),
  effect: v.optional(v.string()),
  reason: v.optional(v.string()),
  providerId: v.optional(v.string()),
  landedAt: v.optional(v.number()),
  authority: v.optional(
    v.union(v.literal('manager'), v.literal('autonomous'), v.literal('standing')),
  ),
  actionClass: v.optional(
    v.union(
      v.literal('read'),
      v.literal('manager-dm'),
      v.literal('public-post'),
      v.literal('mutation'),
      v.literal('write'),
    ),
  ),
  redaction: v.optional(v.literal('structural-only')),
  elements: v.optional(v.array(v.object({ ref: v.string(), name: v.string(), role: v.string() }))),
  repair: v.optional(v.object({ reason: v.string(), toolArgsJson: v.string() })),
});

/**
 * Keep one row of an apply in flight the moment it is decided (P4-2), so a throw, a dead action or
 * a Stop later in the list leaves it on the record: the recovery
 * (`work.recoverInterruptedApply`, the stop) keeps a reported row as it reported and marks unknown
 * only the rows that never did.
 *
 * Internal; the apply action's (`workActions.applyApprovedActions`), once per row. Fenced on the
 * apply's claim: the row must still be `executing` under `applyAttemptId`. Writes the row into
 * `output.applyProgress` and nothing else.
 *
 * @returns Whether the apply still holds its claim; false tells it to send nothing more.
 */
export const recordApplyOutcome = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    applyAttemptId: v.id('events'),
    index: v.number(),
    row: reportedRowValidator,
  },
  handler: async (ctx, args): Promise<boolean> => {
    const item = await ctx.db.get(args.workItemId);
    if (!item || item.state !== 'executing' || item.applyAttemptId !== args.applyAttemptId) {
      return false;
    }
    await ctx.db.patch(item._id, {
      output: withReportedOutcome(item.output, args.applyAttemptId, {
        index: args.index,
        ...reportedRow(args.row),
      }),
    });
    return true;
  },
});

/**
 * Cancel the step the loop last queued for a row (`stepJobId`), when it has not started.
 *
 * A step already running is not cancelled here: it is held off by the fences the stop clears
 * (`executionRunId`, `applyAttemptId`), and an apply in flight learns at its next report.
 *
 * @param ctx - The stop's mutation context.
 * @param row - The row being stopped.
 * @returns Whether a queued step was cancelled.
 */
async function cancelQueuedStep(ctx: MutationCtx, row: Doc<'workItems'>): Promise<boolean> {
  if (row.stepJobId === undefined) return false;
  const job = await ctx.db.system.get(row.stepJobId);
  await ctx.db.patch(row._id, { stepJobId: undefined });
  if (job?.state.kind !== 'pending') return false;
  await ctx.scheduler.cancel(job._id);
  return true;
}

/**
 * Public, owner-guarded (`assertOwnsWorkItem`): the manager stops an item the employee is working
 * (`claimed`, `plan-approved`, `executing`; wave 6 B D3, built in wave 12).
 *
 * The queued step is cancelled, and the run ends through the stop every run's end shares
 * (`stopRunsInTransaction`, the handover's and the withdraw's): its run id and apply claim are
 * cleared, so every later write of the run is refused at its fence; an apply in flight keeps
 * every row it reported and records the rest as outcome unknown, never as not sent. The item is
 * `failed` under the stopped prefix with the manager's reason, and Retry stands. Writes a
 * `work.stopped` event naming the manager. Refuses, as a `ConvexError` the card says, an item no
 * longer under way.
 */
export const stopRun = mutation({
  args: { workItemId: v.id('workItems'), reason: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (!isStoppable(row.state)) {
      throw new ConvexError('Only work under way can be stopped; this item has moved on.');
    }
    const identity = await getCallerOrThrow(ctx);
    const note = managerText(args.reason);
    const applyInFlight = row.applyAttemptId !== undefined && row.pendingRunId !== undefined;
    await cancelQueuedStep(ctx, row);
    await stopRunsInTransaction(ctx, [row], managerStopReason(note));
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.stopped',
      payload: {
        workItemId: row._id,
        fromState: row.state,
        actor: identity.ownerKey,
        ...(note !== '' ? { reason: note } : {}),
        applyInFlight,
      },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Public, owner-guarded (`assertOwnsWorkItem`): the manager closes a stopped or failed item whose
 * ledger names nothing to reconcile, without a retry (E-8). It is N7's dismissal: the item leaves
 * the needs-you inbox and the roster's figure and stays in the record, and Retry still sends it
 * back where Retry is open. It is also the one way out of an interrupted apply that could not say
 * what it sent, which Retry, Dismiss and the reconciliation all refuse. Writes `dismissedAt` and a
 * `work.closed-without-retry` event naming the manager, once. Refuses, as a `ConvexError` the
 * card says, an item no longer failed and one with a write to reconcile.
 */
export const closeWithoutRetry = mutation({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ ok: true; dismissedAt: number }> => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'failed') {
      throw new ConvexError('Only a stopped or failed item can be closed; this one has moved on.');
    }
    if (row.dismissedAt !== undefined) return { ok: true, dismissedAt: row.dismissedAt };
    if (providerReconciliationEntries(row.output).length > 0) {
      throw new ConvexError(
        'A write on this item may have landed: check it against the provider, then Retry or Dismiss it.',
      );
    }
    const identity = await getCallerOrThrow(ctx);
    const dismissedAt = Date.now();
    await ctx.db.patch(row._id, { dismissedAt });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.closed-without-retry',
      payload: { workItemId: row._id, actor: identity.ownerKey },
      createdAt: dismissedAt,
    });
    return { ok: true, dismissedAt };
  },
});

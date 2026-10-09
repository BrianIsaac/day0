import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { planDraftedWithoutValidator } from './schema';
import { assertOwnsWorkItem } from './ownership';
import { answerQuestionInTransaction, askOpenQuestionsAtPlan } from './managerQuestions';
import { markCorrectionsAppliedInTransaction } from './corrections';
import {
  AGREEMENT_STATEMENT_EMPTY,
  keepPlanNoteInTransaction,
  markAgreementsAppliedInTransaction,
  scheduleProposalsAfterPlan,
} from './workingAgreements';
import { appendEvent } from './eventLog';
import { MANAGER_FEEDBACK_MAX_CHARS, sendBackToDrafting } from './work';
import { approvePlanInTransaction, type ManagerAnswerRow } from './managerDecisions';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { toSurfaceRecord } from '../src/surfaces/records';
import { verdictFor } from '../src/surfaces/verdict';
import type { ExecutionPlan } from '../src/work/types';

/*
 * A plan's arrival and its approval (wave 13, 13-W; the standard's 9.2, F8): the regions of
 * `convex/work.ts` that store a drafted plan and approve it, moved here as 13-W edits them. This
 * module sits above `convex/work.ts`: it imports the work loop's helpers and `convex/work.ts` never
 * imports it, so the move closes no import cycle (12-W's Findings 1 on `convex/workRuns.ts`, the
 * same direction). Its functions are registered as `planApproval:*`.
 */

/**
 * The plan as stored: a plan may say it applied only this employee's own
 * active corrections, so any other id is dropped, and each one kept lists
 * the work item it was applied to. A plan that names none is stored as
 * drafted.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item whose plan is being stored.
 *   drafted: The plan the planner returned.
 *
 * Returns:
 *   The plan to store and the corrections it applied.
 */
async function withAppliedCorrections(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  drafted: unknown,
): Promise<{ plan: ExecutionPlan; applied: Id<'corrections'>[] }> {
  const plan = drafted as ExecutionPlan;
  if (!plan || typeof plan !== 'object' || plan.appliedCorrections === undefined) {
    return { plan, applied: [] };
  }
  const { appliedCorrections, ...rest } = plan;
  const applied = await markCorrectionsAppliedInTransaction(ctx, row, appliedCorrections);
  return { plan: applied.length > 0 ? { ...rest, appliedCorrections: applied } : rest, applied };
}

/**
 * The plan as stored with the working agreements it applied: only ids the planner was offered
 * that are still active and bind this employee are kept, and each kept one lists the work item in
 * `appliedTo`. A plan that names none is stored as it came.
 *
 * @param ctx - Mutation context.
 * @param row - The work item whose plan is being stored.
 * @param plan - The plan, its corrections already settled.
 */
async function withAppliedAgreements(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  plan: ExecutionPlan,
): Promise<ExecutionPlan> {
  if (!plan || typeof plan !== 'object' || plan.appliedAgreements === undefined) return plan;
  const { appliedAgreements, ...rest } = plan;
  const applied = await markAgreementsAppliedInTransaction(ctx, row, appliedAgreements);
  return applied.length > 0 ? { ...rest, appliedAgreements: applied } : rest;
}

/**
 * Store a drafted plan and park the row for its decision. Internal; the
 * drafting action's. `draftedWithout` says the plan was drafted without its
 * ticket or thread (P7-18); a plan drafted with it clears an earlier one's. A
 * plan drafted while its system was down, which is connected by now, is not
 * stored: the row goes straight back to drafting (`redrafting`).
 *
 * `draftClaimedAt` is the claim a real-mode draft took before its model call
 * (`claimLoopStep`). Only the draft that still holds that claim stores its
 * plan: a draft the manager stopped, whose row Retry sent back to `claimed`
 * with the claim cleared, finds the row ready again and would otherwise land
 * the plan drafted before the Retry over its successor's (`superseded`; wave
 * 12, 12-W and 12-P Findings 3). A caller that took no claim (the page's
 * mock-mode draft) is fenced by the state alone.
 */
export const setPlan = internalMutation({
  args: {
    workItemId: v.id('workItems'),
    plan: v.any(),
    draftedWithout: v.optional(planDraftedWithoutValidator),
    draftClaimedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    stored: boolean;
    redrafting?: true;
    superseded?: true;
    movedOn?: Doc<'workItems'>['state'];
  }> => {
    const row = await ctx.db.get(args.workItemId);
    if (!row) throw new Error('workItem not found');
    if (row.state !== 'claimed') return { stored: false, movedOn: row.state };
    if (args.draftClaimedAt !== undefined && row.draftClaimedAt !== args.draftClaimedAt) {
      return { stored: false, superseded: true };
    }
    // The system the draft could not read connected while the model drafted:
    // a connection that landed first found no plan to send back, so this does.
    if (args.draftedWithout?.cause === 'not-connected') {
      const source = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', row.agentId).eq('slug', args.draftedWithout!.surfaceSlug),
        )
        .unique();
      const now = Date.now();
      if (source && verdictFor(toSurfaceRecord(source), now) === 'connected') {
        await sendBackToDrafting(ctx, row, source, now);
        return { stored: false, redrafting: true };
      }
    }
    const corrected = await withAppliedCorrections(ctx, row, args.plan);
    const { applied } = corrected;
    const plan = await withAppliedAgreements(ctx, row, corrected.plan);
    await ctx.db.patch(args.workItemId, {
      plan,
      state: 'plan-pending',
      planDraftedWithout: args.draftedWithout,
      ...(SURFACE_MODE === 'real' ? { planPendingAt: Date.now() } : {}),
      waitingSince: Date.now(),
      ...(row.draftClaimedAt !== undefined ? { draftClaimedAt: undefined } : {}),
    });
    await appendEvent(ctx, {
      agentId: row.agentId,
      type: 'work.plan-drafted',
      payload: { workItemId: args.workItemId, plan },
      createdAt: Date.now(),
    });
    if (applied.length > 0) {
      await appendEvent(ctx, {
        agentId: row.agentId,
        type: 'work.corrections-applied',
        payload: {
          workItemId: args.workItemId,
          correctionIds: applied,
          ...(plan.correctionsRedaction ? { redaction: plan.correctionsRedaction } : {}),
        },
        createdAt: Date.now(),
      });
    }
    // The charter's open questions this plan touches are asked here, before
    // execution, and once per question for the agent.
    await askOpenQuestionsAtPlan(ctx, row, plan);
    // A correction this plan applied may now govern a second item (13-W).
    await scheduleProposalsAfterPlan(ctx, row.agentId);
    return { stored: true };
  },
});

/**
 * Record the manager's answers given with the approval, in the same
 * transaction as the approval.
 *
 * An answer to one of the charter's open questions goes through the
 * question's own record, which amends the charter when the question is
 * still open there; the note answers the planner's own risk notes and goes
 * nowhere but this run. Every answer reaches the executor as approved
 * evidence. A question asked on another work item is refused: the manager
 * answers what this plan raised.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The plan-pending work item.
 *   answers: The answers to the charter's questions asked on this item.
 *   note: The manager's answer to the planner's note, if any.
 *
 * Returns:
 *   The rows to keep on the work item, empty when nothing was answered.
 */
async function answerPlanQuestions(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  answers: ReadonlyArray<{ questionId: Id<'managerQuestions'>; text: string }>,
  note: string | undefined,
): Promise<ManagerAnswerRow[]> {
  const now = Date.now();
  const kept: ManagerAnswerRow[] = [];
  for (const entry of answers) {
    const record = await ctx.db.get(entry.questionId);
    if (!record || record.workItemId !== row._id) {
      throw new Error('that question was not asked on this work item');
    }
    await answerQuestionInTransaction(ctx, record, entry.text, 'plan-approval');
    kept.push({
      question: record.question,
      answer: entry.text.replace(/\s+/g, ' ').trim(),
      answeredAt: now,
      questionId: record._id,
    });
  }
  const trimmedNote = note?.replace(/\s+/g, ' ').trim().slice(0, MANAGER_FEEDBACK_MAX_CHARS);
  if (trimmedNote) {
    const plan = row.plan as { riskNotes?: string } | undefined;
    const riskNotes = plan?.riskNotes?.trim();
    kept.push({
      question: riskNotes ? riskNotes : "the planner's note",
      answer: trimmedNote,
      answeredAt: now,
    });
  }
  return kept;
}

/** The longest manual estimate the plan card takes: a working month. */
const MANUAL_ESTIMATE_MAX_MINUTES = 10_000;

/**
 * Public, owner-guarded (`assertOwnsWorkItem`): approves an item's plan, answering any charter
 * question the card asked, and schedules the run; with `keepNote`, also keeps the note as a working
 * agreement and schedules its check, in the same transaction.
 */
export const approvePlan = mutation({
  args: {
    workItemId: v.id('workItems'),
    /** Answers to the charter's open questions asked on this plan; each amends the charter. */
    answers: v.optional(
      v.array(v.object({ questionId: v.id('managerQuestions'), text: v.string() })),
    ),
    /** The manager's answer to the planner's own note, for this run. */
    note: v.optional(v.string()),
    /** N11: "this would have taken me about N minutes", optional; hours saved sums it. */
    manualEstimateMinutes: v.optional(v.number()),
    /**
     * "Keep this note for later work of this kind" (13-W): the note is kept as a working agreement
     * for this employee in the same click, active once its check against the charter answers.
     */
    keepNote: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await assertOwnsWorkItem(ctx, args.workItemId);
    if (row.state !== 'plan-pending') {
      throw new Error(`workItem state is ${row.state}; expected plan-pending`);
    }
    const estimate = args.manualEstimateMinutes;
    if (
      estimate !== undefined &&
      (!Number.isInteger(estimate) || estimate < 1 || estimate > MANUAL_ESTIMATE_MAX_MINUTES)
    ) {
      throw new ConvexError(
        `The estimate is a whole number of minutes from 1 to ${MANUAL_ESTIMATE_MAX_MINUTES}.`,
      );
    }
    if (estimate !== undefined) await ctx.db.patch(row._id, { manualEstimateMinutes: estimate });
    // Approve-with-answer is one decision: the answers land, the charter is
    // amended where a question is still open there, and the plan is approved
    // in the same transaction, or none of it happens.
    const answers = await answerPlanQuestions(ctx, row, args.answers ?? [], args.note);
    await approvePlanInTransaction(ctx, row, 'dashboard', undefined, answers);
    if (args.keepNote === true) {
      if (!args.note?.trim()) throw new ConvexError(AGREEMENT_STATEMENT_EMPTY);
      await keepPlanNoteInTransaction(ctx, row, args.note);
    }
    return { ok: true };
  },
});

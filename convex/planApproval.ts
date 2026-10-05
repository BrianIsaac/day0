import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { planDraftedWithoutValidator } from './schema';
import { askOpenQuestionsAtPlan } from './managerQuestions';
import { markCorrectionsAppliedInTransaction } from './corrections';
import { appendEvent } from './eventLog';
import { sendBackToDrafting } from './work';
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
    const { plan, applied } = await withAppliedCorrections(ctx, row, args.plan);
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
    return { stored: true };
  },
});

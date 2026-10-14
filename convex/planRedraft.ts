import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { WorkPlanRedraftingPayload } from '../src/events/contract';
import { rememberReplacedRequest } from './decisionRequests';
import { appendEvent } from './eventLog';
import { closeQuestionsAtRedraft } from './questionCloses';
import { scheduleNextStep } from './workLoop';

/**
 * Plan-pending rows one connection reads for plans to draft again; an
 * employee's parked plans are bounded by its work cap, far below this.
 */
const REDRAFT_SCAN = 200;

/**
 * Send back to drafting every undecided plan drafted while this surface was
 * not connected, now that it is (P7-18): the plan is drafted again from the
 * record it could not read, and its request gives way to the new plan's, as
 * a Retry's re-draft does. A plan whose read failed on a connected system is
 * left to the manager.
 *
 * @param surface - The surface that has just connected.
 * @param now - When it connected.
 */
export async function redraftPlansDraftedWithout(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<void> {
  const parked = await ctx.db
    .query('workItems')
    .withIndex('by_agent_state', (q) =>
      q.eq('agentId', surface.agentId).eq('state', 'plan-pending'),
    )
    .take(REDRAFT_SCAN);
  for (const row of parked) {
    const without = row.planDraftedWithout;
    if (without?.surfaceSlug !== surface.slug || without.cause !== 'not-connected') continue;
    if (row.decision?.decidedAt !== undefined) continue;
    await sendBackToDrafting(ctx, row, { surface }, now);
  }
}

/** Why a plan goes back to drafting: its system connected, or a card's Approve changed its ground. */
export type RedraftCause =
  | { readonly surface: Doc<'surfaces'> }
  | { readonly card: Pick<Doc<'reorientations'>, '_id' | 'triggerSummary'> };

/**
 * Send one undecided row back to drafting, as a Retry's re-draft resets it: no
 * plan, no request, no answers, its conflict questions closed (17-C: the new
 * plan is asked on what it cites), and the draft scheduled in the same
 * transaction. Because the system its plan could not read is connected now
 * (P7-18), or because a card that held it was approved with a change to what
 * the plan was drafted under (V17-9).
 */
export async function sendBackToDrafting(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  cause: RedraftCause,
  now: number,
): Promise<void> {
  await rememberReplacedRequest(ctx, row, now);
  await closeQuestionsAtRedraft(ctx, row._id, now);
  await ctx.db.patch(row._id, {
    state: 'claimed',
    plan: undefined,
    planPendingAt: undefined,
    planDraftedWithout: undefined,
    decision: undefined,
    managerAnswers: undefined,
    draftClaimedAt: undefined,
    heldThroughChangeAt: undefined,
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.plan-redrafting',
    payload: {
      workItemId: row._id,
      ...('surface' in cause
        ? { surfaceId: cause.surface._id, slug: cause.surface.slug }
        : { reorientationId: cause.card._id, summary: cause.card.triggerSummary }),
    } satisfies WorkPlanRedraftingPayload,
    createdAt: now,
  });
  await scheduleNextStep(ctx, { ...row, state: 'claimed', plan: undefined });
}

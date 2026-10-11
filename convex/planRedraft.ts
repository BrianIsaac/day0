import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { rememberReplacedRequest } from './decisionRequests';
import { appendEvent } from './eventLog';
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
    await sendBackToDrafting(ctx, row, surface, now);
  }
}

/**
 * Send one row back to drafting because the system its plan could not read
 * is connected now, as a Retry's re-draft resets it: no plan, no request, no
 * answers, and the draft scheduled in the same transaction.
 */
export async function sendBackToDrafting(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  surface: Doc<'surfaces'>,
  now: number,
): Promise<void> {
  await rememberReplacedRequest(ctx, row, now);
  await ctx.db.patch(row._id, {
    state: 'claimed',
    plan: undefined,
    planPendingAt: undefined,
    planDraftedWithout: undefined,
    decision: undefined,
    managerAnswers: undefined,
    draftClaimedAt: undefined,
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.plan-redrafting',
    payload: { workItemId: row._id, surfaceId: surface._id, slug: surface.slug },
    createdAt: now,
  });
  await scheduleNextStep(ctx, { ...row, state: 'claimed', plan: undefined });
}

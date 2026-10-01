import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

/*
 * Work in flight while a handover is accepted and finishing (the transfer plan,
 * section 6.4; decision D18). Once the named manager accepts an employee that
 * has runs executing, its request is `accepting`: no new run starts, each run
 * that ends asks the request to settle, and the move waits for the last of
 * them or for the request's `settleBy`. The work loop's gates and exits read
 * the request through this module, which imports nothing of the loop's or the
 * acceptance's, so neither has to import the other (standard 10.2).
 */

/** Why a run does not start while the employee is being handed over: a claim's refusal. */
export const HANDOVER_IN_PROGRESS_REASON =
  'the employee is being handed over to a new manager, so no new run starts';

/**
 * Why the settle stopped a run that outlived the handover's deadline, as the stop records it
 * (`stoppedReason` adds the stop's prefix when nothing landed).
 */
export const HANDOVER_STOP_REASON = 'the employee was handed over to a new manager';

/**
 * The employee's request that has its acceptance and waits for runs in flight, or null. At most
 * one request of an employee is open (`MAX_OPEN_TRANSFERS_PER_EMPLOYEE`), so one indexed read
 * answers it.
 *
 * @param db - Any reader.
 * @param agentId - The employee.
 */
export async function acceptingTransferOf(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
): Promise<Doc<'managerTransfers'> | null> {
  return await db
    .query('managerTransfers')
    .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'accepting'))
    .first();
}

/**
 * Whether the employee is being handed over: a request of theirs is `accepting`, so no new run
 * may start (D18).
 *
 * @param db - Any reader.
 * @param agentId - The employee.
 */
export async function isBeingHandedOver(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
): Promise<boolean> {
  return (await acceptingTransferOf(db, agentId)) !== null;
}

/**
 * Ask the employee's finishing handover to settle, from a path out of a run (a park for the
 * manager, a completion, a failure or stop, a return to the approved plan, an interrupted apply's
 * record): the settle moves the employee once no run is left, and does nothing while one is.
 * Scheduled rather than run here, so the move is its own transaction and never part of the run's
 * last write. Nothing is scheduled for an employee with no `accepting` request.
 *
 * @param ctx - The mutation that ended the run.
 * @param agentId - The run's employee.
 * @returns Whether a settle was scheduled.
 */
export async function settleHandoverAfterRun(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
): Promise<boolean> {
  const transfer = await acceptingTransferOf(ctx.db, agentId);
  if (transfer === null) return false;
  await ctx.scheduler.runAfter(0, internal.transferAcceptance.settle, {
    transferId: transfer._id,
  });
  return true;
}

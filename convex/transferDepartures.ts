import { v, type Infer } from 'convex/values';
import { isDepartureListed } from '../src/agent/manager-transfer';
import type { Doc } from './_generated/dataModel';
import { query, type QueryCtx } from './_generated/server';
import { assertOwnsAgent, getCallerOrThrow } from './ownership';

/**
 * The most handover requests one employee's reads take. A request is asked at most once at a
 * time and the per-account bounds keep the history short, so this is far above any real count.
 */
const EMPLOYEE_REQUESTS_LIMIT = 200;

/**
 * What became of an employee after the handover the old manager reads: came back to them since
 * (the handover is no longer where it went, and ends the card's line of answers), retired since
 * (its row is gone), or moved on to a manager other than the one that took it on. Absent while it
 * is with that manager still.
 */
export const afterwardsValidator = v.union(
  v.literal('came-back'),
  v.literal('retired'),
  v.literal('moved-on'),
);

/** What became of an employee after a handover; see {@link afterwardsValidator}. */
export type HandoverAfterwards = Infer<typeof afterwardsValidator>;

/**
 * What became of the employee an accepted request moved, as the manager who asked reads it now.
 * Handed back to the reader since, it came back: the handover is no longer where it went,
 * whatever became of it after (the wave 10 bed: a manager who took an employee back and retired it
 * read that it was "handed over ... and has since been retired"). Otherwise, its row gone, it was
 * retired since (a retire or a reset deletes the row, and the request outlives it by design);
 * with a manager other than the one that accepted, it moved on; nothing while it is with that
 * manager, or with the reader, whose roster names it.
 *
 * @param transfer - The accepted request the reader asked.
 * @param readerKey - The owner key of the manager who reads it.
 */
export async function afterwardsOf(
  ctx: QueryCtx,
  transfer: Doc<'managerTransfers'>,
  readerKey: string,
): Promise<HandoverAfterwards | undefined> {
  const [accepted, employee] = await Promise.all([
    ctx.db
      .query('managerTransfers')
      .withIndex('by_agent_state', (q) => q.eq('agentId', transfer.agentId).eq('state', 'accepted'))
      .order('desc')
      .take(EMPLOYEE_REQUESTS_LIMIT),
    ctx.db.get(transfer.agentId),
  ]);
  if (lastDeparture(accepted, readerKey)?._id !== transfer._id) return 'came-back';
  if (employee === null) return 'retired';
  // With the reader, it is on their roster, which says so; nothing to add.
  if (employee.userId === transfer.toOwnerKey || employee.userId === readerKey) return undefined;
  return 'moved-on';
}

/** Where an employee the reader handed over went, and what became of it since. */
const departureValidator = v.object({
  transferId: v.id('managerTransfers'),
  agentName: v.string(),
  toAddress: v.string(),
  decidedAt: v.number(),
  afterwards: v.optional(afterwardsValidator),
});

/** What the employee page draws for its reader; see {@link employeePage}. */
const employeePageValidator = v.union(
  v.object({ page: v.literal('employee') }),
  v.object({ page: v.literal('departed'), departure: departureValidator }),
  v.object({ page: v.literal('not-yours') }),
);

/** What the employee page draws for its reader, as {@link employeePage} answers it. */
export type EmployeePage = Infer<typeof employeePageValidator>;

/**
 * The reader's last handover of an employee, unless it came back to them since: the newest
 * accepted request the reader asked, with no accepted request to the reader after it.
 */
function lastDeparture(
  accepted: readonly Doc<'managerTransfers'>[],
  readerKey: string,
): Doc<'managerTransfers'> | undefined {
  const decided = (transfer: Doc<'managerTransfers'>): number =>
    transfer.decidedAt ?? transfer.requestedAt;
  const newestFirst = accepted.toSorted((left, right) => decided(right) - decided(left));
  const own = newestFirst.find((transfer) => transfer.fromOwnerKey === readerKey);
  if (own === undefined) return undefined;
  const back = newestFirst.some(
    (transfer) => transfer.toOwnerKey === readerKey && decided(transfer) > decided(own),
  );
  return back ? undefined : own;
}

/**
 * Public, for the employee page before it reads the employee: what the page draws for the
 * caller, answered without a refusal, so a page for an employee the caller no longer holds never
 * subscribes to the read that refuses it (the v0.12.0 walk: that refusal reached the old
 * manager's console on every load). `employee` for the caller's own employee, and for an id that
 * names no employee or none the caller ever handed over, which the page's own read then answers;
 * `departed` with where it went and what became of it since, for one the caller handed over in
 * the thirty days the home lists it (`isDepartureListed`, the operator's ruling of 2 October,
 * decision 8), and past them as any employee not the caller's; `not-yours` for another account's
 * employee, as the page's own read would refuse it. A
 * caller with no identity is refused (`getCallerOrThrow`, 12-G). Writes nothing.
 */
export const employeePage = query({
  args: { agentId: v.string() },
  returns: employeePageValidator,
  handler: async (ctx, args): Promise<EmployeePage> => {
    const caller = await getCallerOrThrow(ctx);
    const agentId = ctx.db.normalizeId('agents', args.agentId);
    if (agentId === null) return { page: 'employee' };
    const employee = await ctx.db.get(agentId);
    if (employee !== null && employee.userId === caller.ownerKey) return { page: 'employee' };
    const accepted = await ctx.db
      .query('managerTransfers')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'accepted'))
      .order('desc')
      .take(EMPLOYEE_REQUESTS_LIMIT);
    const own = lastDeparture(accepted, caller.ownerKey);
    // Past the home's window the handover is no longer the reader's to read (decision 8): the
    // link answers as any employee that is not theirs does.
    if (own === undefined || !isDepartureListed(own.decidedAt ?? own.requestedAt, Date.now())) {
      return employee === null ? { page: 'employee' } : { page: 'not-yours' };
    }
    const afterwards = await afterwardsOf(ctx, own, caller.ownerKey);
    return {
      page: 'departed',
      departure: {
        transferId: own._id,
        agentName: own.agentName,
        toAddress: own.toAddress,
        decidedAt: own.decidedAt ?? own.requestedAt,
        ...(afterwards === undefined ? {} : { afterwards }),
      },
    };
  },
});

/**
 * Public, owner-guarded by `assertOwnsAgent`: how many handover requests name the employee, in
 * any state, for the retire dialog's account of what a retire keeps. A retire deletes none of
 * them (`RETIRE_RECORD_TABLES`): each is the other manager's record of the handover. Writes
 * nothing.
 */
export const keptAtRetire = query({
  args: { agentId: v.id('agents') },
  returns: v.object({ requests: v.number() }),
  handler: async (ctx, args): Promise<{ requests: number }> => {
    await assertOwnsAgent(ctx, args.agentId);
    const requests = await ctx.db
      .query('managerTransfers')
      .withIndex('by_agent_state', (q) => q.eq('agentId', args.agentId))
      .take(EMPLOYEE_REQUESTS_LIMIT);
    return { requests: requests.length };
  },
});

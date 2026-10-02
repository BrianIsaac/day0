import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  internalMutation,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import {
  AGENT_EVENT_TYPES,
  type EventType,
  type LoggedEvent,
  type NewEvent,
} from '../src/events/contract';
import { log as logger } from '../src/lib/logger';

/*
 * The two ways an event reaches the ledger, both typed by the event contract
 * (`src/events/contract.ts`, decisions N10 and Q14): a mutation appends in its
 * own transaction, an action logs through `log` below. No other code inserts
 * into `events`; `tests/src/events/contract.test.ts` holds the tree to it, so
 * a type the contract does not list fails the typecheck, and so does a
 * payload that is not its type's.
 */

/**
 * Append one event in the caller's transaction.
 *
 * @param ctx - The mutation's context.
 * @param event - The event: a type the contract lists, with that type's payload.
 * @returns The new event's id, which a run or a claim keys on.
 */
export async function appendEvent(
  ctx: Pick<MutationCtx, 'db'>,
  event: NewEvent,
): Promise<Id<'events'>> {
  return await ctx.db.insert('events', event);
}

/**
 * A lower bound on the creation time of the events `eventsOfType` reads:
 * strictly after an instant, or from it on.
 */
export type CreatedBound = { readonly after: number } | { readonly from: number };

/**
 * The index read of one agent's events of one type, for the caller to order,
 * bound and collect. The type is one the contract lists, so a misspelt type is
 * a typecheck failure rather than a read that finds nothing (S D4).
 *
 * @param ctx - A query's or a mutation's context.
 * @param agentId - The agent whose events are read.
 * @param type - The event type.
 * @param created - An optional lower bound on the events' creation time.
 */
export function eventsOfType(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
  type: EventType,
  created?: CreatedBound,
) {
  return ctx.db.query('events').withIndex('by_agent_type', (index) => {
    const ofType = index.eq('agentId', agentId).eq('type', type);
    if (created === undefined) return ofType;
    return 'after' in created
      ? ofType.gt('_creationTime', created.after)
      : ofType.gte('_creationTime', created.from);
  });
}

/** How an action's event is fenced: by the owner the action read the employee under. */
export interface LogFence {
  /**
   * The employee's owner key when the action began. The event is appended only while the
   * employee is still that owner's: an action still running when a handover moved it would
   * otherwise write onto the new owner's record what it did under the old one (U3-m2).
   */
  readonly startedUnder?: string;
}

/**
 * Log one event from an action, in a transaction of its own, stamped when it lands.
 *
 * @param ctx - The action's context.
 * @param event - The event: a type the contract lists, with that type's payload.
 * @param fence - The owner the action started under, when it read the employee as one.
 */
export async function logEvent(
  ctx: Pick<ActionCtx, 'runMutation'>,
  event: LoggedEvent,
  fence: LogFence = {},
): Promise<void> {
  await ctx.runMutation(internal.eventLog.log, {
    ...event,
    ...(fence.startedUnder === undefined ? {} : { startedUnder: fence.startedUnder }),
  });
}

/**
 * Append the event an action logs, stamped when it lands. Internal; reached
 * only through `logEvent`, which types the payload. The type is checked
 * against the contract's list of an employee's types here as well
 * (`AGENT_EVENT_TYPES`), so nothing that calls this mutation by name can write
 * an unlisted one, or an organisation connection's. With `startedUnder`, nothing is
 * appended once the employee is gone or another owner's ({@link LogFence});
 * the dropped event is logged for the operator.
 */
export const log = internalMutation({
  args: {
    agentId: v.id('agents'),
    type: v.union(...AGENT_EVENT_TYPES.map((type) => v.literal(type))),
    payload: v.any(),
    startedUnder: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { startedUnder, ...event }): Promise<null> => {
    if (startedUnder !== undefined) {
      const agent = await ctx.db.get(event.agentId);
      if (agent?.userId !== startedUnder) {
        logger.warn('event not logged: the employee changed owner during its action', {
          agentId: event.agentId,
          type: event.type,
        });
        return null;
      }
    }
    await ctx.db.insert('events', { ...event, createdAt: Date.now() });
    return null;
  },
});

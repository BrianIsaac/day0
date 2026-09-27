import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalMutation, type ActionCtx, type MutationCtx } from './_generated/server';
import { EVENT_TYPES, type LoggedEvent, type NewEvent } from '../src/events/contract';

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
 * Log one event from an action, in a transaction of its own, stamped when it lands.
 *
 * @param ctx - The action's context.
 * @param event - The event: a type the contract lists, with that type's payload.
 */
export async function logEvent(
  ctx: Pick<ActionCtx, 'runMutation'>,
  event: LoggedEvent,
): Promise<void> {
  await ctx.runMutation(internal.eventLog.log, event);
}

/**
 * Append the event an action logs, stamped when it lands. Internal; reached
 * only through `logEvent`, which types the payload. The type is checked
 * against the contract's list here as well, so nothing that calls this
 * mutation by name can write an unlisted one.
 */
export const log = internalMutation({
  args: {
    agentId: v.id('agents'),
    type: v.union(...EVENT_TYPES.map((type) => v.literal(type))),
    payload: v.any(),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.insert('events', { ...args, createdAt: Date.now() });
  },
});

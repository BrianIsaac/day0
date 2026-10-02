import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

/*
 * The organisation's connections as other modules read them (the access plan, section 4.1),
 * apart from `organisationConnections.ts`, which ends the cards on a revoked connection and so
 * depends on `surfaces.ts`: a module `surfaces.ts` depends on (the inbox in `work.ts`) reads a
 * connection here without an import cycle.
 */

/**
 * The system's active organisation connection, or null. A system has at most one active
 * connection (`landConnection` refuses a second).
 *
 * @param ctx - A query's or a mutation's context.
 * @param system - The system key (`organisationSystemOf`).
 */
export async function activeConnectionFor(
  ctx: Pick<QueryCtx, 'db'>,
  system: string,
): Promise<Doc<'organisationConnections'> | null> {
  return await ctx.db
    .query('organisationConnections')
    .withIndex('by_system_status', (index) => index.eq('system', system).eq('status', 'active'))
    .first();
}

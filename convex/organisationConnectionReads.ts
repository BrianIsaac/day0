import type { Doc, Id } from './_generated/dataModel';
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

/**
 * Whether the system's latest organisation connection was revoked: no active one, and IT revoked
 * the one it had (the pre-tag's second pass: the request then says IT revoked it, not that the
 * system is not connected yet).
 *
 * @param ctx - A query's or a mutation's context.
 * @param system - The system key (`organisationSystemOf`).
 */
export async function systemConnectionRevoked(
  ctx: Pick<QueryCtx, 'db'>,
  system: string,
): Promise<boolean> {
  if ((await activeConnectionFor(ctx, system)) !== null) return false;
  const [revoked, attention] = await Promise.all(
    (['revoked', 'needs-attention'] as const).map(
      async (status) =>
        await ctx.db
          .query('organisationConnections')
          .withIndex('by_system_status', (index) => index.eq('system', system).eq('status', status))
          .order('desc')
          .first(),
    ),
  );
  // The latest row decides: a newer connection waiting on IT is not one IT revoked.
  return (
    revoked !== null &&
    revoked !== undefined &&
    (attention === null ||
      attention === undefined ||
      attention._creationTime < revoked._creationTime)
  );
}

/**
 * The connections among those named that an administrator revoked, read one by one.
 *
 * @param ctx - A query's or a mutation's context.
 * @param ids - The connections a set of cards is linked to.
 */
export async function revokedConnectionsAmong(
  ctx: Pick<QueryCtx, 'db'>,
  ids: Iterable<Id<'organisationConnections'>>,
): Promise<ReadonlySet<Id<'organisationConnections'>>> {
  const rows = await Promise.all([...new Set(ids)].map(async (id) => await ctx.db.get(id)));
  return new Set(rows.flatMap((row) => (row?.status === 'revoked' ? [row._id] : [])));
}

/**
 * The systems among those named that have an active organisation connection, read one by one.
 *
 * @param ctx - A query's or a mutation's context.
 * @param systems - System keys (`organisationSystemOf`).
 */
export async function activeSystemsAmong(
  ctx: Pick<QueryCtx, 'db'>,
  systems: Iterable<string>,
): Promise<ReadonlySet<string>> {
  const named = [...new Set(systems)];
  const active = await Promise.all(
    named.map(async (system) =>
      (await activeConnectionFor(ctx, system)) === null ? [] : [system],
    ),
  );
  return new Set(active.flat());
}

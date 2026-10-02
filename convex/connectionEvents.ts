import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { query, type MutationCtx } from './_generated/server';
import { assertAdministrator } from './ownership';
import type {
  EventPayloads,
  ConnectionEventType,
  NewConnectionEvent,
} from '../src/events/contract';

/*
 * The ledger of the organisation's connections (AC11; the access plan, section 4.1): install,
 * rotation, scope change, revocation and every vendor call made with a connection's secret. It
 * is owner-less, so its rows are never an employee's events and no reset of an owner reaches
 * them; its types and payloads are the event contract's (`src/events/contract.ts`), so the
 * audit export says them in the same words as the record. No other code inserts into
 * `connectionEvents`; `tests/src/events/contract.test.ts` holds the tree to it.
 */

/**
 * Append one event of an organisation connection in the caller's transaction.
 *
 * @param ctx - The mutation's context.
 * @param event - The event: one of the contract's connection types with that type's payload, the
 *   connection, and the administrator's verified address when one made the change.
 * @returns The new ledger row's id.
 */
export async function appendConnectionEvent(
  ctx: Pick<MutationCtx, 'db'>,
  event: NewConnectionEvent,
): Promise<Id<'connectionEvents'>> {
  return await ctx.db.insert('connectionEvents', event);
}

/** The most ledger lines one read of the organisation page returns, newest first. */
export const LEDGER_READ_LIMIT = 200;

/** One line of the ledger as the organisation page reads it, typed by the contract. */
export type ConnectionLedgerLine = {
  [Type in ConnectionEventType]: {
    readonly _id: Id<'connectionEvents'>;
    readonly organisationConnectionId: Id<'organisationConnections'>;
    readonly type: Type;
    readonly payload: EventPayloads[Type];
    readonly actorAddress?: string;
    readonly createdAt: number;
  };
}[ConnectionEventType];

/**
 * The organisation's ledger for its administrators: one connection's lines, or every
 * connection's, newest first and bounded to {@link LEDGER_READ_LIMIT}. Public, guarded by
 * `assertAdministrator`; writes nothing. A ledger line names a connection and an administrator's
 * address, never an employee.
 */
export const forAdministrator = query({
  args: { organisationConnectionId: v.optional(v.id('organisationConnections')) },
  handler: async (ctx, args): Promise<ConnectionLedgerLine[]> => {
    await assertAdministrator(ctx);
    const connectionId = args.organisationConnectionId;
    const rows =
      connectionId === undefined
        ? await ctx.db
            .query('connectionEvents')
            .withIndex('by_created')
            .order('desc')
            .take(LEDGER_READ_LIMIT)
        : await ctx.db
            .query('connectionEvents')
            .withIndex('by_connection', (index) =>
              index.eq('organisationConnectionId', connectionId),
            )
            .order('desc')
            .take(LEDGER_READ_LIMIT);
    // Only `appendConnectionEvent` writes the table, typed by the contract, so a row's type and
    // payload are one of its connection types and that type's payload.
    return rows.map(
      (row): ConnectionLedgerLine =>
        ({
          _id: row._id,
          organisationConnectionId: row.organisationConnectionId,
          type: row.type,
          payload: row.payload,
          ...(row.actorAddress === undefined ? {} : { actorAddress: row.actorAddress }),
          createdAt: row.createdAt,
        }) as ConnectionLedgerLine,
    );
  },
});

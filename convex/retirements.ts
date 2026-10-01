import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

/*
 * The owner's retired employees, as the boundaries a colleague's work reads
 * them (decisions Q15 and N1). A single-employee retire deletes the
 * employee's rows, but a provider item it may already have written stays
 * held, and an item the manager rejected its plan for stays rejected; both
 * are kept on its `retirements` row, read here by the claim guard, the write
 * guard and the sibling hold (`convex/reset.ts` writes them). An employee
 * handed over to another manager leaves the same boundary for its old owner
 * on a row of `kind: 'transferred'` (decision D11, `convex/transferAcceptance.ts`
 * writes it), read here unchanged.
 */

/** One claim a retired employee still holds. */
export type RetiredClaim = Doc<'retirements'>['claims'][number];

/** One rejection a retired employee's work still carries. */
export type RetiredRejection = Doc<'retirements'>['rejections'][number];

/**
 * The most retirements one owner's boundaries read. Retiring is a person's
 * deliberate act, one employee at a time, so an owner never nears it; past
 * it the read refuses rather than letting a boundary go unread.
 */
export const RETIREMENT_READ_LIMIT = 1_000;

/**
 * Every retirement of one owner, newest first.
 *
 * @param ctx - Any context that reads.
 * @param userId - The owner.
 * @returns The owner's retirements.
 * @throws Error when the owner has more than `RETIREMENT_READ_LIMIT`, so no boundary is skipped.
 */
export async function ownerRetirements(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
): Promise<Doc<'retirements'>[]> {
  const rows = await ctx.db
    .query('retirements')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .order('desc')
    .take(RETIREMENT_READ_LIMIT + 1);
  if (rows.length > RETIREMENT_READ_LIMIT) {
    throw new Error(`the owner has more than ${RETIREMENT_READ_LIMIT} retired employees`);
  }
  return rows;
}

/** A retired employee's claim, with the retirement it was kept on. */
export interface RetiredHolding {
  readonly retirement: Doc<'retirements'>;
  readonly claim: RetiredClaim;
}

/**
 * The claim a retired employee of the owner still holds on a provider item,
 * by the item's key or one of its other names.
 *
 * @param ctx - Any context that reads.
 * @param userId - The owner.
 * @param key - The item's claim key.
 * @returns The holding, or undefined when no retired employee holds the item.
 */
export async function retiredClaimOn(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
  key: string,
): Promise<RetiredHolding | undefined> {
  for (const retirement of await ownerRetirements(ctx, userId)) {
    const claim = retirement.claims.find(
      (held) => held.key === key || (held.aliases ?? []).includes(key),
    );
    if (claim) return { retirement, claim };
  }
  return undefined;
}

/** A retired employee's rejection, with the retirement it was kept on. */
export interface RetiredRejectionOn {
  readonly retirement: Doc<'retirements'>;
  readonly rejection: RetiredRejection;
}

/**
 * The first rejection a retired employee of the owner's work carries on a
 * provider item, by any of the item's names.
 *
 * @param ctx - Any context that reads.
 * @param userId - The owner.
 * @param names - The item's claim key and alias.
 * @returns The earliest such rejection, or undefined.
 */
export async function firstRetiredRejection(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
  names: readonly string[],
): Promise<RetiredRejectionOn | undefined> {
  let first: RetiredRejectionOn | undefined;
  for (const retirement of await ownerRetirements(ctx, userId)) {
    for (const rejection of retirement.rejections) {
      if (!rejection.keys.some((key) => names.includes(key))) continue;
      if (first === undefined || rejection.rejectedAt < first.rejection.rejectedAt) {
        first = { retirement, rejection };
      }
    }
  }
  return first;
}

/**
 * How a holder kept on a retirement row is named to a colleague it refuses: as retired, or, on a
 * departure's row (`kind: 'transferred'`, decision D11), as handed over, since that employee
 * lives on under another manager.
 *
 * @param retirement - The holder's retirement or departure.
 * @returns Its name, marked by how it left the owner.
 */
export function retiredHolderName(
  retirement: Pick<Doc<'retirements'>, 'agentName' | 'kind'>,
): string {
  const name = retirement.agentName ?? 'an employee';
  return retirement.kind === 'transferred'
    ? `${name} (handed over to another manager)`
    : `${name} (retired)`;
}

/**
 * Close the departure boundaries an owner keeps for an employee handed back to them (the wave 9
 * review's U3-m6): on its return the employee's claims and rejections are the owner's own again,
 * moved with it, so a boundary kept from its departure would read its own work as held by an
 * employee handed to another manager. Each such row stays as the owner's record that the
 * employee left and when; its claims and rejections are emptied. A retirement is never touched.
 *
 * @param ctx - The move's mutation context.
 * @param ownerKey - The owner the employee returns to.
 * @param agentId - The returning employee.
 * @returns How many boundaries were closed.
 * @throws Error when the owner has more than `RETIREMENT_READ_LIMIT` rows, so none is skipped.
 */
export async function closeDeparturesOnReturn(
  ctx: Pick<MutationCtx, 'db'>,
  ownerKey: string,
  agentId: Id<'agents'>,
): Promise<number> {
  const departures = (await ownerRetirements(ctx, ownerKey)).filter(
    (row) =>
      row.kind === 'transferred' &&
      row.agentId === agentId &&
      (row.claims.length > 0 || row.rejections.length > 0),
  );
  for (const departure of departures) {
    await ctx.db.patch(departure._id, { claims: [], rejections: [] });
  }
  return departures.length;
}

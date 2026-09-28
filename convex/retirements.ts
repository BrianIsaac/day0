import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

/*
 * The owner's retired employees, as the boundaries a colleague's work reads
 * them (decisions Q15 and N1). A single-employee retire deletes the
 * employee's rows, but a provider item it may already have written stays
 * held, and an item the manager rejected its plan for stays rejected; both
 * are kept on its `retirements` row, read here by the claim guard, the write
 * guard and the sibling hold (`convex/reset.ts` writes them).
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
 * How a retired holder is named to a colleague it refuses.
 *
 * @param retirement - The holder's retirement.
 * @returns Its name, marked retired.
 */
export function retiredHolderName(retirement: Pick<Doc<'retirements'>, 'agentName'>): string {
  return `${retirement.agentName ?? 'an employee'} (retired)`;
}

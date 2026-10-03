import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery } from './_generated/server';
import { ticketSnapshotValidator } from './schema';
import { LISTING_AFTER_HANDOVER, seedItemInTransaction, workItemSeedFields } from './work';

/*
 * Intake's seed of a listed item, fenced by the owner its poll read the employee under (the wave
 * 9 review's U3-m2). A poll reads the queue with the employee's connection as it stood when the
 * sweep began; a handover that moved the employee meanwhile cut that connection, and what the
 * poll listed was read with the old owner's token. Seeding it would make the new owner's work out
 * of the old owner's read, so the seed lands only while the employee is still the owner's the
 * sweep read it under. The seed itself is `seedItemInTransaction`, the one every seed shares.
 *
 * The owner the fence compares is read with the surfaces, in one transaction (the wave 10
 * review's FR-m4): the sweep polls with the surface rows it read first, so an owner read later,
 * at the employee's turn, may already be the new manager's while the rows still carry the old
 * connection.
 */

/** One employee's owner key as the sweep's surface read saw it; null for an employee with none. */
export interface SweepOwner {
  readonly agentId: Id<'agents'>;
  readonly owner: string | null;
}

/** The sweep's one read: every declared surface, and its employee's owner at the same moment. */
export interface SweepRead {
  readonly surfaces: Doc<'surfaces'>[];
  /** One entry per employee that still exists; an employee gone at the read is absent. */
  readonly owners: SweepOwner[];
}

/**
 * Read every declared surface and, in the same transaction, the owner of each surface's employee:
 * the owner the sweep polls the employee under and fences its seeds by.
 *
 * Internal, for `intakeActions`' sweep. Writes nothing. Reads one employee row per employee that
 * has a surface, as the surface read itself reads every row.
 */
export const surfacesForSweep = internalQuery({
  args: {},
  handler: async (ctx): Promise<SweepRead> => {
    const surfaces = await ctx.db.query('surfaces').collect();
    const agentIds = [...new Set(surfaces.map((surface) => surface.agentId))];
    const agents = await Promise.all(agentIds.map(async (agentId) => await ctx.db.get(agentId)));
    const owners = agents.flatMap((agent): SweepOwner[] =>
      agent === null ? [] : [{ agentId: agent._id, owner: agent.userId ?? null }],
    );
    return { surfaces, owners };
  },
});

/** Why a listed item is not seeded: the employee is gone or changed owner during its poll. */
export const SEED_AFTER_HANDOVER = LISTING_AFTER_HANDOVER;

/**
 * Seed one listed item or bring its row up to the listing, while the employee is still the owner
 * the poll read it under.
 *
 * Internal, for `intakeActions`' sweep. Writes what `seedItemInTransaction` writes. A refused
 * seed throws rather than answering quietly: the sweep counts a thrown seed as unseeded, so its
 * checkpoint does not move past an item nobody seeded, and the new owner's first poll reads it.
 *
 * @returns The item's id.
 * @throws Error with {@link SEED_AFTER_HANDOVER} for an employee that is gone or another owner's.
 */
export const seedListedItem = internalMutation({
  args: {
    agentId: v.id('agents'),
    ...workItemSeedFields,
    tracker: v.optional(ticketSnapshotValidator),
    /** The employee's owner key when the sweep read it; null for an employee with none. */
    startedUnder: v.union(v.string(), v.null()),
  },
  returns: v.id('workItems'),
  handler: async (ctx, { startedUnder, ...seed }): Promise<Id<'workItems'>> => {
    const agent = await ctx.db.get(seed.agentId);
    if (agent === null || (agent.userId ?? null) !== startedUnder) {
      throw new Error(SEED_AFTER_HANDOVER);
    }
    return await seedItemInTransaction(ctx, seed);
  },
});

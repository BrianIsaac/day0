import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalMutation } from './_generated/server';
import { ticketSnapshotValidator } from './schema';
import { seedItemInTransaction, workItemSeedFields } from './work';

/*
 * Intake's seed of a listed item, fenced by the owner its poll read the employee under (the wave
 * 9 review's U3-m2). A poll reads the queue with the employee's connection as it stood when the
 * sweep began; a handover that moved the employee meanwhile cut that connection, and what the
 * poll listed was read with the old owner's token. Seeding it would make the new owner's work out
 * of the old owner's read, so the seed lands only while the employee is still the owner's the
 * sweep read it under. The seed itself is `seedItemInTransaction`, the one every seed shares.
 */

/** Why a listed item is not seeded: the employee is gone or changed owner during its poll. */
export const SEED_AFTER_HANDOVER =
  'the employee was handed over to a new manager, or retired, while this poll read its queue';

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

import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalMutation } from './_generated/server';
import { ticketSnapshotValidator } from './schema';
import { seedItemInTransaction, workItemSeedFields } from './work';
import { log } from '../src/lib/logger';

/*
 * Intake's seed of a listed item, fenced by the owner its poll read the employee under (the wave
 * 9 review's U3-m2). A poll reads the queue with the employee's connection as it stood when the
 * sweep began; a handover that moved the employee meanwhile cut that connection, and what the
 * poll listed was read with the old owner's token. Seeding it would make the new owner's work out
 * of the old owner's read, so the seed lands only while the employee is still the owner's the
 * sweep read it under. The seed itself is `seedItemInTransaction`, the one every seed shares.
 */

/**
 * Seed one listed item or bring its row up to the listing, while the employee is still the owner
 * the poll read it under.
 *
 * Internal, for `intakeActions`' sweep. Writes what `seedItemInTransaction` writes, or nothing
 * for an employee that is gone or now another owner's (logged for the operator).
 *
 * @returns The item's id, or null when nothing was seeded.
 */
export const seedListedItem = internalMutation({
  args: {
    agentId: v.id('agents'),
    ...workItemSeedFields,
    tracker: v.optional(ticketSnapshotValidator),
    /** The employee's owner key when the sweep read it; null for an employee with none. */
    startedUnder: v.union(v.string(), v.null()),
  },
  returns: v.union(v.id('workItems'), v.null()),
  handler: async (ctx, { startedUnder, ...seed }): Promise<Id<'workItems'> | null> => {
    const agent = await ctx.db.get(seed.agentId);
    if (agent === null || (agent.userId ?? null) !== startedUnder) {
      log.warn('listed item not seeded: the employee changed owner during its poll', {
        agentId: seed.agentId,
        sourceSystem: seed.sourceSystem,
      });
      return null;
    }
    return await seedItemInTransaction(ctx, seed);
  },
});

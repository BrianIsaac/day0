import { ConvexError, v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { mutation, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsPerson } from './ownership';
import {
  NO_PROPOSED_CHANGE,
  OWNER_IS_THE_MANAGER,
  PROPOSED_ADDRESS_HELD,
} from '../src/people/words';

/*
 * A source's proposed change to a person the manager confirmed (W13-R3; 14-I's
 * `people.proposedChange`, written by `peopleProposals.mergeProposal`), taken or dismissed on the
 * person's card. A module of its own: `convex/people.ts` is past the standard's soft size (9.2).
 */

/** The person's proposed change, refused when there is none or the row is the owner's own. */
function proposedChangeOf(person: Doc<'people'>): NonNullable<Doc<'people'>['proposedChange']> {
  if (person.isOwner === true) throw new ConvexError(OWNER_IS_THE_MANAGER);
  if (person.proposedChange === undefined || person.status === 'dismissed') {
    throw new ConvexError(NO_PROPOSED_CHANGE);
  }
  return person.proposedChange;
}

/** Whether another of the owner's people, not dismissed, holds the address. */
async function addressHeldByAnother(
  ctx: MutationCtx,
  person: Doc<'people'>,
  address: string,
): Promise<boolean> {
  const holders = await ctx.db
    .query('people')
    .withIndex('by_user_email', (q) => q.eq('userId', person.userId).eq('primaryEmail', address))
    .take(2);
  return holders.some((holder) => holder._id !== person._id && holder.status !== 'dismissed');
}

/**
 * Public, owner-level (`assertOwnsPerson` first, then `assertOwnsAgent`): **Take** on a confirmed
 * person's proposed change. Its title, team and address replace the confirmed ones and the change
 * is cleared; a new address is looked up on the owner's cards, as at Confirm. Refused when nothing
 * is proposed, and for an address another of the owner's people holds (the manager merges them
 * first).
 */
export const take = mutation({
  args: { personId: v.id('people'), agentId: v.id('agents') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const person = await assertOwnsPerson(ctx, args.personId);
    await assertOwnsAgent(ctx, args.agentId);
    const change = proposedChangeOf(person);
    const address = change.primaryEmail;
    if (address !== undefined && (await addressHeldByAnother(ctx, person, address))) {
      throw new ConvexError(PROPOSED_ADDRESS_HELD);
    }
    await ctx.db.patch(person._id, {
      ...(change.title === undefined ? {} : { title: change.title }),
      ...(change.team === undefined ? {} : { team: change.team }),
      ...(address === undefined ? {} : { primaryEmail: address }),
      proposedChange: undefined,
      updatedAt: Date.now(),
    });
    if (address !== undefined && person.status === 'active') {
      await ctx.scheduler.runAfter(0, internal.peopleLookupActions.lookUpAddresses, {
        personIds: [person._id],
      });
    }
    return null;
  },
});

/**
 * Public, owner-level (`assertOwnsPerson` first, then `assertOwnsAgent`): **Dismiss** on a
 * confirmed person's proposed change: the change is cleared and the confirmed values stay. The
 * source's words stay in the person's evidence, as they did before the change was kept.
 */
export const dismiss = mutation({
  args: { personId: v.id('people'), agentId: v.id('agents') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const person = await assertOwnsPerson(ctx, args.personId);
    await assertOwnsAgent(ctx, args.agentId);
    proposedChangeOf(person);
    await ctx.db.patch(person._id, { proposedChange: undefined, updatedAt: Date.now() });
    return null;
  },
});

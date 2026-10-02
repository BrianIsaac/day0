import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalQuery } from './_generated/server';
import type { ActingCard } from '../src/work/ticket-ownership';

/*
 * The rows behind Linear's app actor (wave 11, 11-AL; the access plan, section 4.10): the
 * organisation's shared app-actor token, an employee's own app and the tokens its installation
 * lands, and whom a card acts as. The actions that talk to Linear are `linearIdentityActions.ts`,
 * since Convex keeps a Node module's actions apart from queries and mutations.
 */

/**
 * Whom an employee's card acts as, by the employee and the card's slug, for the re-read before a
 * run's first write on a ticket (D6): the identity the landing recorded and the one the card's last
 * probe read. Internal; writes nothing.
 *
 * @returns The card's identity, or null when the employee has no card of that slug.
 */
export const actingCard = internalQuery({
  args: { agentId: v.id('agents'), slug: v.string() },
  handler: async (ctx, args): Promise<ActingCard | null> => {
    const card: Doc<'surfaces'> | null = await ctx.db
      .query('surfaces')
      .withIndex('by_agent_slug', (index) =>
        index.eq('agentId', args.agentId).eq('slug', args.slug),
      )
      .first();
    if (card === null) return null;
    return {
      ...(card.actsAs === undefined ? {} : { actsAs: card.actsAs }),
      ...(card.providerIdentityId === undefined
        ? {}
        : { providerIdentityId: card.providerIdentityId }),
    };
  },
});

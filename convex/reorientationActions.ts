'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { log } from '../src/lib/logger';
import { proposeOnCard } from '../src/agent/reorientation-judgement';

/*
 * The reorientation card's judgement (wave 16, 16-O; decision O-2): a trigger's writer is a
 * mutation and cannot call the model, so a card opens with its proposal pending and this action,
 * scheduled in the same transaction, asks the model what the employee proposes and writes the
 * answer back through `convex/reorientation.ts`. Never applied: only Approve changes anything.
 */

/**
 * Ask what one card proposes and write it onto the card; a failed judgement, a reply that names
 * what the card does not hold, or a read or write that throws (W16-R23) leaves the card open with
 * nothing proposed and says why. Internal; scheduled where a card opens or is asked again.
 */
export const propose = internalAction({
  args: { reorientationId: v.id('reorientations') },
  handler: async (ctx, args): Promise<void> => {
    const { reorientationId } = args;
    await proposeOnCard({
      read: async () => await ctx.runQuery(internal.reorientation.proposalInput, args),
      write: async (proposed, basis) => {
        await ctx.runMutation(internal.reorientation.writeProposal, {
          reorientationId,
          proposed,
          basis,
        });
      },
      fail: async (failure, basis) => {
        log.warn('reorientation: the proposal judgement failed', {
          reorientationId,
          reason: failure,
        });
        await ctx.runMutation(internal.reorientation.recordProposalFailure, {
          reorientationId,
          failure,
          ...(basis !== undefined ? { basis } : {}),
        });
      },
    });
  },
});

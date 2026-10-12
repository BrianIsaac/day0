'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { log } from '../src/lib/logger';
import { judgeProposal } from '../src/agent/reorientation-judgement';

/*
 * The reorientation card's judgement (wave 16, 16-O; decision O-2): a trigger's writer is a
 * mutation and cannot call the model, so a card opens with its proposal pending and this action,
 * scheduled in the same transaction, asks the model what the employee proposes and writes the
 * answer back through `convex/reorientation.ts`. Never applied: only Approve changes anything.
 */

/**
 * Ask what one card proposes and write it onto the card; a failed judgement, or a reply that
 * names what the card does not hold, leaves the card open with nothing proposed and says why.
 * Internal; scheduled by `openCard`.
 */
export const propose = internalAction({
  args: { reorientationId: v.id('reorientations') },
  handler: async (ctx, args): Promise<void> => {
    const read = await ctx.runQuery(internal.reorientation.proposalInput, args);
    if (read === null) return;
    const judged = await judgeProposal(read.input);
    if (judged.outcome === 'unavailable') {
      log.warn('reorientation: the proposal judgement failed', {
        reorientationId: args.reorientationId,
        reason: judged.reason,
      });
      await ctx.runMutation(internal.reorientation.recordProposalFailure, {
        reorientationId: args.reorientationId,
        failure: judged.reason,
        basis: read.basis,
      });
      return;
    }
    await ctx.runMutation(internal.reorientation.writeProposal, {
      reorientationId: args.reorientationId,
      proposed: judged.proposed,
      basis: read.basis,
    });
  },
});

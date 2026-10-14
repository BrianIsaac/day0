import { describe, expect, it } from 'vitest';
import { thickHandlers, thickHandlersIn } from '../fixtures/thin-handlers';

/**
 * The standard's 9.3: a registered Convex function is thin, a validator, a guard and one call of
 * the helper that holds its logic. Wave 18's 18-s moved the manager channel's and the lists'
 * handler bodies out of `convex/work.ts` and the judgement's out of `convex/reorientation.ts`,
 * each registered name staying where it is (S-1). Each list below is what is still thicker than
 * that in its module: a move that thins a handler takes its name out, and a new thick handler is
 * red here until it is thinned or named.
 */

describe('the handlers a module registers', (): void => {
  it('read as thin when guards come before one call of a helper', (): void => {
    expect(
      thickHandlersIn(
        [
          "import { assertOwnsWorkItem, getCallerOrThrow } from './ownership';",
          'export const guarded = mutation({',
          '  args: { workItemId: v.id("workItems") },',
          '  handler: async (ctx, args) => {',
          '    const row = await assertOwnsWorkItem(ctx, args.workItemId);',
          '    return await guardedInTransaction(ctx, row, args);',
          '  },',
          '});',
          'export const bare = internalMutation({',
          '  args: {},',
          '  handler: async (ctx) => await bareInTransaction(ctx, Date.now()),',
          '});',
          'export const guardOnly = query({',
          '  args: { workItemId: v.id("workItems") },',
          '  handler: async (ctx, args) => await assertOwnsWorkItem(ctx, args.workItemId),',
          '});',
          'export const callerFirst = mutation({',
          '  args: {},',
          '  handler: async (ctx, args) => {',
          '    await getCallerOrThrow(ctx);',
          '    await callerFirstInTransaction(ctx, args);',
          '  },',
          '});',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('read as thick with no validator, a second call, a read of their own or a nested call', (): void => {
    expect(
      thickHandlersIn(
        [
          "import { assertOwnsWorkItem } from './ownership';",
          'export const noValidator = query({ handler: async (ctx) => await readIt(ctx) });',
          'export const twoCalls = mutation({',
          '  args: {},',
          '  handler: async (ctx, args) => {',
          '    await first(ctx);',
          '    return await second(ctx, args);',
          '  },',
          '});',
          'export const ownRead = query({',
          '  args: { id: v.id("workItems") },',
          '  handler: async (ctx, args) => {',
          '    const row = await ctx.db.get(args.id);',
          '    return await helper(ctx, row);',
          '  },',
          '});',
          'export const nested = query({',
          '  args: {},',
          '  handler: async (ctx) => await helper(ctx, await other(ctx)),',
          '});',
          'export const afterTheCall = mutation({',
          '  args: { workItemId: v.id("workItems") },',
          '  handler: async (ctx, args) => {',
          '    const row = await assertOwnsWorkItem(ctx, args.workItemId);',
          '    await helper(ctx, row);',
          '    return { ok: true };',
          '  },',
          '});',
          'export const notRegistered = 3;',
        ].join('\n'),
      ),
    ).toEqual(['afterTheCall', 'nested', 'noValidator', 'ownRead', 'twoCalls']);
  });
});

describe('the registered functions of convex/work.ts, convex/reorientation.ts and convex/metrics.ts', (): void => {
  it('are each a validator, a guard and one call, in work.ts but for the handlers named here', (): void => {
    expect(thickHandlers('convex/work.ts')).toEqual([
      'approveActionsBatch',
      'beginPlanGroundingRead',
      'cancelPlan',
      'claimDependentAuthoring',
      'claimForBaseline',
      'claimLandedTicketWrites',
      'claimLoopStep',
      'closeDecisionThread',
      'decidePlan',
      'digestCandidates',
      'earlierPlan',
      'executionRunIds',
      'finishPlanGroundingRead',
      'getInternal',
      'itemsHeldElsewhere',
      'latestListing',
      'listedSnapshot',
      'listForAgent',
      'needsYou',
      'needsYouForAgent',
      'noticeUnreadableReply',
      'openDecisions',
      'planGroundingReads',
      'prepareDecisionBatch',
      'prepareDecisionNotice',
      'prepareDecisionRequest',
      'prepareDependentPhase',
      'prepareManagerDigest',
      'prepareManagerNote',
      'prepareManagerReplyNotice',
      'prepareReplacedEdit',
      'prepareRequestClose',
      'readmitSatisfiedDeferrals',
      'recordDecisionNotice',
      'recordDecisionPoll',
      'recordDecisionRequest',
      'recordManagerDigest',
      'recordManagerNote',
      'recordManagerReplyNotice',
      'recordReplacedEdit',
      'recordRequestClose',
      'recordScopeAdmission',
      'recordScopeJudgementUnavailable',
      'recoverDependentAuthoring',
      'recoverInterruptedApply',
      'recoverUndeliveredDecisionRequest',
      'recoverUnproposedSkill',
      'recoverUnsentManagerNote',
      'resendDecisionRequest',
      'resumeExecution',
      'seedCharterDerived',
      'setAwaitingApproval',
      'setProposedSkill',
      'stopUnproposedSkill',
      'takeWriteTargetClaims',
      'transportAuthority',
      'withdrawListedItem',
      'writeClaimHolder',
    ]);
  });

  it('are each a validator, a guard and one call, in reorientation.ts but for the handlers named here', (): void => {
    expect(thickHandlers('convex/reorientation.ts')).toEqual([
      'holdingCard',
      'proposalInput',
      'recordProposalFailure',
      'reopenDeferred',
      'writeProposal',
    ]);
  });

  it('are each a validator, a guard and one call, in metrics.ts but for the handlers named here', (): void => {
    expect(thickHandlers('convex/metrics.ts')).toEqual([
      'forAgent',
      'forOwner',
      'forOwnerByPages',
      'ownerFiguresPage',
    ]);
  });
});

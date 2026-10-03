import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, internalQuery } from './_generated/server';
import schema from './schema';
import { isEmptyScope, keepsPageScan } from '../src/surfaces/intake-scope';

/*
 * The reads and the write of the `surfaces-intake-scope` pass (the round after wave 11, R-S; the
 * wave 11 review's m5). The pass itself runs in the Node runtime
 * (`intakeScopeBackfillActions.backfillPage`), since it derives each scope with orientation's own
 * reading of the pages.
 */

/** Cards one page of the pass reads. */
const INTAKE_SCOPE_PAGE = 25;

/** One page of cards, with the ones that keep the page scan picked out. */
export interface PageScanCards {
  readonly cards: Doc<'surfaces'>[];
  readonly read: number;
  readonly cursor: string;
  readonly isDone: boolean;
}

/**
 * One page of cards, keeping those intake reads by the page scan (`keepsPageScan`). Internal, for
 * the pass's page; writes nothing.
 */
export const pageScanCards = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<PageScanCards> => {
    const page = await ctx.db
      .query('surfaces')
      .paginate({ cursor: args.cursor, numItems: INTAKE_SCOPE_PAGE });
    return {
      cards: page.page.filter(keepsPageScan),
      read: page.page.length,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Write the scope the pass derived onto a card that still keeps the page scan, and nothing onto
 * one that gained a scope meanwhile (a proposal or an approval wrote its own) or a scope that
 * reads nothing, which would stop intake rather than bound it. Internal, for the pass's page.
 *
 * @returns Whether the scope was written.
 */
export const recordDerivedScope = internalMutation({
  args: {
    surfaceId: v.id('surfaces'),
    intakeScope: schema.tables.surfaces.validator.fields.intakeScope,
  },
  handler: async (ctx, args): Promise<boolean> => {
    const card = await ctx.db.get(args.surfaceId);
    if (card === null || !keepsPageScan(card) || args.intakeScope === undefined) return false;
    if (isEmptyScope(args.intakeScope, card.class)) return false;
    await ctx.db.patch(card._id, { intakeScope: args.intakeScope });
    return true;
  },
});

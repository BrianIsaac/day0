import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { eventsOfType } from './eventLog';
import {
  endKeptIdentity,
  HANDOVER_CUT_REPROPOSE_REASON,
  HANDOVER_REAPPROVE_REASON,
} from './surfaces';
import { isEventOf } from '../src/events/contract';
import { KEPT_IDENTITY_WAIT_MS } from '../src/agent/manager-transfer';

/*
 * The identities a handover kept for the new manager's re-approval (A25). A kept identity is
 * renewed by its issuer's scheduled refresh while its card waits at `proposed`, so the new
 * manager's approval is one click; nothing ended one the new manager never decided (the wave 11
 * review's m8). The hourly sweep ends each that has waited longer than `KEPT_IDENTITY_WAIT_MS`.
 */

/** How many `proposed` cards one page of the sweep reads. */
const KEPT_SWEEP_PAGE = 100;

/** The most `surface.proposed` lines of one employee read to find a card's latest. */
const PROPOSED_EVENTS_READ = 100;

/**
 * The reasons a handover's re-approval left on a card that kept the employee's own identity, read
 * only for a card kept before the move marked it (`keptIdentitySince`, v0.16.0): a later release's
 * backfill marks those, and this fallback goes then (12-S3's handover).
 */
const HANDOVER_REAPPROVAL_REASONS: ReadonlySet<string> = new Set([
  HANDOVER_REAPPROVE_REASON,
  HANDOVER_CUT_REPROPOSE_REASON,
]);

/** Whether a handover kept the card's identity: its mark, or on an unmarked card the move's words. */
function keptByHandover(surface: Doc<'surfaces'>): boolean {
  if (surface.keptIdentitySince !== undefined) return true;
  return surface.reason !== undefined && HANDOVER_REAPPROVAL_REASONS.has(surface.reason);
}

/**
 * Whether a `proposed` card holds an identity a handover kept for re-approval (A25): the move's
 * mark on it (the round review's m16), no approval since, and a live credential Day0 obtained. A
 * card a changed intake queue sent back to `proposed` keeps its identity unmarked and under
 * another reason, and is never ended here (the code pass's B1).
 */
async function holdsKeptIdentity(ctx: MutationCtx, surface: Doc<'surfaces'>): Promise<boolean> {
  if (
    surface.credentialId === undefined ||
    surface.managerApprovedAt !== undefined ||
    !keptByHandover(surface)
  ) {
    return false;
  }
  const credential = await ctx.db.get(surface.credentialId);
  return (
    credential !== null && credential.revokedAt === undefined && credential.issuedBy !== undefined
  );
}

/**
 * Since when the card has waited: the move's mark, or on a card kept before the mark the latest
 * `surface.proposed` line its own record holds; undefined when neither says.
 */
async function waitingSince(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
): Promise<number | undefined> {
  if (surface.keptIdentitySince !== undefined) return surface.keptIdentitySince;
  const proposed = await eventsOfType(ctx, surface.agentId, 'surface.proposed')
    .order('desc')
    .take(PROPOSED_EVENTS_READ);
  const latest = proposed.find(
    (event) => isEventOf(event, 'surface.proposed') && event.payload.surfaceId === surface._id,
  );
  return latest?.createdAt;
}

/** How many `proposed` cards one page of the mark's backfill reads; each may read its record. */
const MARK_BACKFILL_PAGE = 25;

/** One page of a pass over the deployment's `proposed` cards. */
export interface ProposedCardsPage {
  readonly read: number;
  readonly changed: number;
  readonly cursor: string;
  readonly isDone: boolean;
}

/**
 * Mark each card a handover kept before the mark existed (the `surfaces-kept-identity-since`
 * pass, 13-K; the round review's m16): every `proposed` card the sweep now holds a kept identity
 * by its reason's words alone ({@link holdsKeptIdentity} with no mark), dated as the sweep dates
 * it ({@link waitingSince}: its newest `surface.proposed` line), or by the upgrade when its record
 * holds none, so no card's wait ends sooner than it would have. A marked card and every other card
 * are left, so a second run changes nothing. Once every deployment has run it, the sweep's
 * reason-word fallback has nothing left to read and goes in the release after.
 *
 * @param ctx - The migration page's mutation context.
 * @param cursor - Where the previous page stopped, or null for the first.
 * @param now - The upgrade's time, for a card whose record names no proposal.
 */
export async function markKeptBeforeTheMarkPage(
  ctx: MutationCtx,
  cursor: string | null,
  now: number,
): Promise<ProposedCardsPage> {
  const page = await ctx.db
    .query('surfaces')
    .withIndex('by_verdict', (index) => index.eq('verdict', 'proposed'))
    .paginate({ numItems: MARK_BACKFILL_PAGE, cursor });
  let changed = 0;
  for (const surface of page.page) {
    if (surface.keptIdentitySince !== undefined || !(await holdsKeptIdentity(ctx, surface))) {
      continue;
    }
    await ctx.db.patch(surface._id, {
      keptIdentitySince: (await waitingSince(ctx, surface)) ?? now,
    });
    changed += 1;
  }
  return {
    read: page.page.length,
    changed,
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/** One page of {@link endUnapproved}: how many it ended, and where the next page starts. */
export interface KeptSweepPage {
  readonly ended: number;
  readonly continueCursor: string;
  readonly isDone: boolean;
}

/**
 * End every identity a handover kept on a card that has waited at `proposed` longer than
 * {@link KEPT_IDENTITY_WAIT_MS} (`endKeptIdentity`), one page of the deployment's `proposed` cards
 * at a time: revoked at the vendor, the card left to be approved and connected afresh. Internal;
 * the hourly re-probe sweep's (`surfaceActions.reprobeAll`), which pages through every card. Writes
 * the cards, the credentials' revocation and their systems' ledger lines.
 *
 * @param cursor - Where the previous page stopped, or null for the first.
 * @returns How many identities the page ended, and the next page's cursor.
 */
export const endUnapproved = internalMutation({
  args: { now: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<KeptSweepPage> => {
    const page = await ctx.db
      .query('surfaces')
      .withIndex('by_verdict', (index) => index.eq('verdict', 'proposed'))
      .paginate({ numItems: KEPT_SWEEP_PAGE, cursor: args.cursor });
    let ended = 0;
    for (const surface of page.page) {
      if (!(await holdsKeptIdentity(ctx, surface))) continue;
      const since = await waitingSince(ctx, surface);
      if (since === undefined || args.now - since < KEPT_IDENTITY_WAIT_MS) continue;
      await endKeptIdentity(ctx, surface, args.now);
      ended += 1;
    }
    return { ended, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

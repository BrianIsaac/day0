import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { eventsOfType } from './eventLog';
import { endKeptIdentity } from './surfaces';
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
 * Whether a `proposed` card holds an identity Day0 obtained: a handover's re-approval keeps one
 * (A25), and nothing else leaves a credential with an issuer on a card waiting for approval.
 */
async function holdsKeptIdentity(ctx: MutationCtx, surface: Doc<'surfaces'>): Promise<boolean> {
  if (surface.credentialId === undefined) return false;
  const credential = await ctx.db.get(surface.credentialId);
  return (
    credential !== null && credential.revokedAt === undefined && credential.issuedBy !== undefined
  );
}

/** When the card was last sent back to `proposed`, by its own record; undefined when none says. */
async function waitingSince(
  ctx: MutationCtx,
  surface: Doc<'surfaces'>,
): Promise<number | undefined> {
  const proposed = await eventsOfType(ctx, surface.agentId, 'surface.proposed')
    .order('desc')
    .take(PROPOSED_EVENTS_READ);
  const latest = proposed.find(
    (event) => (event.payload as { readonly surfaceId?: unknown }).surfaceId === surface._id,
  );
  return latest?.createdAt;
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

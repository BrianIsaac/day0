import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation } from './_generated/server';
import { leaseDecision } from '../src/surfaces/refresh-lease';

/*
 * The refresh lease's two writes (the round after wave 11, R-S; `src/surfaces/refresh-lease.ts`):
 * the claim, which reads the generation and takes the lease in one transaction, and the holder's
 * release. The rotations that end a lease by moving the pair on clear it in their own write
 * (`mcpOauth.rotateTokens`, `linearIdentity.rotateEmployeeTokens`, `slackProvision.recordRotation`).
 */

/** What a claim answers: the lease with the refresh token's row of the same snapshot, or why not. */
export type RefreshClaim =
  | {
      readonly kind: 'claimed';
      readonly leaseUntil: number;
      /** The paired refresh token's row, live, as the claiming transaction read it. */
      readonly refresh: Doc<'credentials'>;
    }
  | { readonly kind: 'moved' }
  | { readonly kind: 'leased'; readonly until: number }
  | { readonly kind: 'gone' }
  | { readonly kind: 'no-refresh-token' };

/** Whether a row still holds a value nothing has revoked or set aside. */
function holdsLiveValue(row: Doc<'credentials'> | null): row is Doc<'credentials'> {
  return (
    row !== null &&
    row.revokedAt === undefined &&
    row.status === undefined &&
    row.ciphertext !== undefined &&
    row.iv !== undefined
  );
}

/**
 * Take the refresh lease on an access token's row while it is still at the generation the refresh
 * read and no other refresh holds it, and hand back the paired refresh token's row from the same
 * snapshot, so the token presented is the one of that generation and no other refresh presents
 * it. Internal, for the token store's native keeper and the Slack configuration pair's rotation.
 *
 * @returns `claimed` with the lease's end and the refresh row; `moved` when a rotation moved the
 *   pair on; `leased` with the end of another refresh's lease; `gone` when the access token is
 *   revoked, emptied or missing; `no-refresh-token` when no live refresh token is paired with it.
 *   Nothing is written unless the lease is claimed.
 */
export const claim = internalMutation({
  args: {
    credentialId: v.id('credentials'),
    expectedGeneration: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args): Promise<RefreshClaim> => {
    const access = await ctx.db.get(args.credentialId);
    if (!holdsLiveValue(access)) return { kind: 'gone' };
    const decision = leaseDecision(access, args.expectedGeneration, args.now);
    if (decision.kind !== 'claim') return decision;
    const refresh = access.refreshCredentialId
      ? await ctx.db.get(access.refreshCredentialId)
      : null;
    if (!holdsLiveValue(refresh)) return { kind: 'no-refresh-token' };
    await ctx.db.patch(access._id, { refreshingUntil: decision.leaseUntil });
    return { kind: 'claimed', leaseUntil: decision.leaseUntil, refresh };
  },
});

/**
 * End the holder's own lease: cleared only while the row still carries the lease this holder
 * took, so a holder whose lease lapsed never clears the next holder's. A rotation has already
 * cleared it on the way to success, which makes this a no-op then. Internal, for the holders.
 */
export const release = internalMutation({
  args: { credentialId: v.id('credentials'), leaseUntil: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const access = await ctx.db.get(args.credentialId);
    if (access?.refreshingUntil !== args.leaseUntil) return;
    await ctx.db.patch(access._id, { refreshingUntil: undefined });
  },
});

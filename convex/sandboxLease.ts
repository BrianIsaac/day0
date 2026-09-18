import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import type { Id } from './_generated/dataModel';

/**
 * The lease on the verification sandbox: which authoring run may call it now.
 *
 * The sandbox serves one request at a time behind a backlog of eight
 * (`sandbox/skill_sandbox.py`) and the client gives up at 75 s
 * (`src/lib/local-sandbox.ts`). Measured on 18 September 2026: nine
 * concurrent verifications of three employees' real skills all pass in about
 * a second, but one smoke test at the 60 s wall-clock cap makes every queued
 * one wait 60 s, two push them past the client's wait, and past nine
 * concurrent the socket refuses the connect. An authoring run that loses that
 * race loses its model call and parks its skill unverified, for something
 * another employee did.
 *
 * So the queue lives here rather than on the socket: one row, taken before a
 * verification and released after it, and a run that finds it held waits and
 * asks again. A wait is then a visible row and an event, and each request
 * reaches the sandbox alone, inside the client's own wait.
 *
 * This is not a security boundary - a caller that ignored the lease would
 * still reach the socket. It is what keeps three employees from spending each
 * other's authoring runs.
 */

/** The single lease, by name, so the table holds one row rather than a queue. */
export const SANDBOX_LEASE_NAME = 'local-sandbox';

/**
 * How long a holder keeps the lease before another run may take it over.
 *
 * Longer than the client's 75 s wait, so the lease never expires under a
 * request that is still outstanding; short enough that a run which died
 * holding it costs one abandoned request rather than the queue.
 */
export const SANDBOX_LEASE_MS = 90_000;

/** How long a waiting run leaves between attempts. */
export const SANDBOX_LEASE_RETRY_MS = 5_000;

export interface SandboxLeaseAttempt {
  taken: boolean;
  /** The skill whose run holds it, when this attempt was refused. */
  heldBy?: Id<'skills'>;
  /** How long that holder has held it, when this attempt was refused. */
  heldForMs?: number;
}

/**
 * Take the lease for one verification, or report who holds it.
 *
 * A mutation is a transaction, so the read of the current holder and the
 * write of the new one cannot be split by a second caller, which is the whole
 * of the exclusion this provides.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   args: The skill being verified and its authoring run.
 *
 * Returns:
 *   Whether this run now holds the lease, and who holds it if not.
 */
export const take = internalMutation({
  args: { skillId: v.id('skills'), runId: v.id('events') },
  handler: async (ctx, args): Promise<SandboxLeaseAttempt> => {
    const now = Date.now();
    const held = await ctx.db
      .query('sandboxLeases')
      .withIndex('by_name', (q) => q.eq('name', SANDBOX_LEASE_NAME))
      .unique();
    if (held && held.skillId === args.skillId && held.runId === args.runId) {
      return { taken: true };
    }
    if (held) {
      const heldForMs = now - held.takenAt;
      if (heldForMs < SANDBOX_LEASE_MS) {
        return { taken: false, heldBy: held.skillId, heldForMs };
      }
      // The holder is past its lease: it died mid-request, or its request was
      // abandoned by the client long ago. Either way nothing is waiting on it.
      await ctx.db.delete(held._id);
    }
    await ctx.db.insert('sandboxLeases', {
      name: SANDBOX_LEASE_NAME,
      skillId: args.skillId,
      runId: args.runId,
      takenAt: now,
    });
    return { taken: true };
  },
});

/**
 * Release the lease, if this run still holds it.
 *
 * Only the holder releases: a run whose lease was taken over must not free
 * the lease the run after it is holding.
 *
 * Args:
 *   ctx: Convex mutation context.
 *   args: The skill and the authoring run that took the lease.
 *
 * Returns:
 *   Whether this call released it.
 */
export const release = internalMutation({
  args: { skillId: v.id('skills'), runId: v.id('events') },
  handler: async (ctx, args): Promise<{ released: boolean }> => {
    const held = await ctx.db
      .query('sandboxLeases')
      .withIndex('by_name', (q) => q.eq('name', SANDBOX_LEASE_NAME))
      .unique();
    if (!held || held.skillId !== args.skillId || held.runId !== args.runId) {
      return { released: false };
    }
    await ctx.db.delete(held._id);
    return { released: true };
  },
});

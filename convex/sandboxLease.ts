import { v } from 'convex/values';
import { internalMutation } from './_generated/server';

/**
 * The lease on the verification sandbox. Stub, so the failing-first tests
 * compile; the implementation and its table land in the commit that follows.
 */

/** How long a holder may keep the lease before another run may take it over. */
export const SANDBOX_LEASE_MS = 90_000;

export const take = internalMutation({
  args: { skillId: v.id('skills'), runId: v.id('events') },
  handler: async (): Promise<{ taken: boolean; heldBy?: string; heldForMs?: number }> => ({
    taken: false,
  }),
});

export const release = internalMutation({
  args: { skillId: v.id('skills'), runId: v.id('events') },
  handler: async (): Promise<{ released: boolean }> => ({ released: false }),
});

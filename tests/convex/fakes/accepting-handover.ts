import type { TestConvex } from 'convex-test';
import type { Id } from '../../../convex/_generated/dataModel';
import type schema from '../../../convex/schema';
import { MANAGER_ADDRESS } from './manager-identity';

/** The address the accepting handover names. */
export const ACCEPTING_TO_ADDRESS = 'colleague@day0.local';

/**
 * Stage a handover of the employee that the named manager has accepted and that waits for its
 * runs (`accepting`), the state in which the old manager may grant no new authority (U3-m3).
 *
 * @param harness - The test's backend.
 * @param agentId - The employee handed over.
 * @param agentName - The employee's name, as the request carries it.
 * @returns The request.
 */
export async function seedAcceptingHandover(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
  agentName: string,
): Promise<Id<'managerTransfers'>> {
  return await harness.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert('managerTransfers', {
      agentId,
      agentName,
      fromOwnerKey: 'owner',
      fromAddress: MANAGER_ADDRESS,
      toAddress: ACCEPTING_TO_ADDRESS,
      toOwnerKey: 'colleague',
      state: 'accepting',
      requestedAt: now,
      expiresAt: now + 86_400_000,
      decidedAt: now,
      settleBy: now + 900_000,
    });
  });
}

/**
 * The refusal an accepted handover meets a grant with, in its own words.
 *
 * @param agentName - The employee's name.
 */
export function acceptedHandoverWords(agentName: string): string {
  return `${agentName}'s handover to ${ACCEPTING_TO_ADDRESS} was already accepted: ${agentName} becomes theirs when its runs end.`;
}

/**
 * The authoring lease, shared by the mutation that honours it and the panel
 * that describes it.
 *
 * A run that dies mid-flight never releases its claim, so the claim on the row
 * outlives the run holding it. `convex/skills.ts` already knows that - it takes
 * such a skill over once the lease has passed - but the dashboard read the
 * claim alone and went on reporting a run that had been gone for hours. One
 * constant, so the two cannot disagree about when a claim stops meaning
 * anything.
 *
 * Deliberately free of both Convex and React imports: it is read from a client
 * component and from a Convex mutation.
 */

/**
 * How long a claim is honoured before another authoring run may take the skill
 * over. Long enough that a live run holding a model call and a sandbox is never
 * taken over while it is still working.
 */
export const AUTHORING_LEASE_MS = 10 * 60 * 1000;

/**
 * Whether a skill is held by an authoring run that could still come back.
 *
 * Args:
 *   claim: The run id and claim time carried by the skill row.
 *   now: The instant to judge the claim against.
 *
 * Returns:
 *   True while the claim is a live run's, false for a claim whose run is gone
 *   and for a skill no run holds.
 */
export function holdsLiveAuthoringClaim(
  claim: { authoringRunId?: string; authoringClaimedAt?: number },
  now: number,
): boolean {
  if (!claim.authoringRunId) return false;
  return now - (claim.authoringClaimedAt ?? 0) < AUTHORING_LEASE_MS;
}

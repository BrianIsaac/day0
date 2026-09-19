/**
 * What may stand behind a read an approved plan declares, beside the reads
 * phase one landed. The closing gate (`validatePlanStepOutcomes`) owes each
 * declared read a landed read of its surface; on 19 September it looked in
 * phase one's ledger alone, and refused LOG-1 three times for a Linear read
 * the product had made itself before the plan was drafted.
 */

import { parseSurfaceAction } from '../surfaces/policy';
import { readsTheItem, type GroundingRead } from './evidence-claims';

/**
 * The surfaces the item's plan-grounding reads landed on.
 *
 * A grounding read is the product's own read of the work item, made under
 * standing authority before the plan was drafted. It counts by the rule the
 * evidence check holds it to: it landed, it was not held, and one of its
 * arguments is this item's id, whole, so a read of another ticket is never
 * this item's read.
 *
 * Args:
 *   externalId: The work item's id on its source surface.
 *   reads: The item's grounding reads as their events stored them.
 *
 * Returns:
 *   Lower-cased surface slugs.
 */
export function groundingReadSurfaces(externalId: string | undefined, reads: readonly GroundingRead[] = []): Set<string> {
  const surfaces = new Set<string>();
  if (!externalId) return surfaces;
  for (const { action, applied } of reads) {
    if (applied?.ok !== true || applied.held || applied.awaitingApproval) continue;
    if (!readsTheItem(action, externalId)) continue;
    const parsed = parseSurfaceAction(action);
    if (parsed.ok) surfaces.add(parsed.action.surface.toLowerCase());
  }
  return surfaces;
}

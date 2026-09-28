import type { Doc, Id } from '../../convex/_generated/dataModel';
import { holdsLiveAuthoringClaim } from '../lib/skill-authoring';
import {
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
} from './reconciliation';

/**
 * What waits on the manager, row by row: the one set of rules the landing
 * page's roster counts by and the needs-you inbox lists by.
 */

/** How the reason on a row the manager's own rejection failed begins. */
export const MANAGER_REJECTION_PREFIX = 'rejected by the manager';

/** The open states that wait on the manager: a plan to approve, a held action set. */
export const NEEDS_MANAGER_STATES: ReadonlySet<string> = new Set([
  'plan-pending',
  'actions-pending',
]);

/**
 * The skill states in which the next move on a skill is the manager's: a
 * proposal to approve, and an authoring run to start or start again, which
 * only the dashboard does. `registered` is absent: a row still parked behind
 * a registered skill is released by no manager action.
 */
export const SKILL_WAITS_ON_MANAGER_STATES: ReadonlySet<string> = new Set([
  'proposed',
  'approved',
  'authoring',
  'verified',
  'failed',
]);

/**
 * Whether the next move on a skill is the manager's: its state waits on a
 * manager's click and no authoring run holds it.
 *
 * @param skill - The skill a parked row waits on.
 * @param now - The instant an authoring claim is judged against.
 */
export function skillWaitsOnManager(skill: Doc<'skills'>, now: number): boolean {
  return SKILL_WAITS_ON_MANAGER_STATES.has(skill.state) && !holdsLiveAuthoringClaim(skill, now);
}

/**
 * Whether only the manager can release a parked row.
 *
 * A deferral waits on a connection or a read grant, both the manager's to
 * give. A row waiting on a skill is the manager's while the skill waits on a
 * manager's click and no authoring run holds it; before a proposal exists,
 * while a run is in flight, or once the skill is registered, it is not. A
 * row queued at the cap is released by a slot freeing, and the rows holding
 * the slots that wait on the manager are already counted.
 *
 * @param row - The parked row.
 * @param skills - The skills the parked rows wait on, by id.
 * @param now - The instant an authoring claim is judged against.
 * @returns True when the row counts under needs-you.
 */
export function parkedRowNeedsManager(
  row: Doc<'workItems'>,
  skills: ReadonlyMap<Id<'skills'>, Doc<'skills'> | null>,
  now: number,
): boolean {
  if (row.state === 'deferred') return true;
  if (row.state !== 'needs-skill' || !row.proposedSkillId) return false;
  const skill = skills.get(row.proposedSkillId);
  return skill ? skillWaitsOnManager(skill, now) : false;
}

/**
 * Whether a failed row's card still offers the manager a move.
 *
 * The card offers Retry on every failed row, and where a write may have
 * landed it asks for the provider reconciliation first, which is also the
 * manager's. The one row with neither is an interrupted apply whose ledger
 * names nothing to verify: the confirmation and Retry are both disabled and
 * `work.reconcileFailed` refuses, so nothing the manager does moves it. A
 * recorded reconciliation needs no reading: it is only ever recorded against
 * a ledger that names entries.
 *
 * @param row - The failed row.
 * @returns True when Retry is open, or the reconciliation that opens it is.
 */
export function stoppedRowOffersMove(row: Doc<'workItems'>): boolean {
  if (!retryRequiresProviderReconciliation(row.output, row.skipReason)) return true;
  return providerReconciliationEntries(row.output).length > 0;
}

/**
 * Whether a stopped row waits on the manager.
 *
 * A run that stopped or failed leaves the next move to the manager: answer
 * what it asked, direct it, or send it again. A row the manager's own
 * rejection failed waits on nobody: Retry is there, but the last decision
 * was theirs.
 *
 * @param row - A failed row whose card offers a move.
 * @returns True when the row counts under needs-you.
 */
export function stoppedRowNeedsManager(row: Doc<'workItems'>): boolean {
  return row.skipReason?.startsWith(MANAGER_REJECTION_PREFIX) !== true;
}

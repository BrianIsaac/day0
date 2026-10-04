import type { Doc, Id } from '../../convex/_generated/dataModel';
import { holdsLiveAuthoringClaim } from '../lib/skill-authoring';
import { MAX_AUTHORING_ATTEMPTS } from './skill-library';
import {
  providerReconciliationEntries,
  reconciliationAnswered,
  retryRequiresProviderReconciliation,
} from './reconciliation';

/**
 * What waits on the manager, row by row: the one set of rules the landing
 * page's roster counts by and the needs-you inbox lists by.
 */

/** How the reason on a row the manager's own rejection failed begins. */
export const MANAGER_REJECTION_PREFIX = 'rejected by the manager';

/**
 * Whether the employee's Day-1 one-to-one is the manager's to hold: deployed and not yet begun.
 * Nothing it does starts before it (the wave 5 review's D4 (b)).
 *
 * @param agent - The employee.
 */
export function oneToOneWaitsOnManager(agent: Pick<Doc<'agents'>, 'state'>): boolean {
  return agent.state === 'deployed';
}

/**
 * The states a row waits in, for the manager or for what only they can give: a plan, a held set,
 * a deferral, a skill, a stopped or failed run. Every transition into one stamps `waitingSince`
 * (wave 12, 12-W; H D11, D12), which the inbox dates the wait by.
 */
export const WAITING_STATES: ReadonlySet<string> = new Set([
  'plan-pending',
  'actions-pending',
  'deferred',
  'needs-skill',
  'failed',
]);

/**
 * The stamp a transition into a state writes: `waitingSince` when the state waits, nothing else.
 *
 * @param state - The state the row enters.
 * @param now - The transition's time.
 */
export function waitingStamp(state: string, now: number): { waitingSince?: number } {
  return WAITING_STATES.has(state) ? { waitingSince: now } : {};
}

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
 * Whether a failed skill has spent its authoring attempts ("Attempt 3 of 3"): Retry is withdrawn
 * and the manager's move is Give up. It still waits on the manager, as every failed skill does.
 *
 * @param skill - The skill's state and the attempts its authoring claims counted.
 */
export function attemptsSpent(skill: Pick<Doc<'skills'>, 'state' | 'authoringAttempts'>): boolean {
  return skill.state === 'failed' && (skill.authoringAttempts ?? 0) >= MAX_AUTHORING_ATTEMPTS;
}

/**
 * Whether the next move on a skill is the manager's: its state waits on a
 * manager's click and no authoring run holds it. A failed skill waits on the
 * manager whatever its attempts: Retry until the third, Give up after it.
 * A skill taken out of use (`retired`, `superseded`) or ended (`rejected`)
 * waits on nobody.
 *
 * @param skill - The skill a parked row waits on.
 * @param now - The instant an authoring claim is judged against.
 */
export function skillWaitsOnManager(skill: Doc<'skills'>, now: number): boolean {
  return SKILL_WAITS_ON_MANAGER_STATES.has(skill.state) && !holdsLiveAuthoringClaim(skill, now);
}

/**
 * How many of an employee's skills wait on the manager, the Skills tab's badge (the wave 10
 * review, C-m1): proposals (an offered adoption among them), failed drafts and adoptions (Retry,
 * or Give up at the third attempt), and parked or stalled rows no run holds; each row once,
 * whichever of the tab's lists carry it.
 *
 * @param rows - The rows of the tab's lists, a row listed twice counted once.
 * @param now - The instant an authoring claim is judged against.
 */
export function skillsWaitingOnManager(rows: readonly Doc<'skills'>[], now: number): number {
  const counted = new Set<Id<'skills'>>();
  for (const row of rows) {
    if (skillWaitsOnManager(row, now)) counted.add(row._id);
  }
  return counted.size;
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

/** What a failed row's card leads with: Retry, the reconciliation that opens it, or Close without retry. */
export type FailedRowMove = 'retry' | 'reconcile' | 'close-without-retry';

/**
 * The move a failed row's card offers the manager (E-8): every failed row has one.
 *
 * Where a write may have landed, the reconciliation comes first and opens Retry. A row whose
 * ledger names nothing to reconcile is retried as it is, except an interrupted apply that could
 * not say what it sent: Retry and the reconciliation both refuse it, so its move is Close without
 * retry (`workRuns.closeWithoutRetry`), which records the manager's decision as a dismissal does.
 *
 * @param row - The failed row.
 */
export function failedRowMove(
  row: Pick<Doc<'workItems'>, 'output' | 'skipReason' | 'providerReconciliation'>,
): FailedRowMove {
  if (providerReconciliationEntries(row.output).length > 0) {
    return reconciliationAnswered(row.providerReconciliation) ? 'retry' : 'reconcile';
  }
  return retryRequiresProviderReconciliation(row.output, row.skipReason)
    ? 'close-without-retry'
    : 'retry';
}

/**
 * Whether a stopped row waits on the manager.
 *
 * A run that stopped or failed leaves the next move to the manager: answer
 * what it asked, direct it, or send it again. A row the manager's own
 * rejection failed waits on nobody: Retry is there, but the last decision
 * was theirs. Nor does a row the manager dismissed (N7): its Retry is still
 * on its card.
 *
 * @param row - A failed row whose card offers a move.
 * @returns True when the row counts under needs-you.
 */
export function stoppedRowNeedsManager(row: Doc<'workItems'>): boolean {
  return (
    row.dismissedAt === undefined && row.skipReason?.startsWith(MANAGER_REJECTION_PREFIX) !== true
  );
}

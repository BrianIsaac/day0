/**
 * The action posture ladder: how much of a run applies without a human step.
 *
 * Two dials decide it. The agent's posture is set by the manager (or moves
 * itself once, from cold start to supervised, when the first work item
 * completes). A skill's trust is earned: its first `SKILL_SUPERVISED_RUNS`
 * runs hold every row for the manager, and once that many runs have been
 * approved without a single row rejected the skill graduates. A rejection
 * starts the count again. Everything here is pure so the hold transaction,
 * the dashboard and the tests agree on the same numbers.
 */

export const AGENT_POSTURES = ['cold-start', 'supervised', 'trusted'] as const;

export type AgentPosture = (typeof AGENT_POSTURES)[number];

/** Every agent starts here; nothing applies without the manager's click. */
export const DEFAULT_POSTURE: AgentPosture = 'cold-start';

/** How many approved runs, with no row rejected, a skill needs before it is trusted. */
export const SKILL_SUPERVISED_RUNS = 2;

/**
 * Whether a value names a posture.
 *
 * Args:
 *   value: Untrusted input.
 *
 * Returns:
 *   True for one of the three postures.
 */
export function isAgentPosture(value: unknown): value is AgentPosture {
  return typeof value === 'string' && (AGENT_POSTURES as readonly string[]).includes(value);
}

/**
 * The posture an agent row carries, with the deploy default for rows without one.
 *
 * Args:
 *   agent: The agent's persisted posture, if any.
 *
 * Returns:
 *   The effective posture.
 */
export function agentPosture(agent: { posture?: string | undefined }): AgentPosture {
  return isAgentPosture(agent.posture) ? agent.posture : DEFAULT_POSTURE;
}

export interface SkillTrust {
  /** Whether the skill is past its supervised window. */
  trusted: boolean;
  /** Approved runs counted so far, capped at the window for display. */
  completed: number;
  /** The window size. */
  window: number;
  /** `supervised · 1 of 2 approved runs` or `trusted`, for the skill card. */
  label: string;
}

/**
 * Where a skill stands in its supervised window.
 *
 * Args:
 *   skill: The skill's persisted counter, if any.
 *
 * Returns:
 *   Trust state and the card label.
 */
export function skillTrust(skill: { supervisedRunsCompleted?: number | undefined }): SkillTrust {
  const raw = skill.supervisedRunsCompleted ?? 0;
  const completed = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const trusted = completed >= SKILL_SUPERVISED_RUNS;
  return {
    trusted,
    completed: Math.min(completed, SKILL_SUPERVISED_RUNS),
    window: SKILL_SUPERVISED_RUNS,
    label: trusted
      ? 'trusted'
      : `supervised · ${completed} of ${SKILL_SUPERVISED_RUNS} approved runs`,
  };
}

/**
 * Whether every non-refused row of a run is held for the manager.
 *
 * Args:
 *   posture: The agent's posture.
 *   skill: The skill that produced the run, or undefined when none is recorded.
 *
 * Returns:
 *   True in cold start, and in supervised posture while the skill is supervised.
 */
export function holdsEveryRow(
  posture: AgentPosture,
  skill: { supervisedRunsCompleted?: number | undefined } | undefined,
): boolean {
  if (posture === 'cold-start') return true;
  if (posture === 'trusted') return false;
  return !skillTrust(skill ?? {}).trusted;
}

/** One manager decision on a held run, in the order it was made. */
export type SupervisedDecision =
  | { kind: 'approved'; rejectedAny: boolean }
  | { kind: 'rejected' };

/**
 * Replay the supervised-run rule over a skill's decisions.
 *
 * An approval with no held row rejected counts one; an approval that left a
 * held row out, and a rejection of the run, start the count again.
 *
 * Args:
 *   decisions: The decisions in chronological order.
 *
 * Returns:
 *   The counter after the last decision.
 */
export function replaySupervisedRuns(decisions: readonly SupervisedDecision[]): number {
  let completed = 0;
  for (const decision of decisions) {
    if (decision.kind === 'approved' && !decision.rejectedAny) completed += 1;
    else completed = 0;
  }
  return completed;
}

/**
 * The counter after one more decision.
 *
 * Args:
 *   completed: The persisted counter, if any.
 *   decision: The decision just made.
 *
 * Returns:
 *   The next counter value.
 */
export function nextSupervisedRuns(
  completed: number | undefined,
  decision: SupervisedDecision,
): number {
  if (decision.kind === 'approved' && !decision.rejectedAny) return (completed ?? 0) + 1;
  return 0;
}

/** The subset of an event row the replay reads. */
export interface GateEventLike {
  type: string;
  payload: unknown;
  createdAt: number;
}

function numberList(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'number')
    ? (value as number[])
    : undefined;
}

/**
 * Read a skill's supervised-run decisions out of its work items' gate events.
 *
 * Events written since the ladder carry `rejectedIndexes` on the approval.
 * Older approvals carry `heldIndexes` (every index not applied), and the hold
 * event that preceded them carries the indexes the gate itself refused, so
 * the rows the manager left out are the difference between the two.
 *
 * Args:
 *   events: Gate events for the skill's work items, in any order.
 *
 * Returns:
 *   The decisions in chronological order.
 */
export function decisionsFromEvents(events: readonly GateEventLike[]): SupervisedDecision[] {
  const ordered = [...events].sort((a, b) => a.createdAt - b.createdAt);
  const gateHeld = new Map<string, Set<number>>();
  const decisions: SupervisedDecision[] = [];
  for (const event of ordered) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const key = `${String(payload.workItemId)}:${String(payload.runId)}`;
    if (event.type === 'work.actions-pending') {
      const refused = numberList(payload.refusedIndexes) ?? numberList(payload.heldIndexes) ?? [];
      gateHeld.set(key, new Set(refused));
    } else if (event.type === 'work.actions-approved') {
      const explicit = numberList(payload.rejectedIndexes);
      if (explicit) {
        decisions.push({ kind: 'approved', rejectedAny: explicit.length > 0 });
        continue;
      }
      const refused = gateHeld.get(key) ?? new Set<number>();
      const leftOut = (numberList(payload.heldIndexes) ?? []).filter((index) => !refused.has(index));
      decisions.push({ kind: 'approved', rejectedAny: leftOut.length > 0 });
    } else if (event.type === 'work.actions-rejected') {
      decisions.push({ kind: 'rejected' });
    }
  }
  return decisions;
}

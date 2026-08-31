/**
 * The autonomous-actions toggle: whether an agent may act on connected
 * systems without asking.
 *
 * One boolean on the agent row decides it. Off (the default, and what an
 * absent field reads as) is the supervised state: reads and the manager DM
 * apply on their own, and every other write waits for the manager's
 * approval of the literal payload. On, every row the gate does not refuse
 * applies in the auto phase, and the toggle itself is the manager's standing
 * authority for writes on connected surfaces within their probed allowlist.
 * It is only about actions: skill approval and surface approval are the same
 * either way. Everything here is pure so the hold transaction, the apply
 * backstop, the dashboard and the tests read the same value.
 */

/** The reason recorded on `agent.autonomy-changed` when the manager flips the switch. */
export const AUTONOMY_CHANGE_REASON = 'set by the manager';

/** The header's name for each state. */
export const SUPERVISED_LABEL = 'Supervised';
export const AUTONOMOUS_LABEL = 'Autonomous';

/**
 * What the manager is told before turning autonomous actions on, in the
 * operator's sense: the agent acts without asking, within what has already
 * been approved, and the switch is for after its behaviour has been watched.
 */
export const AUTONOMY_WARNING =
  'The agent will act on connected systems without asking - post, comment, change status - within the connections and skills you have approved. Turn this on only after its behaviour has been what you want. Skills and connections still need your approval either way.';

/** Why a held row is waiting, shown on the pending-actions card while the toggle is off. */
export const HELD_WHILE_SUPERVISED_NOTE = 'held for your approval - autonomous actions are off';

/** The same card once the toggle is on: the run was held before the switch and still needs the click. */
export const HELD_BEFORE_AUTONOMY_NOTE =
  'held for your approval - this run was held before autonomous actions were turned on';

/**
 * Whether an agent row has autonomous actions on.
 *
 * Args:
 *   agent: The agent's persisted toggle, if any.
 *
 * Returns:
 *   True only when the field is exactly `true`; absent is off.
 */
export function autonomousActionsOn(agent: { autonomousActions?: boolean | undefined }): boolean {
  return agent.autonomousActions === true;
}

/**
 * The header's word for the toggle's state.
 *
 * Args:
 *   on: Whether autonomous actions are on.
 *
 * Returns:
 *   `Autonomous` or `Supervised`.
 */
export function autonomyLabel(on: boolean): string {
  return on ? AUTONOMOUS_LABEL : SUPERVISED_LABEL;
}

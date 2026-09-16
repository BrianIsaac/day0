import { isSurfaceTool, parseSurfaceAction, statusChangeTarget } from '../surfaces/policy';
import { liveManagerFeedback, type ManagerFeedback } from './manager-feedback';
import { planObligations, transitionWithheld } from './obligations';
import type { ExecutionPlan, MockAction, PlanStepOutcome } from './types';

/**
 * A retry note that directs the ticket state change in so many words.
 *
 * A plan that leaves the state change to the manager holds it for a click
 * whatever the switch says. The manager's Retry note is the same word given
 * earlier: "Yes, move REVOPS-5 to Done, I accept check 2 unconfirmed." is
 * the approval the hold waits for, and asking for it again on the card is a
 * second click for one decision. The note counts when three things agree:
 * the run carries a live retry note (not a rejection reason), the closing
 * phase recorded the transition step as satisfied on the manager's feedback
 * (the way a note settles any plan step, checked by the gate against the
 * feedback the run carries), and the note itself names the state every
 * status change in the set moves to, in a sentence that does not negate or
 * defer it. A note that says anything else leaves the hold in place.
 */

/** Words that turn a sentence naming the state into a refusal or a deferral of it. */
const NEGATED = /\b(?:not|no|never|don't|dont|do not|hold|wait|yet|later|unless|until|instead)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the note names the state in a sentence that neither negates nor
 * defers it.
 *
 * Args:
 *   note: The manager's retry note.
 *   state: The state a status change sets, as its arguments carry it.
 *
 * Returns:
 *   True when some sentence of the note names the state and carries no negation or deferral.
 */
export function noteDirectsState(note: string, state: string): boolean {
  const wanted = state.trim();
  if (wanted === '') return false;
  const named = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(wanted)}(?:$|[^A-Za-z0-9])`, 'i');
  return note
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((sentence) => named.test(sentence) && !NEGATED.test(sentence));
}

export interface TransitionDirectionArgs {
  plan: Pick<ExecutionPlan, 'steps' | 'obligations'>;
  /** The closing phase's plan-step outcomes, as the model recorded them. */
  planStepOutcomes: readonly PlanStepOutcome[] | undefined;
  feedback: ManagerFeedback | undefined;
  actions: readonly MockAction[];
}

/**
 * Whether the manager's retry note lifts the hold on a state change the plan
 * left to them.
 *
 * Args:
 *   args: The plan, the closing outcomes, the item's feedback and the set under review.
 *
 * Returns:
 *   True when the plan holds the transition for the manager, the run carries
 *   a live retry note, the transition step rests on that note, and the note
 *   names the state every status change in the set moves to.
 */
export function transitionDirectedByNote(args: TransitionDirectionArgs): boolean {
  if (!transitionWithheld(args.plan)) return false;
  if (args.feedback?.kind !== 'retry-note') return false;
  const note = liveManagerFeedback(args.feedback);
  if (!note) return false;
  const step = planObligations(args.plan)?.transitionStep;
  if (step === undefined || step === null) return false;
  const outcome = args.planStepOutcomes?.find((row) => row.step === step);
  if (!outcome || outcome.status !== 'satisfied' || outcome.basis !== 'manager-feedback') return false;
  const targets = args.actions.flatMap((action): string[] => {
    if (!isSurfaceTool(action.tool)) return [];
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) return [];
    const target = statusChangeTarget(parsed.action);
    return target === undefined ? [] : [target];
  });
  return targets.length > 0 && targets.every((target) => noteDirectsState(note, target));
}

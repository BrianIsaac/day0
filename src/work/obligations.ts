/**
 * What an approved plan obliges the run to do, read from the plan's declared
 * fields (`ExecutionPlan.obligations`) and never from its prose. The gates,
 * the closing-phase switch and the resume selector all read these helpers,
 * so they cannot disagree; a plan with no declared obligations owes nothing
 * here, and each caller skips what it cannot see.
 */

import type { ExecutionPlan, PlanObligations, PlanTransition } from './types';

/** A surface the run can act on, by slug, with the name the card shows. */
export interface ObligationSurface {
  slug: string;
  displayName: string;
}

/** A read one plan step declares of one connected surface. */
export interface DeclaredRead {
  /** The step number, from 1. */
  step: number;
  surface: ObligationSurface;
}

/**
 * The transitions under which the closing set must carry the ticket state
 * change or account for its absence: an unconditional close, one the
 * evidence settles, and one the manager decides, which the gate then holds.
 */
const PROMISED_TRANSITIONS: ReadonlySet<PlanTransition> = new Set([
  'promised',
  'conditional-on-evidence',
  'conditional-on-manager',
]);
/** The transitions under which the state change is the manager's decision, whatever the switch says. */
const WITHHELD_TRANSITIONS: ReadonlySet<PlanTransition> = new Set(['withheld', 'conditional-on-manager']);

/**
 * The declared obligations of a plan, when they line up with its steps.
 *
 * Obligations persisted against a plan whose steps were since amended, or
 * from a row that carries a shape this code does not know, are unusable and
 * read as absent rather than as an obligation on the wrong step.
 *
 * Args:
 *   plan: The approved plan.
 *
 * Returns:
 *   The obligations, or undefined when the plan declares none it can use.
 */
export function planObligations(plan: Pick<ExecutionPlan, 'steps' | 'obligations'>): PlanObligations | undefined {
  const declared = plan.obligations;
  if (!declared || !Array.isArray(declared.steps)) return undefined;
  if (declared.steps.length !== plan.steps.length) return undefined;
  return declared;
}

/**
 * Every read the plan declares of a surface in the given list, in step
 * order. A declared read of a surface not in the list, an absent or an
 * ungranted surface among them, is no obligation and is left out.
 *
 * Args:
 *   plan: The approved plan.
 *   surfaces: The surfaces a read may be owed of.
 *
 * Returns:
 *   One entry per step and surface.
 */
export function declaredReads(
  plan: Pick<ExecutionPlan, 'steps' | 'obligations'>,
  surfaces: readonly ObligationSurface[],
): DeclaredRead[] {
  const declared = planObligations(plan);
  if (!declared) return [];
  const bySlug = new Map(surfaces.map((surface) => [surface.slug.toLowerCase(), surface]));
  const reads: DeclaredRead[] = [];
  declared.steps.forEach((row, index): void => {
    const seen = new Set<string>();
    for (const slug of row.reads ?? []) {
      const surface = bySlug.get(slug.toLowerCase());
      if (!surface || seen.has(surface.slug)) continue;
      seen.add(surface.slug);
      reads.push({ step: index + 1, surface });
    }
  });
  return reads;
}

/**
 * The one-based steps that read: a step of kind `read`, or one that reads
 * a surface on the way to something else (the tile sequence that ends in a
 * snapshot). These are the prerequisites a closing phase reasons from.
 *
 * Args:
 *   plan: The approved plan.
 *
 * Returns:
 *   Sorted step numbers; empty when the plan declares no obligations.
 */
export function readingSteps(plan: Pick<ExecutionPlan, 'steps' | 'obligations'>): number[] {
  const declared = planObligations(plan);
  if (!declared) return [];
  return declared.steps.flatMap((row, index) =>
    row.kind === 'read' || (row.reads ?? []).length > 0 ? [index + 1] : [],
  );
}

/**
 * Whether the plan gives the run a closing phase: some step reads, so the
 * comment, the reply and the state change are authored from results that
 * do not exist when phase one is written.
 */
export function planReadsBeforeClosing(plan: Pick<ExecutionPlan, 'steps' | 'obligations'>): boolean {
  return readingSteps(plan).length > 0;
}

/**
 * Whether a real-mode run gets its closing phase from the plan: the plan
 * declares a read, or its obligations were asked for and not settled. The
 * judgement failing open with nothing from the planner, or a declared set
 * that no longer lines up with the steps, is read as reading, so a comment,
 * a reply or a state change is still authored from the ledger and audited
 * rather than prewritten in phase one; the gates that would owe a read or a
 * transition still owe nothing they cannot see. A plan that was never
 * judged (mock mode, a row from before the field existed) is left to the
 * executor's own flag, and mock mode never consults this.
 */
export function closingPhaseOwed(plan: Pick<ExecutionPlan, 'steps' | 'obligations' | 'obligationsFailedOpen'>): boolean {
  if (planReadsBeforeClosing(plan)) return true;
  if (plan.obligationsFailedOpen !== undefined) return true;
  return plan.obligations !== undefined && planObligations(plan) === undefined;
}

/** The plan's declared word on the ticket state, or undefined when it declares nothing. */
export function planTransition(plan: Pick<ExecutionPlan, 'steps' | 'obligations'>): PlanTransition | undefined {
  return planObligations(plan)?.transition;
}

/**
 * Whether the plan commits the run to the ticket's state transition:
 * unconditionally, under a condition the evidence settles, or on the
 * manager's decision. A closing set that leaves the state alone must then
 * account for it with a blocked step; a manager-conditioned change is
 * emitted and held (see `transitionWithheld`), never left out.
 */
export function transitionPromised(plan: Pick<ExecutionPlan, 'steps' | 'obligations'>): boolean {
  const transition = planTransition(plan);
  return transition !== undefined && PROMISED_TRANSITIONS.has(transition);
}

/**
 * Whether the plan makes the state change the manager's decision: it
 * withholds the transition in its own words, or conditions it on the
 * manager's approval. The exact-action gate holds such a change for the
 * manager whatever the autonomy switch says. When the planner and the
 * judgement disagreed, either reading that leaves the change to the manager
 * holds it: a click the manager did not need costs a click, a Done that
 * landed on its own when the manager meant to hold it cannot be taken back.
 */
export function transitionWithheld(plan: Pick<ExecutionPlan, 'steps' | 'obligations'>): boolean {
  const declared = planObligations(plan);
  if (!declared) return false;
  return (
    WITHHELD_TRANSITIONS.has(declared.transition) ||
    (declared.plannerTransition !== undefined && WITHHELD_TRANSITIONS.has(declared.plannerTransition))
  );
}

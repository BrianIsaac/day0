/**
 * What an approved plan obliges the run to do, read from the plan's declared
 * fields (`ExecutionPlan.obligations`) and never from its prose. The gates,
 * the closing-phase switch and the resume selector all read these helpers,
 * so they cannot disagree; a plan with no declared obligations owes nothing
 * here, and each caller skips what it cannot see.
 */

import { actionIntent, isManagerDm, isStatusChange, parseSurfaceAction, type ParsedSurfaceAction } from '../surfaces/policy';
import type { SurfaceRecord } from '../surfaces/types';
import type { ExecutionPlan, MockAction, PlanObligations, PlanTransition } from './types';

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

type ObligedPlan = Pick<ExecutionPlan, 'steps' | 'obligations'>;

/** Whether either reading of the plan conditions the ticket state on the manager. */
function conditionedOnManager(declared: PlanObligations): boolean {
  return declared.transition === 'conditional-on-manager' || declared.plannerTransition === 'conditional-on-manager';
}

/**
 * The one-based steps the plan leaves to the manager: under a transition
 * conditioned on the manager, in either reading, every `conditional-write`
 * step and the step that carries the state change. A plan whose transition
 * is promised, settled by evidence, withheld or unsaid conditions nothing on
 * the manager here, whatever its steps condition on: an evidence condition is
 * the closing phase's to settle, not a question's.
 *
 * Args:
 *   plan: The approved plan.
 *
 * Returns:
 *   Sorted step numbers; empty when the plan leaves no write to the manager.
 */
export function managerConditionalSteps(plan: ObligedPlan): number[] {
  const declared = planObligations(plan);
  if (!declared || !conditionedOnManager(declared)) return [];
  return declared.steps.flatMap((row, index) =>
    row.kind === 'conditional-write' || declared.transitionStep === index + 1 ? [index + 1] : [],
  );
}

/** A question mark that ends a clause; one inside a link's query string asks nothing. */
const QUESTION_MARK = /\?(?=$|[\s"'\u201d\u2019)\]])/;

/** The text a manager message carries, whichever transport it takes. */
function messageText(parsed: ParsedSurfaceAction): string {
  if (parsed.kind === 'mcp.call') {
    const text = ['text', 'message', 'body'].map((key) => parsed.toolArgs[key]).find((value) => typeof value === 'string');
    return typeof text === 'string' ? text : '';
  }
  return typeof parsed.bodyJson?.text === 'string' ? parsed.bodyJson.text : '';
}

/** The sentences of a message that ask, in order; the whole message when none can be cut out. */
function questionsIn(text: string): string {
  const asked = text.split(/(?<=[.?!])\s+|\n+/).filter((sentence) => QUESTION_MARK.test(sentence));
  return (asked.length > 0 ? asked.join(' ') : text).trim();
}

/** A question put to the manager that the plan's conditional writes wait on. */
export interface OpenManagerQuestion {
  /** The question as the manager DM asked it. */
  question: string;
  /** The actions to withhold, by index in the set, each with the one-based plan step it belongs to. */
  withheld: Array<{ index: number; step: number }>;
  /** The plan steps that wait on the answer, sorted. */
  steps: number[];
}

/**
 * The question a set leaves open, and the writes that wait on it.
 *
 * A set that asks the manager a question and also carries writes the approved
 * plan left to the manager has answered its own question for them. The writes
 * are the state change, and any other write to a surface that only
 * manager-conditional steps write; the question is a manager DM, in this set
 * or landed earlier in the run, that ends a clause with a question mark. A
 * message that reports, or sends a draft for approval, asks nothing: the
 * approval of the held write is that answer. Whether the manager has already
 * answered is the caller's to read from the ledger.
 *
 * Args:
 *   args: The plan, the set, the agent's surfaces, the manager messages this
 *     run already landed, and whether the manager has answered.
 *
 * Returns:
 *   The open question with the actions to withhold, or undefined when the
 *   set goes on as it stands.
 */
export function openManagerQuestion(args: {
  plan: ObligedPlan;
  actions: readonly MockAction[];
  surfaces: readonly SurfaceRecord[];
  askedEarlier?: readonly MockAction[];
  answered: boolean;
}): OpenManagerQuestion | undefined {
  if (args.answered) return undefined;
  const steps = managerConditionalSteps(args.plan);
  const declared = planObligations(args.plan);
  if (steps.length === 0 || !declared) return undefined;
  const parsedWith = (action: MockAction): { parsed: ParsedSurfaceAction; surface: SurfaceRecord } | undefined => {
    const result = parseSurfaceAction(action);
    const surface = result.ok ? args.surfaces.find((row) => row.slug === result.action.surface) : undefined;
    return result.ok && surface ? { parsed: result.action, surface } : undefined;
  };
  const asked = [...args.actions, ...(args.askedEarlier ?? [])].flatMap((action) => {
    const row = parsedWith(action);
    if (!row || !isManagerDm(row.parsed, row.surface)) return [];
    const text = messageText(row.parsed);
    return QUESTION_MARK.test(text) ? [questionsIn(text)] : [];
  });
  if (asked.length === 0) return undefined;
  const stepOf = (parsed: ParsedSurfaceAction): number | undefined => {
    if (isStatusChange(parsed)) return declared.transitionStep ?? steps[steps.length - 1];
    const slug = parsed.surface.toLowerCase();
    const writes = (step: number): boolean =>
      (declared.steps[step - 1]!.writes ?? []).some((written) => written.toLowerCase() === slug);
    const unconditional = declared.steps.some((row, index) => row.kind === 'write' && writes(index + 1));
    return unconditional ? undefined : steps.find(writes);
  };
  const waiting = args.actions.flatMap((action, index) => {
    const row = parsedWith(action);
    if (!row || actionIntent(row.parsed) !== 'write' || isManagerDm(row.parsed, row.surface)) return [];
    const step = stepOf(row.parsed);
    return step === undefined ? [] : [{ index, step }];
  });
  if (waiting.length === 0) return undefined;
  return {
    question: asked[0]!,
    withheld: waiting,
    steps: [...new Set(waiting.map((row) => row.step))].sort((a, b) => a - b),
  };
}

/** The ledger reason on a write withheld for the manager's answer. */
export function withheldForAnswerReason(step: number): string {
  return `withheld: the approved plan leaves step ${step} to the manager's answer, and the question put to the manager is still open`;
}

/**
 * Why a run stops with its question open.
 *
 * Args:
 *   open: The open question and the steps that wait on it.
 *
 * Returns:
 *   The reason the card shows, with the question as it was asked.
 */
export function openQuestionStopReason(open: Pick<OpenManagerQuestion, 'question' | 'steps'>): string {
  const steps = open.steps.map((step) => `step ${step}`).join(' and ');
  return `the approved plan leaves ${steps} to the manager's answer, and the question is still open. Asked in the manager DM: ${open.question}`;
}

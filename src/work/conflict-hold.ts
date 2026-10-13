/**
 * The steps a conflict's question holds at the apply (wave 16, 16-O; RM20 (a), D-4 (c)): a plan
 * drafted over a passage two equally trusted pages disagree on runs, and only the writes of the
 * steps that rely on the passage wait for the manager's answer. A step relies on it when one of
 * its cites carries the relation or one of the blocks the pages disagree in, and so does every
 * step after the first such: a plan's steps follow from one another, and a planner cites the
 * passage where it reads or drafts from it, not always where it writes (the pre-tag's re-walk on
 * the hosted model: the cite sat on the step that drafts a comment, the write two steps on). The
 * steps before it run. A plan that cites
 * nothing says nothing of which step relies on it, so every step waits, as it does for a conflict
 * the plan names in its own words and cites nowhere (D-1 (c), `planLeansOn`). Pure.
 */

import { contentWords } from '../agent/manager-questions';
import { actionIntent, isManagerDm, parseSurfaceAction } from '../surfaces/policy';
import type { SurfaceRecord } from '../surfaces/types';
import { planObligations } from './obligations';
import type { ExecutionPlan, MockAction } from './types';

/** A conflict as the hold reads it: its relation and the hashes of the blocks that disagree. */
export interface HeldConflict {
  readonly relationId: string;
  readonly blocks: readonly string[];
  /**
   * Set where the plan's own words lean on the conflict (`planLeansOn`): asked beside a plan none
   * of whose cites carries it, no cite says which step relies on the passage.
   */
  readonly leaned?: boolean;
}

/**
 * Whether a plan's own words rest on a conflict (the review's D-1 (c), the narrow ask): its
 * summary, steps and risk notes hold every content word of the heading the two pages disagree
 * under, or of one page's title. A planner shown a passage tagged `[conflict]` may say the step
 * waits on the dispute, or that the work is kept within the page's limits, and cite a neighbouring
 * passage, which the cited-blocks rule alone never asks about. One shared word is no lean: a phrase
 * counts with two content words or more, and a one-word heading only beside a word of a title.
 * English words only (`contentWords`): a heading in another script is asked about by its cite.
 *
 * @param plan - The plan's words, as stored.
 * @param conflict - The heading the pages disagree under and the two pages' titles.
 */
export function planLeansOn(
  plan: Partial<Pick<ExecutionPlan, 'summary' | 'steps' | 'riskNotes'>>,
  conflict: { readonly heading: string; readonly titles: readonly string[] },
): boolean {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const words = new Set(
    contentWords([plan.summary ?? '', ...steps, plan.riskNotes ?? ''].join(' ')),
  );
  const named = (phrase: readonly string[]): boolean => phrase.every((word) => words.has(word));
  const titles = conflict.titles.map(contentWords);
  if (titles.some((title) => title.length >= 2 && named(title))) return true;
  const heading = contentWords(conflict.heading);
  if (heading.length === 0 || !named(heading)) return false;
  return heading.length >= 2 || titles.some((title) => title.some((word) => words.has(word)));
}

/**
 * The one-based plan steps a conflict holds, sorted: the first step that cites the passage and
 * every step after it.
 *
 * @param plan - The approved plan, its cites as stored.
 * @param conflict - The relation, and the blocks its pages disagree in.
 */
export function conflictSteps(
  plan: Pick<ExecutionPlan, 'steps' | 'cites'>,
  conflict: HeldConflict,
): number[] {
  const cites = plan.cites ?? [];
  const every = plan.steps.map((_step, index) => index + 1);
  if (cites.length === 0) return every;
  const blocks = new Set(conflict.blocks);
  const steps = cites.flatMap((cite) =>
    cite.conflict?.relationId === conflict.relationId ||
    cite.blocks.some((block) => block.hash !== undefined && blocks.has(block.hash))
      ? [cite.step]
      : [],
  );
  if (steps.length === 0) return conflict.leaned === true ? every : [];
  const first = Math.min(...steps);
  return every.filter((step) => step >= first);
}

/**
 * The writes in a set the held steps make, each with its step: a write to a surface a held step
 * declares it writes, or every write when the plan declares no obligations to tell. A read is
 * never held (it changes nothing), nor a message to the manager, which may carry the question.
 *
 * @param args - The plan, the set, the agent's surfaces and the held steps.
 * @returns The writes by index in the set; empty when no step is held.
 */
export function conflictHeldWrites(args: {
  readonly plan: Pick<ExecutionPlan, 'steps' | 'obligations'>;
  readonly actions: readonly MockAction[];
  readonly surfaces: readonly SurfaceRecord[];
  readonly steps: readonly number[];
}): Array<{ index: number; step: number }> {
  if (args.steps.length === 0) return [];
  const declared = planObligations(args.plan);
  return args.actions.flatMap((action, index) => {
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || actionIntent(parsed.action) !== 'write') return [];
    const surface = args.surfaces.find((row) => row.slug === parsed.action.surface);
    if (surface !== undefined && isManagerDm(parsed.action, surface)) return [];
    if (declared === undefined) return [{ index, step: args.steps[0]! }];
    const slug = parsed.action.surface.toLowerCase();
    const step = args.steps.find((held) =>
      (declared.steps[held - 1]?.writes ?? []).some((written) => written.toLowerCase() === slug),
    );
    return step === undefined ? [] : [{ index, step }];
  });
}

/**
 * The surfaces whose writes the held steps make the hold withhold, as the question says it (W16-R10):
 * the hold withholds every write to a surface a held step declares it writes, a write of an
 * untouched step to the same surface among them, so the question names the surfaces rather than
 * claiming the other steps run whole. `every` when the plan declares no obligations to tell its
 * writes apart, and none when no step is held or the held steps write nothing.
 *
 * @param plan - The plan, its declared obligations as stored.
 * @param steps - The held steps (`conflictSteps`).
 * @returns The surfaces' slugs, each once in plan order, or `every`.
 */
export function heldWriteSurfaces(
  plan: Pick<ExecutionPlan, 'steps' | 'obligations'>,
  steps: readonly number[],
): string[] | 'every' {
  if (steps.length === 0) return [];
  const declared = planObligations(plan);
  if (declared === undefined) return 'every';
  return [...new Set(steps.flatMap((step) => declared.steps[step - 1]?.writes ?? []))];
}

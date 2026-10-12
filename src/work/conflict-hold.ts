/**
 * The steps a conflict's question holds at the apply (wave 16, 16-O; RM20 (a), D-4 (c)): a plan
 * drafted over a passage two equally trusted pages disagree on runs, and only the writes of the
 * steps that rely on the passage wait for the manager's answer. A step relies on it when one of
 * its cites carries the relation or one of the blocks the pages disagree in; a plan that cites
 * nothing says nothing of which step relies on it, so every step waits. Pure.
 */

import { actionIntent, isManagerDm, parseSurfaceAction } from '../surfaces/policy';
import type { SurfaceRecord } from '../surfaces/types';
import { planObligations } from './obligations';
import type { ExecutionPlan, MockAction } from './types';

/** A conflict as the hold reads it: its relation and the hashes of the blocks that disagree. */
export interface HeldConflict {
  readonly relationId: string;
  readonly blocks: readonly string[];
}

/**
 * The one-based plan steps a conflict holds, sorted.
 *
 * @param plan - The approved plan, its cites as stored.
 * @param conflict - The relation, and the blocks its pages disagree in.
 */
export function conflictSteps(
  plan: Pick<ExecutionPlan, 'steps' | 'cites'>,
  conflict: HeldConflict,
): number[] {
  const cites = plan.cites ?? [];
  if (cites.length === 0) return plan.steps.map((_step, index) => index + 1);
  const blocks = new Set(conflict.blocks);
  const steps = cites.flatMap((cite) =>
    cite.conflict?.relationId === conflict.relationId ||
    cite.blocks.some((block) => block.hash !== undefined && blocks.has(block.hash))
      ? [cite.step]
      : [],
  );
  return [...new Set(steps)].sort((left, right) => left - right);
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

import { actionIntent, isAuditComment, isStatusChange, parseSurfaceAction } from '../surfaces/policy';
import type { AppliedAction } from '../surfaces/types';
import { promisesResult } from './plan-steps';
import type { ExecutionOutput, ExecutionPlan, PlanStepOutcome } from './types';

export interface ClosingResume extends ExecutionOutput {
  phase: 'dependent-authoring';
  applied: AppliedAction[];
  resumedClosing: true;
  initialFailure: string;
  previousClosing: { actions: ExecutionOutput['actions']; applied: AppliedAction[] };
}

/** Older completed ledgers have no phase boundary; only an unambiguous closing suffix is reusable. */
export function closingResume(output: unknown, plan: ExecutionPlan, failure: string | undefined, surfaces: readonly { slug: string; displayName: string }[]): ClosingResume | undefined {
  if (!output || typeof output !== 'object' || !failure) return undefined;
  const row = output as ExecutionOutput & {
    applied?: AppliedAction[];
    planStepOutcomes?: PlanStepOutcome[];
    prerequisiteCount?: number;
  };
  if (!Array.isArray(row.actions) || !Array.isArray(row.applied)) return undefined;
  const boundary = row.prerequisiteCount ?? row.actions.findIndex(action => {
    const parsed = parseSurfaceAction(action);
    return parsed.ok && (isAuditComment(parsed.action) || isStatusChange(parsed.action));
  });
  if (!Number.isInteger(boundary) || boundary <= 0 || boundary >= row.actions.length) return undefined;
  const actions = row.actions.slice(0, boundary);
  const applied = row.applied.slice(0, boundary);
  if (applied.length !== actions.length || actions.some((_, index) => {
    const entry = applied[index];
    return !entry?.ok || entry.held || entry.awaitingApproval;
  })) return undefined;
  if (!actions.some(action => {
    const parsed = parseSurfaceAction(action);
    return parsed.ok && actionIntent(parsed.action) === 'read';
  })) return undefined;
  const prerequisites = plan.steps.flatMap((step, index) => promisesResult(step) ? [index + 1] : []);
  if (prerequisites.length === 0 || prerequisites.some(step => !row.planStepOutcomes?.some(
    outcome => outcome.step === step && outcome.status === 'satisfied' && outcome.basis !== 'manager-feedback' && outcome.evidence.trim(),
  ))) return undefined;
  const reads = new Set(actions.flatMap(action => {
    const parsed = parseSurfaceAction(action);
    return parsed.ok && actionIntent(parsed.action) === 'read' ? [parsed.action.surface] : [];
  }));
  for (const step of plan.steps.filter(promisesResult)) {
    const named = surfaces.filter(surface => [surface.slug, surface.displayName].some(name =>
      step.toLowerCase().includes(name.toLowerCase()),
    ));
    if (named.length === 0 || named.some(surface => !reads.has(surface.slug))) return undefined;
  }
  const closingActions = row.actions.slice(boundary);
  const closingApplied = row.applied.slice(boundary);
  if (closingActions.every((_, index) => closingApplied[index]?.ok && !closingApplied[index]?.held)) return undefined;
  return {
    draft: row.draft, notes: row.notes, actions, applied,
    needsDependentPhase: true, phase: 'dependent-authoring', resumedClosing: true,
    initialFailure: failure,
    previousClosing: { actions: closingActions, applied: closingApplied },
  };
}

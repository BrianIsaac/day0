import { reusedLedger } from './landed-writes';
import { actionIntent, isAuditComment, isStatusChange, parseSurfaceAction } from '../surfaces/policy';
import type { AppliedAction, SurfaceRecord } from '../surfaces/types';
import { promisedReads, promisesResult } from './plan-steps';
import type { ExecutionOutput, ExecutionPlan, LandedWrite, PlanStepOutcome, RefusedClosing } from './types';

export interface ClosingResume extends ExecutionOutput {
  phase: 'dependent-authoring';
  applied: AppliedAction[];
  resumedClosing: true;
  initialFailure: string;
  previousClosing: { actions: ExecutionOutput['actions']; applied: AppliedAction[] };
  /** The closing set the previous attempt's gate refused, for the closing prompt to correct. */
  refusedClosing?: RefusedClosing;
}

type Surface = { slug: string; displayName: string };

function landedEntry(entry: AppliedAction | undefined): boolean {
  return entry?.ok === true && !entry.held && !entry.awaitingApproval;
}

function isRead(action: ExecutionOutput['actions'][number]): boolean {
  const parsed = parseSurfaceAction(action);
  return parsed.ok && actionIntent(parsed.action) === 'read';
}

/**
 * Whether every surface the plan promises to read was read in the
 * prerequisites, bound by `promisedReads`, the same binding the closing
 * gate reads. A step that names no surface ("take a browser_snapshot and
 * read back the audit line", in the same session as the step before it) or
 * names one only as a write target has nothing here to check; the
 * landed-read rule beside this one is what covers it.
 */
function promisedSurfacesRead(actions: readonly ExecutionOutput['actions'][number][], plan: ExecutionPlan, surfaces: readonly Surface[]): boolean {
  const reads = new Set(actions.flatMap(action => {
    const parsed = parseSurfaceAction(action);
    return parsed.ok && actionIntent(parsed.action) === 'read' ? [parsed.action.surface.toLowerCase()] : [];
  }));
  return promisedReads(plan.steps, surfaces).every(read => reads.has(read.surface.slug.toLowerCase()));
}

/**
 * A run that died inside its closing gate: the row still carries the
 * prerequisite phase whole (the ledger is the phase boundary, nothing of
 * the closing set reached a surface) and, when the gate refused an
 * authored set, that set with its reason. The prerequisites landed, so the
 * retry authors the closing set again from the same ledger.
 */
function gateRefusalResume(row: ExecutionOutput & { phase?: unknown; applied?: AppliedAction[]; refusedClosing?: RefusedClosing }, plan: ExecutionPlan, failure: string, surfaces: readonly Surface[]): ClosingResume | undefined {
  if (row.phase !== 'dependent-authoring' || !Array.isArray(row.actions) || !Array.isArray(row.applied)) return undefined;
  if (row.actions.length === 0 || row.applied.length !== row.actions.length) return undefined;
  if (row.applied.some(entry => !landedEntry(entry))) return undefined;
  if (!row.actions.some(isRead)) return undefined;
  if (!promisedSurfacesRead(row.actions, plan, surfaces)) return undefined;
  const refused = row.refusedClosing;
  return {
    draft: row.draft, notes: row.notes,
    actions: row.actions, applied: row.applied,
    needsDependentPhase: true, phase: 'dependent-authoring', resumedClosing: true,
    initialFailure: failure,
    previousClosing: { actions: refused?.actions ?? [], applied: [] },
    ...(refused ? { refusedClosing: refused } : {}),
  };
}

/** Older completed ledgers have no phase boundary; only an unambiguous closing suffix is reusable. */
export function closingResume(output: unknown, plan: ExecutionPlan, failure: string | undefined, surfaces: readonly Surface[]): ClosingResume | undefined {
  if (!output || typeof output !== 'object' || !failure) return undefined;
  const row = output as ExecutionOutput & {
    phase?: unknown;
    applied?: AppliedAction[];
    planStepOutcomes?: PlanStepOutcome[];
    prerequisiteCount?: number;
    refusedClosing?: RefusedClosing;
  };
  if (row.phase === 'dependent-authoring') return gateRefusalResume(row, plan, failure, surfaces);
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
  if (!actions.some(isRead)) return undefined;
  const prerequisites = plan.steps.flatMap((step, index) => promisesResult(step) ? [index + 1] : []);
  if (prerequisites.length === 0 || prerequisites.some(step => !row.planStepOutcomes?.some(
    outcome => outcome.step === step && outcome.status === 'satisfied' && outcome.basis !== 'manager-feedback' && outcome.evidence.trim(),
  ))) return undefined;
  if (!promisedSurfacesRead(actions, plan, surfaces)) return undefined;
  const closingActions = row.actions.slice(boundary);
  const closingApplied = row.applied.slice(boundary);
  if (row.prerequisiteCount === undefined && closingActions.some(action => {
    const parsed = parseSurfaceAction(action);
    return !parsed.ok || actionIntent(parsed.action) === 'read' ||
      (parsed.action.kind === 'mcp.call' && /^browser[._-]/i.test(parsed.action.tool));
  })) return undefined;
  if (closingActions.every((_, index) => closingApplied[index]?.ok && !closingApplied[index]?.held)) return undefined;
  const landedClosing = closingActions.flatMap((action, index) => {
    const entry = closingApplied[index];
    return entry?.ok && !entry.held && !entry.awaitingApproval ? [{ action, entry }] : [];
  });
  return {
    draft: row.draft, notes: row.notes,
    actions: [...actions, ...landedClosing.map(row => row.action)],
    applied: [...applied, ...landedClosing.map(row => row.entry)],
    needsDependentPhase: true, phase: 'dependent-authoring', resumedClosing: true,
    initialFailure: failure,
    previousClosing: { actions: closingActions, applied: closingApplied },
  };
}

/**
 * The rows a resumed closing set reuses from the previous attempt: a row of
 * identical payload (the set is re-authored over the same landed
 * prerequisites), or a comment or message on a target the attempt already
 * landed on; see `reusedLedger`.
 */
export function resumedClosingLedger(
  actions: ExecutionOutput['actions'],
  previous: ClosingResume['previousClosing'] | undefined,
  run: { workItemId: string; runId: string; actionIndexOffset: number },
  options: { surfaces?: readonly SurfaceRecord[]; managerFeedback?: string } = {},
): Array<AppliedAction | undefined> {
  const sources: LandedWrite[] = (previous?.actions ?? []).flatMap((action, index): LandedWrite[] => {
    const entry = previous?.applied[index];
    return entry ? [{ action, applied: entry }] : [];
  });
  return reusedLedger(actions, sources, run, { ...options, identicalPayloads: true });
}

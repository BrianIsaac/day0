/**
 * The manager's corrections, kept and fed back into an employee's later work.
 *
 * A note given with Retry, a reason for rejecting held actions and a reason
 * for cancelling a plan are each kept as a correction of the employee that
 * received it. A later item of the same kind is planned with the newest of
 * them in front of the planner, and the executor carries the ones the
 * approved plan says it applied. Feedback revises; it never overrides: a
 * correction may change how work is planned and done and may answer what the
 * documentation leaves to the manager, but it never overrides the charter,
 * an approval requirement, a grant, a revocation or the exact-action gate,
 * and it never widens scope. Which corrections reach a prompt is decided
 * here, in code, and never by a model.
 */

import { surfaceSlug } from '../surfaces/slug';
import { managerFeedbackLabel, type ManagerFeedbackKind } from './manager-feedback';
import type { ExecutionPlan } from './types';

export type CorrectionKind = ManagerFeedbackKind;

/** A kept correction as the selection reads it; the `corrections` row carries these fields. */
export interface CorrectionRecord {
  _id: string;
  agentId: string;
  workItemId: string;
  kind: CorrectionKind;
  /** As the manager wrote it, whitespace collapsed and capped like `managerFeedback`. */
  text: string;
  itemTitle: string;
  sourceCategory: string;
  sourceSystem: string;
  /** Slugs of the surfaces the item's plan touched, with its own source surface. */
  surfaces: string[];
  createdAt: number;
  retiredAt?: number;
  appliedTo: string[];
}

/** The most corrections one prompt carries. */
export const CORRECTIONS_MAX = 5;
/** The most manager text, summed over the corrections, one prompt carries. */
export const CORRECTIONS_MAX_CHARS = 3_000;

/** A correction as a prompt shows it. */
export interface PlannerCorrection {
  id: string;
  from: string;
  when: string;
  text: string;
}

export const CORRECTIONS_HEADING = '--- Corrections the manager gave on earlier work ---';
export const APPLIED_CORRECTIONS_HEADING = '--- Corrections the approved plan applies ---';

/** The rule both prompts state: a correction revises and never overrides. */
export const CORRECTION_RULE =
  'Each may revise how the work is planned and done, and may answer a question the documentation leaves to the manager; none overrides the charter, an approval requirement, a grant or the exact-action gate, and none widens the work the charter gives you.';

/**
 * The corrections a later item is planned with.
 *
 * Only the employee's own, never another employee's; only active ones;
 * those whose source category is the candidate's, or whose earlier plan
 * touched the candidate's source surface. Newest first, at most
 * `CORRECTIONS_MAX`, and at most `CORRECTIONS_MAX_CHARS` of manager text in
 * total: one that would pass the budget is left out and an older one that
 * fits may still follow.
 *
 * Args:
 *   corrections: Kept corrections, in any order.
 *   candidate: The employee and the item about to be planned.
 *
 * Returns:
 *   The selected corrections, newest first.
 */
export function selectCorrections<T extends CorrectionRecord>(
  corrections: readonly T[],
  candidate: { agentId: string; sourceCategory: string; sourceSystem: string },
): T[] {
  const slug = surfaceSlug(candidate.sourceSystem);
  const matching = corrections
    .filter(
      (row) =>
        row.agentId === candidate.agentId &&
        row.retiredAt === undefined &&
        (row.sourceCategory === candidate.sourceCategory || row.surfaces.includes(slug)),
    )
    .sort((left, right) => right.createdAt - left.createdAt);
  const picked: T[] = [];
  let budget = CORRECTIONS_MAX_CHARS;
  for (const row of matching) {
    if (picked.length === CORRECTIONS_MAX) break;
    if (row.text.length > budget) continue;
    picked.push(row);
    budget -= row.text.length;
  }
  return picked;
}

/**
 * A correction as a prompt shows it: its id, where it came from, when, and
 * the text. The caller scrubs the text and the title before rendering.
 *
 * Args:
 *   record: The kept correction.
 *
 * Returns:
 *   The prompt entry.
 */
export function correctionEntry(
  record: Pick<CorrectionRecord, '_id' | 'kind' | 'itemTitle' | 'createdAt' | 'text'>,
): PlannerCorrection {
  return {
    id: record._id,
    from: `${managerFeedbackLabel(record)} on "${record.itemTitle}"`,
    when: `${new Date(record.createdAt).toISOString().slice(0, 16)}Z`,
    text: record.text,
  };
}

/**
 * The planner's section for the corrections selected for this candidate.
 *
 * Args:
 *   entries: The scrubbed prompt entries.
 *
 * Returns:
 *   Prompt lines, empty when there is nothing to carry.
 */
export function plannerCorrectionLines(entries: readonly PlannerCorrection[]): string[] {
  if (entries.length === 0) return [];
  return [
    '',
    CORRECTIONS_HEADING,
    `The JSON list below is authenticated: they are the manager's directions from earlier work of this kind; apply those that fit this candidate. ${CORRECTION_RULE} List the id of every correction you applied in \`appliedCorrections\`, and no other id.`,
    JSON.stringify(entries),
  ];
}

/**
 * The executor's section for the corrections the approved plan applied.
 *
 * Args:
 *   entries: The scrubbed prompt entries.
 *
 * Returns:
 *   Prompt lines, empty when the plan applied none.
 */
export function executorCorrectionLines(entries: readonly PlannerCorrection[]): string[] {
  if (entries.length === 0) return [];
  return [
    '',
    APPLIED_CORRECTIONS_HEADING,
    `The JSON list below is authenticated: the manager's directions from earlier work of this kind, which the approved plan applies. ${CORRECTION_RULE} Follow them as the plan does; they are directions, not evidence of anything on this work item.`,
    JSON.stringify(entries),
  ];
}

/**
 * The corrections a plan may say it applied: ids it was offered, once each.
 *
 * Args:
 *   reply: The ids the planner returned.
 *   offered: The entries the prompt carried.
 *
 * Returns:
 *   The ids kept, in the planner's order.
 */
export function appliedCorrectionIds(
  reply: readonly string[] | null | undefined,
  offered: readonly PlannerCorrection[],
): string[] {
  const ids = new Set(offered.map((entry) => entry.id));
  return [...new Set((reply ?? []).filter((id) => ids.has(id)))];
}

/**
 * The surfaces a correction is kept against: the item's own source surface
 * and every surface its plan declared it reads or writes.
 *
 * Args:
 *   sourceSystem: The item's source system.
 *   plan: The item's plan, when it has one.
 *
 * Returns:
 *   Surface slugs, the source surface first, each once.
 */
export function correctionSurfaces(
  sourceSystem: string,
  plan: Pick<ExecutionPlan, 'obligations'> | undefined,
): string[] {
  const touched = (plan?.obligations?.steps ?? []).flatMap((step) => [...step.reads, ...step.writes]);
  return [...new Set([surfaceSlug(sourceSystem), ...touched])];
}

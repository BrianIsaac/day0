import type { DocumentationSelectionRecord, PlanCite } from './types';

/*
 * A plan's cites (wave 14, 14-R): the documentation each step follows, named by the planner
 * from the cite lines its selection printed, and checked by the closing phase before it runs.
 */

/** A cite as the planner may write it: the words alone, or the whole `[cite: ...]` line. */
function citeWords(value: string): string {
  const trimmed = value.trim();
  const bracketed = /^\[cite:\s*(.*?)\s*\]$/i.exec(trimmed);
  return bracketed ? bracketed[1] : trimmed;
}

/**
 * The cites of a drafted plan: for each step, every cite line the planner named that the
 * selection printed, with the stored blocks under it. A cite the selection did not print is
 * dropped (the planner cannot cite a page it was not shown), as is a row past the last step.
 *
 * @param stepCites - The planner's rows, one a step in order, or null when it named none.
 * @param steps - How many steps the plan has.
 * @param documentation - The selection the planner read, when it read one.
 */
export function resolvedPlanCites(
  stepCites: ReadonlyArray<readonly string[]> | null | undefined,
  steps: number,
  documentation: Pick<DocumentationSelectionRecord, 'citations'> | undefined,
): PlanCite[] {
  if (!stepCites || !documentation) return [];
  const printed = new Map(documentation.citations.map((citation) => [citation.label, citation]));
  return stepCites.slice(0, steps).flatMap((labels, index) =>
    [...new Set(labels.map(citeWords))].flatMap((label): PlanCite[] => {
      const citation = printed.get(label);
      return citation ? [{ step: index + 1, label, blockIds: [...citation.blockIds] }] : [];
    }),
  );
}

/**
 * Why the closing phase did not run on a plan whose cited documentation is gone.
 *
 * @param labels - The cites whose blocks are gone, each once.
 */
export function goneCitesReason(labels: readonly string[]): string {
  const named = labels.map((label) => `"${label}"`).join(', ');
  return `The plan cited documentation that is no longer there (${named}): the page changed after the plan was approved, so the closing phase did not run on steps drawn from it. The item needs a plan drawn from the documentation as it is now.`;
}

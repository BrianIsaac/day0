import type { CitedBlock, DocumentationSelectionRecord, PlanCite } from './types';

/*
 * A plan's cites (wave 14, 14-R): the documentation each step follows, named by the planner
 * from the cite lines its selection printed, and checked by the closing phase before it runs.
 */

/** A cite as the planner may write it: the words alone, `cite: ` before them, or the whole line. */
function citeWords(value: string): string {
  const trimmed = value.trim();
  const written = /^\[?cite:\s*(.*?)\s*\]?$/i.exec(trimmed);
  return written ? written[1] : trimmed;
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
  // One label printed twice (a heading repeated on a page) stands for every block under it.
  const printed = new Map<string, CitedBlock[]>();
  for (const citation of documentation.citations) {
    printed.set(citation.label, [...(printed.get(citation.label) ?? []), ...citation.blocks]);
  }
  return stepCites.slice(0, steps).flatMap((labels, index) =>
    [...new Set(labels.map(citeWords))].flatMap((label): PlanCite[] => {
      const blocks = printed.get(label);
      return blocks ? [{ step: index + 1, label, blocks }] : [];
    }),
  );
}

/** How a gone cite's reason opens, so a Retry can tell it from any other failure. */
const GONE_CITES_OPENING = 'Documentation the plan followed has since been changed or removed';

/**
 * Whether a run's failure is a gone cite's: the plan it ran on cites documentation that has
 * since changed, so only a new plan can go on (14-R's gone cite, ruled 8 October 2026).
 *
 * @param failure - The run's failure, without the stopped prefix (`stopDetail`).
 */
export function isGoneCitesReason(failure: string): boolean {
  return failure.startsWith(GONE_CITES_OPENING);
}

/**
 * Why a run did not go on with a plan whose cited documentation is gone or changed: kept under
 * the failure line's 300 characters, so it names the first cite and counts the rest.
 *
 * @param labels - The cites whose blocks are gone or changed, each once.
 */
export function goneCitesReason(labels: readonly string[]): string {
  const [first, ...rest] = labels;
  const named = `"${first.length > 90 ? `${first.slice(0, 87)}...` : first}"${
    rest.length > 0 ? ` and ${rest.length} more` : ''
  }`;
  return `${GONE_CITES_OPENING} (${named}), so Day0 did not run the plan on instructions that may be out of date. The item needs a new plan.`;
}

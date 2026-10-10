import type { PageStatus } from '../docs/authority';
import type { CitedBlock, DocumentationSelectionRecord, PlanCite } from './types';

/*
 * A plan's cites (wave 14, 14-R): the documentation each step follows, named by the planner
 * from the cite lines its selection printed, and checked by the closing phase before it runs.
 */

/**
 * A cite as the planner may write it: the words alone, `cite: ` before them, or the whole line,
 * with or without the `[conflict]` tag a disputed line ends with.
 */
function citeWords(value: string): string {
  const trimmed = value
    .trim()
    .replace(/\s*\[conflict\]$/i, '')
    .trim();
  const written = /^\[?cite:\s*(.*?)\s*\]?$/i.exec(trimmed);
  return written ? written[1] : trimmed;
}

/**
 * The cites of a drafted plan: for each step, every cite line the planner named that the
 * selection printed, with the stored blocks under it and the source and page it is of. A cite
 * the selection did not print is dropped (the planner cannot cite a page it was not shown), as is
 * a row past the last step.
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
  // One label printed twice (a heading repeated on a page) stands for every block under it. Two
  // sources never print one label: the selection tells same-labelled sources apart (W14-R27).
  const printed = new Map<string, Omit<PlanCite, 'step' | 'blocks'> & { blocks: CitedBlock[] }>();
  for (const citation of documentation.citations) {
    const held = printed.get(citation.label);
    if (held !== undefined) {
      held.blocks.push(...citation.blocks);
      continue;
    }
    printed.set(citation.label, {
      label: citation.label,
      ...(citation.sourceId !== undefined ? { sourceId: citation.sourceId } : {}),
      ...(citation.pageRef !== undefined ? { pageRef: citation.pageRef } : {}),
      blocks: [...citation.blocks],
      ...(citation.conflict !== undefined ? { conflict: citation.conflict } : {}),
    });
  }
  return stepCites.slice(0, steps).flatMap((labels, index) =>
    [...new Set(labels.map(citeWords))].flatMap((label): PlanCite[] => {
      const cited = printed.get(label);
      return cited ? [{ step: index + 1, ...cited }] : [];
    }),
  );
}

/** How every gone cite's reason opens, so a Retry can tell it from any other failure. */
const GONE_CITES_OPENING = 'Documentation the plan followed has since been ';

/** What became of the documentation a gone cite named, as its reason says it. */
const GONE_AS: Readonly<Record<Exclude<PageStatus, 'active'>, string>> = {
  superseded: 'superseded',
  archived: 'archived',
  draft: 'marked a draft',
};

/**
 * Whether a run's failure is a gone cite's: the plan it ran on cites documentation that has
 * since changed, was removed or is no longer current, so only a new plan can go on (14-R's gone
 * cite, ruled 8 October 2026; a page's status, 15-A).
 *
 * @param failure - The run's failure, without the stopped prefix (`stopDetail`).
 */
export function isGoneCitesReason(failure: string): boolean {
  return failure.startsWith(GONE_CITES_OPENING);
}

/** A cite that no longer stands: its words and, when its page is no longer current, why. */
export interface GoneCite {
  /** The cite line's words, or the page for a passage the plan was drafted from but did not cite. */
  readonly label: string;
  /** The status its page has now, when that is why the cite is gone. */
  readonly status?: Exclude<PageStatus, 'active'>;
  /** The title of the page that superseded it, when one is named. */
  readonly supersededBy?: string;
}

/** Text cut to a length with an ellipsis, for a line with a bound. */
function cut(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

/**
 * Why a run did not go on with a plan whose cited documentation no longer stands: kept under
 * the failure line's 300 characters, so it names the first cite and counts the rest. A page
 * that is no longer current says so, and what superseded it (the wave file's section 8); a
 * block that changed or went says "changed or removed".
 *
 * @param gone - The cites that no longer stand, each once; a bare string is one whose block
 *   changed or went.
 */
export function goneCitesReason(gone: ReadonlyArray<string | GoneCite>): string {
  const [first, ...rest] = gone.map((cite) => (typeof cite === 'string' ? { label: cite } : cite));
  const more = rest.length > 0 ? ` and ${rest.length} more` : '';
  const cite = `"${cut(first.label, 90)}"`;
  if (first.status === undefined) {
    return `${GONE_CITES_OPENING}changed or removed (${cite}${more}), so Day0 did not run the plan on instructions that may be out of date. The item needs a new plan.`;
  }
  const by =
    first.status === 'superseded' && first.supersededBy !== undefined
      ? ` by "${cut(first.supersededBy, 60)}"`
      : '';
  return `${GONE_CITES_OPENING}${GONE_AS[first.status]} (${cite}${by}${more}), so Day0 did not run the plan on it. The item needs a new plan.`;
}

import { pageWords } from '../agent/reorientation-words';
import type { PageStatus } from '../docs/authority';
import type { CiteConflict, CitedBlock, DocumentationSelectionRecord, PlanCite } from './types';

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
  const printed = new Map<
    string,
    Omit<PlanCite, 'step' | 'blocks' | 'conflict'> & {
      blocks: CitedBlock[];
      conflict?: CiteConflict;
    }
  >();
  for (const citation of documentation.citations) {
    const held = printed.get(citation.label);
    if (held !== undefined) {
      held.blocks.push(...citation.blocks);
      // A later passage under the same label that is disputed keeps its tag (W15-R18).
      held.conflict ??= citation.conflict;
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

/** How a run's stop on a conflict confirmed since its plan was approved opens (D-4 (b)). */
const CONFLICT_CONFIRMED_OPENING = 'Since you approved this plan, you confirmed that ';

/**
 * Whether a run's failure is a gone cite's: the plan it ran on cites documentation that has
 * since changed, was removed or is no longer current, so only a new plan can go on (14-R's gone
 * cite, ruled 8 October 2026; a page's status, 15-A); or two pages it relies on were confirmed to
 * disagree since it was approved (D-4 (b), wave 16).
 *
 * @param failure - The run's failure, without the stopped prefix (`stopDetail`).
 */
export function isGoneCitesReason(failure: string): boolean {
  return failure.startsWith(GONE_CITES_OPENING) || failure.startsWith(CONFLICT_CONFIRMED_OPENING);
}

/** The most a run's failure keeps (`safeFailureMessage`'s cut), which the stop's reason fits. */
const CONFLICT_REASON_CHARS = 300;

/** A name cut to a length, marked where it was cut. */
function cutTo(name: string, chars: number): string {
  return name.length <= chars ? name : `${name.slice(0, Math.max(1, chars - 3)).trimEnd()}...`;
}

/**
 * Why a run stopped on a conflict the manager confirmed after approving its plan (D-4 (b); the
 * wave file's section 7, after "Stopped: "): Retry drafts the plan again, as for a gone cite.
 * Each page is named by its letter, title and source as the question names it (W16-R12, W4a), and
 * the names are cut, never the sentence, so the reason fits the failure's 300 characters with
 * "Retry drafts the plan again." whole.
 */
export function conflictConfirmedReason(
  heading: string,
  pages: readonly [CiteConflict['pages'][0], CiteConflict['pages'][1]],
): string {
  const said = (under: string, a: CiteConflict['pages'][0], b: CiteConflict['pages'][1]): string =>
    `${CONFLICT_CONFIRMED_OPENING}${pageWords('A', a)}, and ${pageWords('B', b)} disagree under “${under}”. Retry drafts the plan again.`;
  const whole = said(heading, pages[0], pages[1]);
  if (whole.length <= CONFLICT_REASON_CHARS) return whole;
  const empty = { title: '', source: '' };
  // Five names share what the sentence leaves of the cut: two titles, two sources, the heading.
  const each = Math.floor((CONFLICT_REASON_CHARS - said('', empty, empty).length) / 5);
  const cut = (page: CiteConflict['pages'][0]): CiteConflict['pages'][0] => ({
    title: cutTo(page.title, each),
    source: cutTo(page.source, each),
  });
  return said(cutTo(heading, each), cut(pages[0]), cut(pages[1]));
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

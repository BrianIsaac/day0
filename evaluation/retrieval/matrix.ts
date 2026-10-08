import { SEARCH_TERM_MAX_BYTES, searchTextOf } from '../../src/docs/blocks';
import {
  pageBlocksOf,
  scoutQueries,
  selectDocumentation,
  selectionRequestFor,
  type SelectableBlock,
  type SelectablePage,
} from '../../src/docs/select';
import {
  RETRIEVAL_CASES,
  RETRIEVAL_ROLES,
  RETRIEVAL_SURFACES,
  retrievalPages,
  type RetrievalCase,
} from './fixture';

/*
 * The retrieval grade (wave 14, 14-R): recall at 6 pages and at 12 blocks of the selection over
 * the labelled set, in the `evaluation/gate/` pattern. No model and no backend: the selector is
 * pure, and the scout is emulated (`scoutedBlocks`), because convex-test's search matches
 * prefixes with no ranking (C4) and a bed's search cannot be run in a test.
 */

/** R2's bar: recall at 6 pages and at 12 blocks. */
export const RECALL_BAR = { pages: 0.9, blocks: 0.8 } as const;

/** The most blocks the emulated scout keeps of one source for one query, as the selection asks. */
const SCOUT_LIMIT_PER_SOURCE = 12;

/** Labels and the share of them found. */
export interface RecallOf {
  expected: string[];
  missed: string[];
  recall: number;
}

/** One labelled item's grade. */
export interface RetrievalObservation {
  id: string;
  /** The labelled pages and the share of them the prompt carries. */
  pages: RecallOf;
  /** The labelled sections and the share of them the prompt carries a block of. */
  sections: RecallOf;
  /**
   * The ranked pick alone (at most 6 pages and 12 blocks) against the labels the pages always
   * included do not cover: what the search and the re-score found. Null where those pages cover
   * every label.
   */
  ranked: { pages: RecallOf | null; sections: RecallOf | null };
  /** The pages always included, then the picked pages, by key. */
  promptPages: string[];
  /** The documentation characters the prompt carries. */
  chars: number;
}

/** One run of the grade. */
export interface RetrievalGradeEvidence {
  schemaVersion: 1;
  experiment: 'day0-retrieval-recall';
  generatedAt: string;
  commit: string;
  /** Whether the selector or the set had changes not yet committed at `commit` when graded. */
  uncommittedChanges?: boolean;
  cases: number;
  observations: RetrievalObservation[];
  /** The mean recall over the cases of what the prompt carries, at 6 pages and at 12 blocks. */
  recall: { pages: number; blocks: number };
  /** The mean recall of the ranked pick alone, over the cases with labels left to find. */
  rankedRecall: { pages: number; blocks: number; pageCases: number; blockCases: number };
  bar: typeof RECALL_BAR;
  meetsBar: boolean;
  noModelCalls: true;
}

/** What the index keeps of a block's search text: SimpleTokenizer's lower-case terms. */
function indexTerms(searchText: string): string[] {
  const encoder = new TextEncoder();
  return [...searchText.matchAll(/[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]+/gu)]
    .map((match) => match[0].toLowerCase())
    .filter((term) => encoder.encode(term).length <= SEARCH_TERM_MAX_BYTES);
}

/**
 * The scout as the backend answers it: for each query string, each source's blocks holding a
 * query term (the last term as a prefix, every other exactly), best first by how many of the
 * query's terms they hold, at most 12 a source. A stand-in for the index's BM25 ranking, which
 * no test can run.
 */
export function scoutedBlocks(
  queries: readonly string[],
  pages: readonly SelectablePage[],
): SelectableBlock[] {
  const blocks = pages.flatMap((page) =>
    pageBlocksOf(page).map((block) => ({
      block: { ...block, id: `${page.key}#${block.index}` },
      source: page.citeSource,
      terms: new Set(indexTerms(searchTextOf(block.headingPath, block.text))),
    })),
  );
  const found = new Map<string, SelectableBlock>();
  for (const query of queries) {
    const terms = query.split(' ');
    const last = terms[terms.length - 1];
    const hits = blocks
      .map((entry) => ({
        ...entry,
        hits:
          terms.slice(0, -1).filter((term) => entry.terms.has(term)).length +
          ([...entry.terms].some((term) => term.startsWith(last)) ? 1 : 0),
      }))
      .filter((entry) => entry.hits > 0);
    const perSource = new Map<string, number>();
    for (const entry of [...hits].sort((left, right) => right.hits - left.hits)) {
      const taken = perSource.get(entry.source) ?? 0;
      if (taken === SCOUT_LIMIT_PER_SOURCE) continue;
      perSource.set(entry.source, taken + 1);
      found.set(entry.block.id, entry.block);
    }
  }
  return [...found.values()];
}

/** The labels, those of them not found, and the share found; 1 when nothing was expected. */
function recallOf(expected: readonly string[], found: ReadonlySet<string>): RecallOf {
  const missed = expected.filter((key) => !found.has(key));
  return {
    expected: [...expected],
    missed,
    recall: expected.length === 0 ? 1 : (expected.length - missed.length) / expected.length,
  };
}

/** Grade one labelled item: the planner's selection for it, against what a person would open. */
export function gradeCase(
  entry: RetrievalCase,
  pages: readonly SelectablePage[],
): RetrievalObservation {
  const request = selectionRequestFor({
    site: 'plan',
    candidate: {
      title: entry.title,
      contentSummary: entry.summary,
      sourceSystem: entry.sourceSystem,
      ...(entry.requester ? { requester: entry.requester } : {}),
    },
    roleFunction: RETRIEVAL_ROLES[entry.role],
    surfaces: RETRIEVAL_SURFACES,
  });
  const scouted = scoutedBlocks(scoutQueries(request, pages), pages);
  const selection = selectDocumentation({ request, pages, scouted });
  const byKey = new Map(pages.map((page) => [page.key, page]));
  const picked = selection.picked.map((key) => {
    const at = key.lastIndexOf('#');
    return { page: key.slice(0, at), index: Number(key.slice(at + 1)) };
  });
  const promptPages = [...new Set([...selection.always, ...picked.map((block) => block.page)])];
  const sectionOf = (page: string, headingPath: readonly string[]): string =>
    `${page}#${headingPath[headingPath.length - 1] ?? ''}`;
  const pickedSections = picked.map((block) =>
    sectionOf(block.page, pageBlocksOf(byKey.get(block.page)!)[block.index].headingPath),
  );
  const alwaysSections = selection.always.flatMap((key) =>
    pageBlocksOf(byKey.get(key)!).map((block) => sectionOf(key, block.headingPath)),
  );
  const expectedSections = entry.sections.map((section) => `${section.page}#${section.heading}`);
  const always = new Set(selection.always);
  const leftPages = entry.pages.filter((key) => !always.has(key));
  const leftSections = entry.sections
    .filter((section) => !always.has(section.page))
    .map((section) => `${section.page}#${section.heading}`);
  return {
    id: entry.id,
    pages: recallOf(entry.pages, new Set(promptPages)),
    sections: recallOf(expectedSections, new Set([...alwaysSections, ...pickedSections])),
    ranked: {
      pages:
        leftPages.length === 0
          ? null
          : recallOf(leftPages, new Set(picked.map((block) => block.page))),
      sections: leftSections.length === 0 ? null : recallOf(leftSections, new Set(pickedSections)),
    },
    promptPages,
    chars: selection.chars,
  };
}

/** The mean of the values; 0 for none. */
function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

/** Grade every labelled item at a commit, without a model. */
export function buildRetrievalGrade(commit: string, now = new Date()): RetrievalGradeEvidence {
  const pages = retrievalPages();
  const observations = RETRIEVAL_CASES.map((entry) => gradeCase(entry, pages));
  const recall = {
    pages: mean(observations.map((row) => row.pages.recall)),
    blocks: mean(observations.map((row) => row.sections.recall)),
  };
  const rankedPages = observations.flatMap((row) =>
    row.ranked.pages ? [row.ranked.pages.recall] : [],
  );
  const rankedBlocks = observations.flatMap((row) =>
    row.ranked.sections ? [row.ranked.sections.recall] : [],
  );
  const rankedRecall = {
    pages: mean(rankedPages),
    blocks: mean(rankedBlocks),
    pageCases: rankedPages.length,
    blockCases: rankedBlocks.length,
  };
  return {
    schemaVersion: 1,
    experiment: 'day0-retrieval-recall',
    generatedAt: now.toISOString(),
    commit,
    cases: observations.length,
    observations,
    recall,
    rankedRecall,
    bar: RECALL_BAR,
    meetsBar: [recall, rankedRecall].every(
      (row) => row.pages >= RECALL_BAR.pages && row.blocks >= RECALL_BAR.blocks,
    ),
    noModelCalls: true,
  };
}

/** A share as a percentage with one decimal. */
function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Render a grade as the Markdown kept beside its JSON. */
export function renderRetrievalGrade(evidence: RetrievalGradeEvidence): string {
  const rows = evidence.observations.map(
    (row) =>
      `| ${row.id} | ${percent(row.pages.recall)} | ${percent(row.sections.recall)} | ${row.ranked.pages ? percent(row.ranked.pages.recall) : '-'} | ${row.ranked.sections ? percent(row.ranked.sections.recall) : '-'} | ${row.chars.toLocaleString('en-GB')} | ${
        [...row.pages.missed, ...row.sections.missed].join(', ') || 'none'
      } |`,
  );
  return [
    '# Retrieval recall',
    '',
    `Generated ${evidence.generatedAt} at commit \`${evidence.commit}\`${evidence.uncommittedChanges ? ' with the uncommitted changes the commit that tracks this grade carries' : ''}, without a model: the selector over the labelled set (n=${evidence.cases}), the scout emulated (the backend's ranking cannot run in a test).`,
    '',
    `What the prompt carries (the pages always included and the ranked pick of at most 6 pages and 12 blocks): recall of pages **${percent(evidence.recall.pages)}**, of sections **${percent(evidence.recall.blocks)}**.`,
    '',
    `The ranked pick alone, against the labels the pages always included leave (${evidence.rankedRecall.pageCases} items with pages left, ${evidence.rankedRecall.blockCases} with sections left): recall at 6 pages **${percent(evidence.rankedRecall.pages)}**, at 12 blocks **${percent(evidence.rankedRecall.blocks)}**.`,
    '',
    `R2's bar: ${percent(evidence.bar.pages)} of pages, ${percent(evidence.bar.blocks)} of blocks, on both. ${evidence.meetsBar ? 'At or above the bar.' : 'Below the bar.'}`,
    '',
    '| Item | Pages | Sections | Ranked pages | Ranked sections | Characters | Missed |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

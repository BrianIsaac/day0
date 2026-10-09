import { SEARCH_BLOCKS_LIMIT, SEARCH_SOURCES_LIMIT } from '../../convex/docBlocks';
import { pageBlocksOf, type SelectableBlock, type SelectablePage } from '../../src/docs/select';
import {
  buildRetrievalGrade,
  type BackendScoutRecord,
  type RetrievalGradeEvidence,
  type Scout,
} from './matrix';

/*
 * The labelled set graded once with a bed's own search as the scout (the wave 14 review's D-5 and
 * W14-R30): the corpus ingested and split by the backend, each item's queries answered by
 * `docBlocks.searchBlocks` as the product's scout calls it, and the rest of the selection as
 * `matrix.ts` runs it. A grade made here carries `scout: "backend"`; the test that reproduces
 * every tracked grade cannot run a backend, so it skips such a grade by that field.
 */

/** The most blocks the product's scout asks of one source for one query (`convex/docSelection.ts`). */
const PRODUCT_SCOUT_LIMIT_PER_SOURCE = 12;

/** A linked source of the bed and the corpus source (the key's prefix) whose pages it holds. */
export interface BedSource {
  readonly id: string;
  readonly corpus: string;
}

/** A `docPages` row as the bed stores it, the fields the proof reads. */
export interface StoredPageRow {
  readonly sourceId: string;
  readonly ref: string;
  readonly title: string;
}

/** A `docBlocks` row, as stored or as the search answers it, the fields the grade reads. */
export interface StoredBlockRow {
  readonly sourceId: string;
  readonly pageRef: string;
  readonly index: number;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly hash: string;
}

/** One `docBlocks.searchBlocks` call: the sources of one run, one query, so many a source. */
export type BlockSearch = (search: {
  sourceIds: string[];
  query: string;
  limit: number;
}) => StoredBlockRow[];

/** What the bed stores of the corpus, proved before any search. */
export type IngestionProof = Pick<
  BackendScoutRecord,
  'pagesStored' | 'blocksStored' | 'blocksByPage' | 'textDiffers'
>;

/**
 * The blocks the product's scout asks of each source for each query: at most 12, and together at
 * most `SEARCH_BLOCKS_LIMIT` (`convex/docSelection.ts`, `scoutedBlocks`).
 */
export function scoutLimit(sources: number, queries: number): number {
  return Math.max(
    1,
    Math.min(PRODUCT_SCOUT_LIMIT_PER_SOURCE, Math.floor(SEARCH_BLOCKS_LIMIT / (sources * queries))),
  );
}

/** The sources in runs of at most `SEARCH_SOURCES_LIMIT`, one search a run, as the product makes them. */
export function sourceRuns<T>(ids: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < ids.length; start += SEARCH_SOURCES_LIMIT) {
    runs.push(ids.slice(start, start + SEARCH_SOURCES_LIMIT));
  }
  return runs;
}

/** The corpus key of a stored row: its source's corpus and its ref. */
function corpusKey(sources: readonly BedSource[], sourceId: string, ref: string): string {
  const source = sources.find((entry) => entry.id === sourceId);
  if (source === undefined)
    throw new Error(`Source ${sourceId} is not one of the bed's corpus sources.`);
  return `${source.corpus}:${ref}`;
}

/**
 * Prove the corpus stored and split on the bed as the selector splits it: every page stored under
 * its source, with as many blocks as `pageBlocksOf` gives it, each under the same heading path,
 * so a block found by its index is the block the labels name.
 *
 * @returns The counts, and the pages whose stored text differs from the tree's.
 * @throws Error naming a page not stored, or stored in another number of blocks or under another
 *   heading path.
 */
export function ingestionProof(
  pages: readonly SelectablePage[],
  sources: readonly BedSource[],
  storedPages: readonly StoredPageRow[],
  storedBlocks: readonly StoredBlockRow[],
): IngestionProof {
  const storedKeys = new Set(storedPages.map((row) => corpusKey(sources, row.sourceId, row.ref)));
  const blocksOf = new Map<string, StoredBlockRow[]>();
  for (const row of storedBlocks) {
    const key = corpusKey(sources, row.sourceId, row.pageRef);
    blocksOf.set(key, [...(blocksOf.get(key) ?? []), row]);
  }
  const blocksByPage: Record<string, number> = {};
  const textDiffers: string[] = [];
  for (const page of pages) {
    if (!storedKeys.has(page.key)) throw new Error(`${page.key} is not stored on the bed.`);
    const split = pageBlocksOf(page);
    const stored = [...(blocksOf.get(page.key) ?? [])].sort(
      (left, right) => left.index - right.index,
    );
    const sameShape =
      stored.length === split.length &&
      stored.every(
        (row, at) =>
          row.index === split[at].index &&
          JSON.stringify(row.headingPath) === JSON.stringify(split[at].headingPath),
      );
    if (!sameShape) {
      throw new Error(
        `${page.key} is stored in ${stored.length} blocks where the selector splits ${split.length}, or under other headings.`,
      );
    }
    if (stored.some((row, at) => row.text !== split[at].text)) textDiffers.push(page.key);
    blocksByPage[page.key] = stored.length;
  }
  return {
    pagesStored: pages.length,
    blocksStored: Object.values(blocksByPage).reduce((total, count) => total + count, 0),
    blocksByPage,
    textDiffers,
  };
}

/**
 * A scout that answers from the bed's search as the product's does: each query over every run of
 * the sources, so many a source, each block keyed by its corpus page and index.
 *
 * @returns The scout, and how many searches it has made.
 */
export function backendScout(
  search: BlockSearch,
  sources: readonly BedSource[],
): { scout: Scout; searches: () => number } {
  let searches = 0;
  const runs = sourceRuns(sources.map((source) => source.id));
  const scout: Scout = (queries) => {
    const limit = scoutLimit(sources.length, queries.length);
    const found = new Map<string, SelectableBlock>();
    for (const query of queries) {
      for (const sourceIds of runs) {
        searches += 1;
        for (const row of search({ sourceIds, query, limit })) {
          const pageKey = corpusKey(sources, row.sourceId, row.pageRef);
          const id = `${pageKey}#${row.index}`;
          if (!found.has(id)) {
            found.set(id, {
              id,
              pageKey,
              index: row.index,
              headingPath: row.headingPath,
              text: row.text,
              hash: row.hash,
            });
          }
        }
      }
    }
    return [...found.values()];
  };
  return { scout, searches: () => searches };
}

/**
 * Grade the labelled set with a bed's search as the scout, and record the bed, the proof and the
 * emulated grade it is read beside.
 */
export function buildBackendGrade(input: {
  commit: string;
  now: Date;
  scout: Scout;
  searches: () => number;
  bed: { project: string; image: string };
  proof: IngestionProof;
  emulated: BackendScoutRecord['emulated'];
}): RetrievalGradeEvidence {
  const grade = buildRetrievalGrade(input.commit, input.now, { scout: input.scout });
  return {
    ...grade,
    scout: 'backend',
    backend: {
      ...input.bed,
      searches: input.searches(),
      ...input.proof,
      emulated: input.emulated,
    },
  };
}

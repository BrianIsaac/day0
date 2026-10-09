import { describe, expect, it } from 'vitest';
import { pageBlocksOf, type SelectablePage } from '../../src/docs/select';
import {
  backendScout,
  buildBackendGrade,
  ingestionProof,
  scoutLimit,
  sourceRuns,
  type BedSource,
  type BlockSearch,
  type StoredBlockRow,
  type StoredPageRow,
} from './backend';
import { retrievalPages } from './fixture';
import { buildRetrievalGrade, renderRetrievalGrade, scoutedBlocks } from './matrix';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const IMAGE = `sha256:${'a'.repeat(64)}`;

/** The bed's three folder sources, one for each of the corpus's sources. */
const SOURCES: readonly BedSource[] = [
  { id: 'source-company', corpus: 'company' },
  { id: 'source-notion', corpus: 'notion' },
  { id: 'source-rehearsal', corpus: 'rehearsal' },
];

/** The corpus as a bed would store it: each page's row and its blocks split as here. */
function storedRows(pages: readonly SelectablePage[]): {
  pages: StoredPageRow[];
  blocks: StoredBlockRow[];
} {
  const sourceOf = (key: string): { sourceId: string; ref: string } => {
    const [corpus, ref] = key.split(/:(.*)/s);
    return { sourceId: SOURCES.find((source) => source.corpus === corpus)!.id, ref };
  };
  return {
    pages: pages.map((page) => ({ ...sourceOf(page.key), title: page.title })),
    blocks: pages.flatMap((page) => {
      const { sourceId, ref } = sourceOf(page.key);
      return pageBlocksOf(page).map((block) => ({
        sourceId,
        pageRef: ref,
        index: block.index,
        headingPath: [...block.headingPath],
        text: block.text,
        hash: `hash-${ref}-${block.index}`,
      }));
    }),
  };
}

/** A search that answers as the emulated scout does, one source at a time. */
function emulatedSearch(pages: readonly SelectablePage[]): BlockSearch {
  const rows = storedRows(pages).blocks;
  return ({ sourceIds, query, limit }) =>
    sourceIds.flatMap((sourceId) => {
      const corpus = SOURCES.find((source) => source.id === sourceId)!.corpus;
      const own = pages.filter((page) => page.key.startsWith(`${corpus}:`));
      return scoutedBlocks([query], own)
        .slice(0, limit)
        .map(
          (block) =>
            rows.find(
              (row) =>
                row.sourceId === sourceId &&
                `${corpus}:${row.pageRef}` === block.pageKey &&
                row.index === block.index,
            )!,
        );
    });
}

describe('the labelled set graded with a bed’s own search as the scout', (): void => {
  it('asks each source for as many blocks as the product’s scout does', (): void => {
    // convex/docSelection.ts `scoutedBlocks`: at most 12 a source, and 512 blocks in all.
    expect(scoutLimit(3, 4)).toBe(12);
    expect(scoutLimit(33, 4)).toBe(3);
    expect(scoutLimit(600, 1)).toBe(1);
    expect(
      sourceRuns(Array.from({ length: 33 }, (_, index) => index)).map((run) => run.length),
    ).toEqual([32, 1]);
  });

  it('proves every corpus page stored and split as the selector splits it, before any search', (): void => {
    const pages = retrievalPages();
    const stored = storedRows(pages);
    const proof = ingestionProof(pages, SOURCES, stored.pages, stored.blocks);
    expect(proof.pagesStored).toBe(17);
    expect(proof.blocksStored).toBe(stored.blocks.length);
    expect(Object.keys(proof.blocksByPage)).toHaveLength(17);
    expect(proof.textDiffers).toEqual([]);

    const missing = stored.pages.filter((page) => page.ref !== 'onboarding.md');
    expect(() => ingestionProof(pages, SOURCES, missing, stored.blocks)).toThrow(
      'company:onboarding.md is not stored',
    );
    const short = stored.blocks.filter(
      (block) => !(block.pageRef === 'onboarding.md' && block.index === 0),
    );
    expect(() => ingestionProof(pages, SOURCES, stored.pages, short)).toThrow(
      'company:onboarding.md is stored in',
    );
    const redacted = stored.blocks.map((block) =>
      block.pageRef === 'onboarding.md' && block.index === 0
        ? { ...block, text: '[redacted]' }
        : block,
    );
    expect(ingestionProof(pages, SOURCES, stored.pages, redacted).textDiffers).toEqual([
      'company:onboarding.md',
    ]);
  });

  it('runs every query through the search, source run by source run, and keys what it finds by the corpus', (): void => {
    const pages = retrievalPages();
    const calls: Parameters<BlockSearch>[0][] = [];
    const search = emulatedSearch(pages);
    const { scout, searches } = backendScout((args) => {
      calls.push(args);
      return search(args);
    }, SOURCES);
    const found = scout(['签字', 'tile refresh'], pages);
    expect(calls).toEqual([
      { sourceIds: SOURCES.map((source) => source.id), query: '签字', limit: 12 },
      { sourceIds: SOURCES.map((source) => source.id), query: 'tile refresh', limit: 12 },
    ]);
    expect(searches()).toBe(2);
    expect(found.map((block) => block.pageKey)).toContain(
      'company:logistics/runbooks/warehouse-handover-zh.md',
    );
    for (const block of found) expect(block.id).toBe(`${block.pageKey}#${block.index}`);
    expect(() =>
      backendScout(
        () => [{ ...storedRows(pages).blocks[0], sourceId: 'source-unlinked' }],
        SOURCES,
      ).scout(['tile'], pages),
    ).toThrow('source-unlinked');
  });

  it('grades as the emulation does when the search answers as the emulation does', (): void => {
    const pages = retrievalPages();
    const { scout } = backendScout(emulatedSearch(pages), SOURCES);
    const now = new Date('2026-10-09T00:00:00.000Z');
    const emulated = buildRetrievalGrade(COMMIT, now);
    const backend = buildRetrievalGrade(COMMIT, now, { scout });
    expect(backend.recall).toEqual(emulated.recall);
    expect(backend.observations).toEqual(emulated.observations);
  });

  it('records the scout, the bed’s image and the emulated figure beside its own, and renders both on one line', (): void => {
    const pages = retrievalPages();
    const stored = storedRows(pages);
    const { scout, searches } = backendScout(emulatedSearch(pages), SOURCES);
    const grade = buildBackendGrade({
      commit: COMMIT,
      now: new Date('2026-10-09T00:00:00.000Z'),
      scout,
      searches,
      bed: { project: 'day0-w14q2', image: IMAGE },
      proof: ingestionProof(pages, SOURCES, stored.pages, stored.blocks),
      emulated: {
        stamp: '2026-10-07T20-11-36Z',
        recall: { pages: 0.95, blocks: 0.9333333333333333 },
      },
    });
    expect(grade.scout).toBe('backend');
    expect(grade.noModelCalls).toBe(true);
    expect(grade.backend).toMatchObject({
      project: 'day0-w14q2',
      image: IMAGE,
      pagesStored: 17,
      emulated: { stamp: '2026-10-07T20-11-36Z' },
    });
    expect(grade.backend!.searches).toBeGreaterThan(30);
    const markdown = renderRetrievalGrade(grade);
    expect(markdown).toMatch(/^# Retrieval recall, the scout the backend’s search\n/);
    expect(markdown).toContain(
      'Emulated scout (`2026-10-07T20-11-36Z`): pages 95.0%, sections 93.3%; the backend’s search (this grade): pages 95.0%, sections 93.3%.',
    );
    expect(markdown).not.toContain('the scout emulated');
  });
});

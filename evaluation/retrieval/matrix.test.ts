import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoutQueries } from '../../src/docs/select';
import { RETRIEVAL_CASES, retrievalPages } from './fixture';
import {
  RECALL_BAR,
  buildRetrievalGrade,
  gradeCase,
  renderRetrievalGrade,
  scoutedBlocks,
  selectionRequestOf,
  type RetrievalGradeEvidence,
} from './matrix';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** Every tracked grade, with its file. */
function trackedGrades(): { file: URL; grade: RetrievalGradeEvidence }[] {
  return readdirSync(new URL('./', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'pages')
    .map((entry) => new URL(`./${entry.name}/grade.json`, import.meta.url))
    .filter((url) => existsSync(url))
    .map((file) => ({
      file,
      grade: JSON.parse(readFileSync(file, 'utf8')) as RetrievalGradeEvidence,
    }));
}

describe('the retrieval labelled set', (): void => {
  it('labels 30 items over the bed’s fifteen pages, the rehearsal’s own page and a Chinese runbook', (): void => {
    const pages = retrievalPages();
    expect(RETRIEVAL_CASES).toHaveLength(30);
    expect(pages).toHaveLength(17);
    const keys = new Set(pages.map((page) => page.key));
    for (const entry of RETRIEVAL_CASES) {
      for (const key of entry.pages) expect(keys, entry.id).toContain(key);
      for (const section of entry.sections) expect(entry.pages, entry.id).toContain(section.page);
    }
    expect(new Set(RETRIEVAL_CASES.map((entry) => entry.id)).size).toBe(30);
  });

  it('recalls at or above R2’s bar, the prompt and the ranked pick alone: 0.9 at 6 pages and 0.8 at 12 blocks, without a model', (): void => {
    const evidence = buildRetrievalGrade(COMMIT, new Date('2026-10-08T00:00:00.000Z'));
    expect(evidence.noModelCalls).toBe(true);
    expect(evidence.cases).toBe(30);
    expect(evidence.recall.pages).toBeGreaterThanOrEqual(RECALL_BAR.pages);
    expect(evidence.recall.blocks).toBeGreaterThanOrEqual(RECALL_BAR.blocks);
    // The ranked pick alone, on what the pages always included leave to find.
    expect(evidence.rankedRecall.pages).toBeGreaterThanOrEqual(RECALL_BAR.pages);
    expect(evidence.rankedRecall.blocks).toBeGreaterThanOrEqual(RECALL_BAR.blocks);
    expect(evidence.meetsBar).toBe(true);
    for (const row of evidence.observations) expect(row.chars).toBeLessThanOrEqual(24_000);
    expect(renderRetrievalGrade(evidence)).toContain('n=30');
  });

  it('finds the Chinese runbook for a Chinese item through its bigrams alone', (): void => {
    const pages = retrievalPages();
    const zh = RETRIEVAL_CASES.find((entry) => entry.id === 'zh-handover-signature')!;
    expect(gradeCase(zh, pages).pages.recall).toBe(1);
    // The runbook's sentences are runs of eleven or more characters, which the index keeps only
    // as bigrams; a whole-run query term finds nothing.
    expect(scoutedBlocks(['交接清单缺少签字不能交接'], pages)).toEqual([]);
    expect(scoutedBlocks(['签字'], pages).map((block) => block.pageKey)).toEqual([
      'company:logistics/runbooks/warehouse-handover-zh.md',
    ]);
  });

  it('reproduces every tracked grade of the emulated scout from the current selector, so a published recall cannot drift', (): void => {
    const current = buildRetrievalGrade(COMMIT);
    const emulated = trackedGrades().filter(({ grade }) => grade.scout !== 'backend');
    expect(emulated.length).toBeGreaterThanOrEqual(1);
    for (const { file, grade } of emulated) {
      expect({ observations: current.observations, recall: current.recall }, file.pathname).toEqual(
        { observations: grade.observations, recall: grade.recall },
      );
    }
  });

  it('grades with the scout it is given, the emulation by default', (): void => {
    const pages = retrievalPages();
    const entry = RETRIEVAL_CASES[0];
    const asked: string[][] = [];
    gradeCase(entry, pages, (queries) => {
      asked.push([...queries]);
      return [];
    });
    expect(asked).toEqual([scoutQueries(selectionRequestOf(entry), pages)]);
    expect(gradeCase(entry, pages, scoutedBlocks)).toEqual(gradeCase(entry, pages));
    // A scout that finds nothing leaves the pages always included alone: reader 2's probe of the
    // review (W14-R30) read 25.0% of pages from them.
    const alone = buildRetrievalGrade(COMMIT, new Date('2026-10-09T00:00:00.000Z'), {
      scout: () => [],
    });
    expect(alone.recall.pages).toBeCloseTo(0.25, 3);
    expect(alone.observations.every((row) => row.ranked.pages?.recall !== 1)).toBe(true);
  });

  it('lists a grade whose scout was the backend’s search and does not reproduce it, since no test can run the backend', (): void => {
    const backend = trackedGrades().filter(({ grade }) => grade.scout === 'backend');
    expect(backend.length).toBeGreaterThanOrEqual(1);
    for (const { file, grade } of backend) {
      expect(grade.cases, file.pathname).toBe(30);
      expect(grade.backend?.pagesStored, file.pathname).toBe(17);
      expect(grade.backend?.image, file.pathname).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(grade.backend?.searches, file.pathname).toBeGreaterThan(0);
      const emulated = trackedGrades().find(
        ({ file: other }) => other.pathname.split('/').at(-2) === grade.backend?.emulated.stamp,
      );
      expect(emulated?.grade.scout, file.pathname).toBeUndefined();
      expect(grade.backend?.emulated.recall, file.pathname).toEqual(emulated?.grade.recall);
      expect(renderRetrievalGrade(grade), file.pathname).toContain('the backend’s search');
    }
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RETRIEVAL_CASES, retrievalPages } from './fixture';
import {
  RECALL_BAR,
  buildRetrievalGrade,
  gradeCase,
  renderRetrievalGrade,
  scoutedBlocks,
  type RetrievalGradeEvidence,
} from './matrix';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** Every tracked grade. */
function trackedGrades(): URL[] {
  return readdirSync(new URL('./', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'pages')
    .map((entry) => new URL(`./${entry.name}/grade.json`, import.meta.url))
    .filter((url) => existsSync(url));
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

  it('reproduces every tracked grade from the current selector, so a published recall cannot drift', (): void => {
    const current = buildRetrievalGrade(COMMIT);
    const files = trackedGrades();
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const file of files) {
      const published = JSON.parse(readFileSync(file, 'utf8')) as RetrievalGradeEvidence;
      expect({ observations: current.observations, recall: current.recall }, file.pathname).toEqual(
        { observations: published.observations, recall: published.recall },
      );
    }
  });
});

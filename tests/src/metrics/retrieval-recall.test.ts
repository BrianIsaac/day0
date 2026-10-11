import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RETRIEVAL_RECALL } from '../../../src/metrics/retrieval-recall';
import { retrievalPages } from '../../../evaluation/retrieval/fixture';

interface TrackedGrade {
  generatedAt: string;
  commit: string;
  cases: number;
  recall: { pages: number; blocks: number };
  scout?: 'backend';
  backend?: { pagesStored: number };
}

/** Every tracked grade of the labelled set, oldest first by its stamp. */
function trackedGrades(): TrackedGrade[] {
  const directory = new URL('../../../evaluation/retrieval/', import.meta.url);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map(
      (stamp) =>
        JSON.parse(readFileSync(new URL(`${stamp}/grade.json`, directory), 'utf8')) as TrackedGrade,
    );
}

/**
 * The newest tracked grade whose scout was a bed's own search (`scout: "backend"`): the search
 * the product runs, so the figure a manager reads describes it. The emulated grades stay as the
 * offline test that reproduces the selector's recall; they are not the figure.
 */
function newestGrade(): TrackedGrade {
  const grades = trackedGrades().filter((grade) => grade.scout === 'backend');
  return grades[grades.length - 1];
}

describe('RETRIEVAL_RECALL', (): void => {
  it('is the newest grade taken on a bed’s own search, with its date, so the figure describes the search the product runs and cannot quote an older one', (): void => {
    const grade = newestGrade();
    expect(RETRIEVAL_RECALL).toEqual({
      pages: grade.recall.pages,
      blocks: grade.recall.blocks,
      cases: grade.cases,
      corpusPages: grade.backend!.pagesStored,
      gradedAt: grade.generatedAt,
      commit: grade.commit,
    });
  });

  it('is of the labelled set as it stands, graded after the newest emulated grade', (): void => {
    const emulated = trackedGrades().filter((grade) => grade.scout !== 'backend');
    const newestEmulated = emulated[emulated.length - 1];
    expect(RETRIEVAL_RECALL.cases).toBe(newestEmulated.cases);
    expect(RETRIEVAL_RECALL.corpusPages).toBe(retrievalPages().length);
    expect(RETRIEVAL_RECALL.gradedAt > newestEmulated.generatedAt).toBe(true);
  });
});

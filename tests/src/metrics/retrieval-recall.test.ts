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
}

/**
 * The newest tracked grade of the labelled set that the selector's test reproduces, by its stamp:
 * a grade whose scout was a bed's own search (`scout: "backend"`) is a measurement beside it, read
 * in `evaluation/README.md`, and not the figure.
 */
function newestGrade(): TrackedGrade {
  const directory = new URL('../../../evaluation/retrieval/', import.meta.url);
  const grades = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map(
      (stamp) =>
        JSON.parse(readFileSync(new URL(`${stamp}/grade.json`, directory), 'utf8')) as TrackedGrade,
    )
    .filter((grade) => grade.scout !== 'backend');
  return grades[grades.length - 1];
}

describe('RETRIEVAL_RECALL', (): void => {
  it('is the labelled set’s newest tracked grade, so the figure cannot quote an older one', (): void => {
    const grade = newestGrade();
    expect(RETRIEVAL_RECALL).toEqual({
      pages: grade.recall.pages,
      blocks: grade.recall.blocks,
      cases: grade.cases,
      corpusPages: retrievalPages().length,
      gradedAt: grade.generatedAt,
      commit: grade.commit,
    });
  });
});

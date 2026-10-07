import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RETRIEVAL_RECALL } from '../../../src/metrics/retrieval-recall';

/** The newest tracked grade of the labelled set, by its stamp. */
function newestGrade(): {
  generatedAt: string;
  commit: string;
  cases: number;
  recall: { pages: number; blocks: number };
} {
  const directory = new URL('../../../evaluation/retrieval/', import.meta.url);
  const stamps = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return JSON.parse(
    readFileSync(new URL(`${stamps[stamps.length - 1]}/grade.json`, directory), 'utf8'),
  ) as ReturnType<typeof newestGrade>;
}

describe('RETRIEVAL_RECALL', (): void => {
  it('is the labelled set’s newest tracked grade, so the figure cannot quote an older one', (): void => {
    const grade = newestGrade();
    expect(RETRIEVAL_RECALL).toEqual({
      pages: grade.recall.pages,
      blocks: grade.recall.blocks,
      cases: grade.cases,
      gradedAt: grade.generatedAt,
      commit: grade.commit,
    });
  });
});

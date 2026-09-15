import { describe, expect, it } from 'vitest';
import {
  CORPUS_SLOTS,
  loadRedactionCorpus,
  occurrences,
  scoreRedaction,
  type CorpusCase,
} from '../../fixtures/redaction-corpus';

describe('the labelled redaction corpus', (): void => {
  const cases = loadRedactionCorpus();

  it('carries unique ids and resolves every slot', (): void => {
    const ids = cases.map((entry: CorpusCase): string => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of cases) {
      for (const name of Object.keys(CORPUS_SLOTS)) {
        expect(entry.text).not.toContain(`{{${name}}}`);
      }
      expect(entry.text).toMatch(/\S/);
    }
  });

  it('labels only values that occur in the text, and every secret at least once', (): void => {
    for (const entry of cases) {
      for (const span of entry.spans) {
        expect(occurrences(entry.text, span.value), `${entry.id}: ${span.label}`).toBeGreaterThan(0);
      }
    }
    expect(cases.filter((entry: CorpusCase): boolean => entry.spans.some((span) => span.kind === 'secret')).length)
      .toBeGreaterThan(30);
    expect(cases.filter((entry: CorpusCase): boolean => entry.language !== 'en').length).toBeGreaterThan(3);
  });

  it('keeps token-shaped values out of the committed file', (): void => {
    const committed = JSON.stringify(cases.map((entry: CorpusCase): string => entry.id));
    for (const value of Object.values(CORPUS_SLOTS)) expect(committed).not.toContain(value);
  });

  it('scores by value survival', (): void => {
    const identity = scoreRedaction(cases, (entry: CorpusCase): string => entry.text);
    expect(identity.truePositives).toBe(0);
    expect(identity.falsePositives).toBe(0);
    expect(identity.recall).toBe(0);
    const blank = scoreRedaction(cases, (): string => '');
    expect(blank.falseNegatives).toBe(0);
    expect(blank.recall).toBe(1);
    expect(blank.falsePositives).toBeGreaterThan(150);
  });
});

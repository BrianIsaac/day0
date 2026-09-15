import { describe, expect, it } from 'vitest';
import { redactText, type RedactedText } from '../../../src/redaction/redact';
import { knownValues, loadRedactionCorpus, occurrences, type CorpusCase } from '../../fixtures/redaction-corpus';
import { RecordedSpanModel } from '../../fixtures/redaction-double';

/**
 * The cases the review named one by one. The corpus scorer proves the
 * aggregate; these prove each named span, so a regression on one of them
 * fails by name rather than inside a percentage.
 */
const cases = loadRedactionCorpus();
const model = new RecordedSpanModel();

async function redactCase(id: string): Promise<{ entry: CorpusCase; out: RedactedText }> {
  const entry = cases.find((candidate: CorpusCase): boolean => candidate.id === id);
  if (!entry) throw new Error(`no corpus case ${id}`);
  const out = await redactText(entry.text, entry.context, { model, known: knownValues(entry), onUnavailable: 'throw' });
  return { entry, out };
}

function survives(entry: CorpusCase, out: RedactedText, value: string): boolean {
  return occurrences(out.text, value) === occurrences(entry.text, value);
}

describe('the secret misses the review named', (): void => {
  it('docs-local-refresh-runbook: the tile password beside its own stored marker', async (): Promise<void> => {
    const { entry, out } = await redactCase('docs-local-refresh-runbook');
    expect(out.text).not.toContain('pipeline-tile-local');
    expect(out.text).toContain('(username `revops`)');
    for (const value of ['<credential: looker pipeline tile dashboard login, stored>', '{{secret}}', 'REVOPS-7', '74%']) {
      expect(survives(entry, out, value), value).toBe(true);
    }
  });

  it('review-miss-password-in-parenthetical: the password half of a user / password table cell', async (): Promise<void> => {
    const { entry, out } = await redactCase('review-miss-password-in-parenthetical');
    expect(out.text).not.toContain('hunter2');
    expect(out.text).toContain('| revops / <redacted> |');
    expect(survives(entry, out, 'http://looker-tile:8080/')).toBe(true);
  });

  it('password-keyword-variants: pwd, passcode, PIN and a login pair', async (): Promise<void> => {
    const { out } = await redactCase('password-keyword-variants');
    for (const value of ['Winter2026!', '482913', '0419', 'Sunny-Day-42']) {
      expect(out.text, value).not.toContain(value);
    }
    expect(out.text).toContain('login: revops / <redacted>');
    expect(out.text).toContain('PIN for the shared phone: <redacted>');
  });
});

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

describe('the damaged working spans the review named', (): void => {
  it('review-miss-midline-password-prose: the username stays, the password goes', async (): Promise<void> => {
    const { out } = await redactCase('review-miss-midline-password-prose');
    expect(out.text).toContain('The tile login is revops and the password is <redacted>;');
    expect(out.text).not.toContain('hunter2');
  });

  it('review-miss-short-token-values: the sk-test placeholder stays, the short values go', async (): Promise<void> => {
    const { out } = await redactCase('review-miss-short-token-values');
    expect(out.text).toContain('- api key: sk-test');
    expect(out.text).not.toContain('abc123');
    expect(out.text).not.toContain('q7Mz2Kv9');
  });

  it('record-linear-issue: the branch name and the whole record pass unchanged', async (): Promise<void> => {
    const { entry, out } = await redactCase('record-linear-issue');
    expect(out.text).toContain('"branchName":"revops-7-refresh-the-looker-pipeline-tile"');
    expect(out.text).toBe(entry.text);
  });

  it('pii-ip-and-hostnames: the bastion hostname and both addresses stay', async (): Promise<void> => {
    const { entry, out } = await redactCase('pii-ip-and-hostnames');
    for (const value of ['bastion.acme.internal', '10.20.30.40:5432', '203.0.113.7']) {
      expect(survives(entry, out, value), value).toBe(true);
    }
  });

  it('docs-local-refresh-runbook: the Username field name of the form is not a credential', async (): Promise<void> => {
    const { out } = await redactCase('docs-local-refresh-runbook');
    expect(out.text).toContain('{\\"name\\":\\"Username\\",\\"value\\":\\"revops\\"}');
  });
});

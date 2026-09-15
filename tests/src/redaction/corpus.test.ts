import { describe, expect, it } from 'vitest';
import { dispositionFor, MODEL_THRESHOLD, REQUESTED_LABELS, type EntityKind, type RedactionContext } from '../../../src/redaction/policy';
import { redactText, type RedactedText } from '../../../src/redaction/redact';
import {
  CORPUS_SLOTS,
  knownValues,
  loadRedactionCorpus,
  occurrences,
  scoreRedaction,
  type CorpusCase,
  type CorpusSpan,
} from '../../fixtures/redaction-corpus';
import { loadSpanRecording, RecordedSpanModel } from '../../fixtures/redaction-double';

/** Corpus PII labels as the policy's kinds. */
const PII_KINDS: Readonly<Record<string, EntityKind>> = {
  person: 'person',
  username: 'username',
  email: 'email',
  phone: 'phone',
  address: 'address',
  'id-number': 'id-number',
  'date-of-birth': 'date-of-birth',
  ip: 'ip',
};

/**
 * What the recorded model still misses and damages, listed so that a change
 * is a change to this list and a reader sees exactly what is not caught.
 */
const EXPECTED_MISSES: string[] = [
  // The tile password inside the sentence that also quotes its own marker.
  'docs-local-refresh-runbook:password',
  // `revops / hunter2` in a table cell with no label word at all.
  'review-miss-password-in-parenthetical:password',
  // A six-digit passcode, a four-digit PIN and a hyphenated passphrase after their labels.
  'password-keyword-variants:password',
  'password-keyword-variants:password',
  'password-keyword-variants:password',
  // A Singapore NRIC in an HR note.
  'pii-personal-record:id-number',
];
const EXPECTED_DAMAGE: string[] = [
  // The username beside a mid-sentence password, read as a credential.
  'review-miss-midline-password-prose:username:revops',
  // A test placeholder shaped like a key.
  'review-miss-short-token-values:placeholder:sk-test',
  // A Linear branch name, read as an id number.
  'record-linear-issue:identifier:revops-7-refresh-the-looker-pipeline-tile',
  // A bastion hostname beside its address, read as an address.
  'pii-ip-and-hostnames:url:bastion.acme.internal',
];

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

describe('the redaction layer over the recorded model', (): void => {
  const cases = loadRedactionCorpus();
  const recording = loadSpanRecording();
  const model = new RecordedSpanModel(recording);
  const contextOf = (entry: CorpusCase): RedactionContext => entry.context;
  const redactAll = async (): Promise<Map<string, RedactedText>> => {
    const out = new Map<string, RedactedText>();
    for (const entry of cases) {
      const known = knownValues(entry);
      out.set(entry.id, await redactText(entry.text, contextOf(entry), { model, known, onUnavailable: 'throw' }));
    }
    return out;
  };
  const mustRedact = (span: CorpusSpan, entry: CorpusCase): boolean =>
    span.kind === 'pii' && dispositionFor(entry.context, PII_KINDS[span.label] ?? 'person') === 'redact';

  it('was recorded from the deployed model with the labels the policy asks for', (): void => {
    expect(recording.model).toBe('urchade/gliner_multi_pii-v1');
    expect(recording.labels).toEqual([...REQUESTED_LABELS]);
    expect(recording.threshold).toBe(MODEL_THRESHOLD);
    for (const entry of cases) expect(recording.cases[entry.id], entry.id).toBeDefined();
  });

  it('meets the secret-job thresholds: precision 90 and recall 85, against 97.6 and 63.1 for the lexical pipeline', async (): Promise<void> => {
    // The thresholds are the measured pipeline less a small margin (93.7 and
    // 89.4 at recording), so a model, label or guard change that costs more
    // than four points of either fails here rather than in a ledger.
    const outputs = await redactAll();
    const score = scoreRedaction(cases, (entry: CorpusCase): string => outputs.get(entry.id)?.text ?? entry.text, mustRedact);
    expect(score.misses.map((miss) => `${miss.id}:${miss.label}`)).toEqual(EXPECTED_MISSES);
    console.info(`corpus secret job: TP ${score.truePositives} FN ${score.falseNegatives} FP ${score.falsePositives} P ${(score.precision * 100).toFixed(1)} R ${(score.recall * 100).toFixed(1)}`);
    expect(score.precision * 100).toBeGreaterThanOrEqual(90);
    expect(score.recall * 100).toBeGreaterThanOrEqual(85);
  });

  it('meets the personal-data threshold: recall 90 on the labels the policy redacts', async (): Promise<void> => {
    const targets = cases.map(
      (entry: CorpusCase): CorpusCase => ({
        ...entry,
        context: 'outcome',
        spans: entry.spans.filter((span: CorpusSpan): boolean => span.kind === 'pii' && ['email', 'phone', 'address', 'id-number', 'date-of-birth'].includes(span.label)),
      }),
    ).filter((entry: CorpusCase): boolean => entry.spans.length > 0);
    let found = 0;
    let total = 0;
    for (const entry of targets) {
      const result = await redactText(entry.text, 'outcome', { model, onUnavailable: 'throw' });
      for (const span of entry.spans) {
        total += 1;
        if (!result.text.includes(span.value)) found += 1;
      }
    }
    expect(total).toBeGreaterThan(15);
    console.info(`corpus personal-data job: ${found}/${total} = ${((found / total) * 100).toFixed(1)}`);
    expect((found / total) * 100).toBeGreaterThanOrEqual(90);
  });

  it('passes working material through in every context', async (): Promise<void> => {
    const outputs = await redactAll();
    const damaged: string[] = [];
    for (const entry of cases) {
      const output = outputs.get(entry.id)?.text ?? '';
      for (const span of entry.spans) {
        if (span.kind === 'secret' || mustRedact(span, entry)) continue;
        if (occurrences(output, span.value) < occurrences(entry.text, span.value)) damaged.push(`${entry.id}:${span.label}:${span.value}`);
      }
    }
    expect(damaged).toEqual(EXPECTED_DAMAGE);
    for (const must of ['Priya', 'Aman', '#revops', 'REVOPS-7', '74%', 'Last updated by revops at 2026-09-03 07:14 UTC']) {
      expect(outputs.get('working-audit-and-figures-prompt')?.text ?? '').toContain(must);
    }
    expect(outputs.get('record-linear-issue')?.text).toContain('Ticket key: REVOPS-7');
    expect(outputs.get('record-linear-issue')?.text).toContain('Token budget: none');
    expect(outputs.get('mock-team-overview')?.text).toBe(cases.find((entry) => entry.id === 'mock-team-overview')?.text);
  });

  it('redacts the review misses: mid-line and short passwords, and the Chinese cases', async (): Promise<void> => {
    const outputs = await redactAll();
    for (const id of [
      'review-miss-midline-password',
      'review-miss-midline-password-prose',
      'review-miss-short-passwords',
      'review-miss-short-token-values',
      'record-linear-issue-escaped-midline',
      'record-linear-issue-with-password',
      'zh-runbook-password',
      'zh-midline-password',
      'zh-mixed-ticket-record',
    ]) {
      const entry = cases.find((candidate) => candidate.id === id);
      const output = outputs.get(id)?.text ?? '';
      for (const span of entry?.spans ?? []) {
        if (span.kind === 'secret') expect(output, `${id}: ${span.label}`).not.toContain(span.value);
      }
    }
    expect(outputs.get('zh-contacts')?.text).toContain('张伟');
    expect(outputs.get('zh-contacts')?.text).not.toContain('138-0013-8000');
    expect(outputs.get('zh-contacts')?.text).not.toContain('110101199003074512');
  });
});

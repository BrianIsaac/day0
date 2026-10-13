import { describe, expect, it } from 'vitest';
import { credentialMarker } from '../../../src/docs/redaction';
import { sameButForRedaction } from '../../../src/docs/redaction-difference';
import { personalDataMarker } from '../../../src/redaction/redact';

describe('sameButForRedaction', (): void => {
  const RUNBOOK = '# Paging\n\nPage the on-call with code SEV1 before you post.\n\nThen post.';

  it('reads two texts that differ only where the redaction took a value out as the same text (W15-R42)', (): void => {
    // The wave 15 review's R6: `SEV1` stored as it was, and a credential marker after the upgrade.
    const marked = RUNBOOK.replace('SEV1', credentialMarker('pager credential'));
    expect(sameButForRedaction(RUNBOOK, marked)).toBe(true);
    expect(sameButForRedaction(marked, RUNBOOK)).toBe(true);
    // A marker under another label, and personal data taken out, are the redaction's too.
    expect(
      sameButForRedaction(marked, RUNBOOK.replace('SEV1', credentialMarker('pager code'))),
    ).toBe(true);
    expect(
      sameButForRedaction(
        'Ask Dana Whitfield, then call her.',
        `Ask ${personalDataMarker('person')}, then call her.`,
      ),
    ).toBe(true);
    expect(sameButForRedaction(RUNBOOK, RUNBOOK)).toBe(true);
  });

  it('reads a text whose words changed as changed, with or without a marker beside the change', (): void => {
    const marked = RUNBOOK.replace('SEV1', credentialMarker('pager credential'));
    expect(sameButForRedaction(RUNBOOK, RUNBOOK.replace('Then post.', 'Then post twice.'))).toBe(
      false,
    );
    expect(sameButForRedaction(RUNBOOK, marked.replace('before you post', 'after you post'))).toBe(
      false,
    );
    expect(sameButForRedaction(RUNBOOK, marked.replace('Then post.', 'Then wait.'))).toBe(false);
    // A line added or removed is a change, whatever it holds.
    expect(sameButForRedaction(RUNBOOK, `${marked}\n\nAnd log it.`)).toBe(false);
  });

  it('reads a marker where the other text holds nothing, or far more than a value, as a change', (): void => {
    expect(
      sameButForRedaction('Press refresh twice.', `Press refresh twice.${credentialMarker('x')}`),
    ).toBe(false);
    const long = 'word '.repeat(80);
    expect(
      sameButForRedaction(`Call ${long}now.`, `Call ${personalDataMarker('person')}now.`),
    ).toBe(false);
  });

  it('reads a line too long, or too full of markers, to compare as a change rather than guess', (): void => {
    const filler = 'x'.repeat(5_000);
    expect(
      sameButForRedaction(`${filler} SEV1`, `${filler} ${credentialMarker('pager credential')}`),
    ).toBe(false);
    const values = Array.from({ length: 20 }, (_, index) => `v${index}`);
    expect(
      sameButForRedaction(
        values.join(' and '),
        values.map(() => credentialMarker('x')).join(' and '),
      ),
    ).toBe(false);
  });
});

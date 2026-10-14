import { describe, expect, it } from 'vitest';
import { credentialMarker } from '../../../src/docs/redaction';
import { REDACTION_WALK_STEPS, sameButForRedaction } from '../../../src/docs/redaction-difference';
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

  it('answers a line built to make a pattern backtrack at once, as a change (the second pass)', (): void => {
    // The reviewer's input: sixteen markers a letter apart against fifteen hundred of that
    // letter and another ending. A pattern of sixteen bounded wildcards tries every way to place
    // them before it gives up, which no sync would outlive; a page's author can write both lines.
    const marker = personalDataMarker('person');
    const stored = `${marker}${`b${marker}`.repeat(15)}Z`;
    const incoming = `${'b'.repeat(1_500)}Y`;
    const started = performance.now();
    expect(sameButForRedaction(stored, incoming)).toBe(false);
    expect(sameButForRedaction(incoming, stored)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
    // And the same shape where the two do line up is still read as the redaction's.
    const values = Array.from({ length: 16 }, (_, index) => `name${index}`);
    expect(
      sameButForRedaction(`${values.join('b')}Z`, `${values.map(() => marker).join('b')}Z`),
    ).toBe(true);
  }, 20_000);

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

  describe('a page of hostile lines (W17-R15)', (): void => {
    /**
     * The review's probe, a page of fifty: each stored line sixteen markers a letter apart, and
     * its text fifteen hundred of that letter, which the markers can stand for. Each line lines
     * up only once every way to place its markers has been walked, so the walk was bounded a line
     * and not a page.
     */
    const marker = personalDataMarker('person');
    const stored = Array.from({ length: 50 }, () => `${marker}${`b${marker}`.repeat(15)}Z`).join(
      '\n',
    );
    const incoming = Array.from({ length: 50 }, () => `${'b'.repeat(1_500)}Z`).join('\n');

    /**
     * The places a call compares, counted: each step of the walk tests one. Counted by hand, not
     * by a spy, which keeps every call's arguments and ran out of memory at the old walk's
     * seventy million.
     */
    const comparisons = (judge: () => void): number => {
      const { startsWith, endsWith } = String.prototype;
      let count = 0;
      String.prototype.startsWith = function (this: string, ...args) {
        count += 1;
        return startsWith.apply(this, args);
      };
      String.prototype.endsWith = function (this: string, ...args) {
        count += 1;
        return endsWith.apply(this, args);
      };
      try {
        judge();
      } finally {
        String.prototype.startsWith = startsWith;
        String.prototype.endsWith = endsWith;
      }
      return count;
    };

    it('judges the page changed within one budget of steps for the whole call', (): void => {
      const judged: boolean[] = [];
      const counted = comparisons(() => {
        judged.push(sameButForRedaction(stored, incoming), sameButForRedaction(incoming, stored));
      });
      expect(judged).toEqual([false, false]);
      // Each call within its budget, with a line's slack for the tests outside the walk.
      expect(counted).toBeLessThan(2 * (REDACTION_WALK_STEPS + 1_000));
    });

    it('still reads an ordinary page whose values were taken out as the same text', (): void => {
      const lines = Array.from(
        { length: 400 },
        (_, index) => `Page the on-call ${index} with code SEV${index} before you post.`,
      );
      const marked = lines.map((line, index) =>
        line.replace(`SEV${index}`, credentialMarker('pager credential')),
      );
      expect(sameButForRedaction(lines.join('\n'), marked.join('\n'))).toBe(true);
    });
  });
});

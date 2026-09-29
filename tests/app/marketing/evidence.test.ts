import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EVIDENCE } from '../../../app/marketing/evidence';

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

/** The rows of the README's "The numbers this run ended on" table, as label and value. */
function readmeRows(): { label: string; value: string }[] {
  const section = README.split('### The numbers this run ended on')[1] ?? '';
  const table = section.split('\n\n')[1] ?? '';
  return table
    .split('\n')
    .slice(2)
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .map(([, label = '', value = '']) => ({ label, value }));
}

/** The README writes `41/41` and lower-case labels; the card writes `41 of 41` in sentence case. */
function asCard(row: { label: string; value: string }): { label: string; value: string } {
  const label = row.label.replace(
    'actions blocked after revocation',
    'actions blocked after a revocation',
  );
  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    value: row.value.replace(/(\d+)\/(\d+)\)/, '$1 of $2)'),
  };
}

describe('the landing evidence', () => {
  it('states the same five figures as the README table it is dated from', () => {
    expect(readmeRows()).toHaveLength(5);
    expect(EVIDENCE.rows).toEqual(readmeRows().map(asCard));
  });

  it('dates the run and says it is one run, not a rate', () => {
    expect(README).toContain('It ran on 3 September 2026');
    expect(EVIDENCE.runOn).toBe('2026-09-03');
    expect(EVIDENCE.lede).toContain('3 September 2026');
    expect(EVIDENCE.lede).toContain('Single run, counts not rates.');
  });

  it('carries the card footer the README quotes', () => {
    expect(README).toContain(
      'The footer of the same card reads 8 decisions requested, 0 partial, 31 actions automatic, 11 held, 1 refused. The exported ledger holds 197 events and 42 ledger rows, and contains no credential value.',
    );
    expect(EVIDENCE.footnote).toContain(
      '8 decisions requested, 0 partial, 31 actions automatic, 11 held, 1 refused.',
    );
  });
});

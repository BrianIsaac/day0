/**
 * The figures one real-mode run ended on, as the README's "The numbers this run ended on"
 * table states them. The README's prose is the only record of these figures in the tree (no
 * export or card file for the 3 September run is committed), so they are held here as a typed
 * constant with the run's date, and `tests/app/marketing/evidence.test.ts` fails the moment the
 * README's table and this constant disagree.
 */

/** One measured row: the manager-facing label and the value as the card printed it. */
export interface EvidenceRow {
  readonly label: string;
  readonly value: string;
}

/** The run the figures come from and what they are. */
export const EVIDENCE = {
  /** The day of the run, as `YYYY-MM-DD`. */
  runOn: '2026-09-03',
  heading: 'The numbers one run ended on',
  lede: 'A real-mode run on 3 September 2026, from the README. Single run, counts not rates. Day0 has no users and no production deployment.',
  rows: [
    { label: 'Time to first approved charter', value: '5 min 8 s' },
    { label: 'Human decisions (approved / rejected)', value: '7 / 1' },
    { label: 'Median decision latency', value: '2 min 7 s' },
    { label: 'Actions blocked after a revocation', value: '1' },
    { label: 'Audit-trail completeness', value: '100% (41 of 41)' },
  ],
  footnote:
    '8 decisions requested, 0 partial, 31 actions automatic, 11 held, 1 refused. The exported ledger holds 197 events and 42 ledger rows and contains no credential value.',
  walkthroughLink: 'The walkthrough of that run',
  comparisonLink: 'The controlled comparison',
  comparisonHref: 'https://github.com/BrianIsaac/day0/blob/main/evaluation/README.md',
} as const satisfies {
  runOn: string;
  heading: string;
  lede: string;
  rows: readonly EvidenceRow[];
  footnote: string;
  walkthroughLink: string;
  comparisonLink: string;
  comparisonHref: string;
};

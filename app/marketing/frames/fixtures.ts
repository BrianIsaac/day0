/**
 * What the four how-it-works frames show, copied from recorded runs the tree already carries so
 * every frame is true by data. No single committed recording covers all four moments, so each
 * frame names its own source; `tests/app/marketing/frames/fixtures.test.ts` reads every source
 * and fails if a string here stops matching it.
 */

/** One synced page as the documentation list shows it. */
export interface DocumentationRow {
  readonly title: string;
  readonly source: 'Folder' | 'Notion';
}

/**
 * The company bed's documentation (`bed/company/`, copied byte for byte under
 * `tests/fixtures/company-bed/`): one folder source of 13 pages and two Notion pages, titled
 * by each page's first heading as the readers title them.
 */
export const DOCUMENTATION = {
  sources: 2,
  pages: 15,
  rows: [
    { title: 'Revenue operations handbook', source: 'Folder' },
    { title: 'Logistics desk handbook', source: 'Folder' },
    { title: 'Slack automation policy', source: 'Notion' },
  ],
} as const satisfies {
  sources: number;
  pages: number;
  rows: readonly DocumentationRow[];
};

/**
 * The opening exchange of the Day-1 one-to-one of the 14 September run-through
 * (`tests/fixtures/day-one-transcript-2026-09-14.ts`, reconstructed there from the run's
 * record; the only one-to-one transcript the tree holds).
 */
export const ONE_TO_ONE = {
  topics: 7,
  question: 'Why did the team hire me, and what is the biggest pain right now?',
  answer:
    'Small RevOps team drowning in tier-2 asks during the Q3 close. Need you to own routine revenue operations work so the analysts can close.',
} as const;

/** One charter rule on the review card: what it rests on, what it became, and the decision. */
export interface CharterRule {
  readonly quote: string;
  /** True when the quote is the manager's own sentence; false for a rule Day0 derived. */
  readonly saidByManager: boolean;
  readonly kind: string;
  readonly clause: string;
  readonly decision: 'confirmed' | 'struck';
}

/**
 * The 15 September draft on which the manager struck a derived rule
 * (`tests/fixtures/charter-strike-refusal-2026-09-15.ts`, as the run recorded it): the
 * system boundary the manager stated, kept, and the derived rule, struck. The kind labels are
 * the dashboard's own.
 */
export const CHARTER = {
  version: '0.0',
  rules: [
    {
      quote:
        "there's also Northstar CRM, but you won't have access to that, so anything that needs it comes to me.",
      saidByManager: true,
      kind: 'where I may act',
      clause: 'Access or execute work in Northstar CRM.',
      decision: 'confirmed',
    },
    {
      quote: 'Take ownership of Northstar CRM-dependent work that Sam must handle.',
      saidByManager: false,
      kind: 'what work qualifies',
      clause: 'ownership',
      decision: 'struck',
    },
  ],
} as const satisfies { version: string; rules: readonly CharterRule[] };

/**
 * The exception comment the 19 September full run held for the manager on LOG-2
 * (`tests/fixtures/work/full-run-2026-09-19-log-2.ts`, every string the run's own), with
 * autonomous actions off.
 */
export const HELD_WRITE = {
  item: 'Exception: SH-4460 delivered one day late, ETA confirmed',
  target: 'Comment on LOG-2 in Linear',
  body: 'Exception: SH-4460, delivered one day late, delivery address (not stated on the ticket)\nCarrier: Meridian Freight; revised ETA: 26 September\nCustomer notice (Delay, revised ETA confirmed):\nYour shipment SH-4460 is delayed. Meridian Freight has confirmed a revised delivery date of 26 September. We are sorry for the delay.\nNext update: none',
} as const;

/**
 * Which employees the company's figures on the home cover (wave 17, 17-F; RM33 (a)): the read a
 * card subscribes to is bounded, so past its bound every employee is read by pages, and the card
 * says which it is drawing meanwhile (section 7's drafts, RM24).
 */
export type CompanyCoverage =
  /** The subscribed read covers every employee: nothing to say. */
  | { readonly kind: 'all' }
  /** Every employee is being read by pages; the figures drawn are of the most recent. */
  | { readonly kind: 'reading'; readonly read: number; readonly of: number }
  /** Every employee was read by pages: the figures are the whole company's. */
  | { readonly kind: 'every'; readonly employees: number }
  /** The read by pages failed: the figures are of the most recent employees only. */
  | { readonly kind: 'recent'; readonly read: number; readonly of: number }
  /**
   * The read by pages failed and its retries are spent (W17-R28): the figures are of the most
   * recent employees until a change reads every one again, and the card says so.
   */
  | {
      readonly kind: 'stopped';
      readonly read: number;
      readonly of: number;
      readonly tries: number;
    };

/**
 * The line over the figures: "{n} employees" once every one is read, "{k} of {n} read" while the
 * pages load, "{k} of {n} read: the rest could not be read" once a failed read has stopped trying
 * (a draft, wave 18), and nothing where the subscribed read covers the company.
 *
 * @param coverage - Which employees the figures cover.
 */
export function coverageLine(coverage: CompanyCoverage): string | undefined {
  switch (coverage.kind) {
    case 'all':
    case 'recent':
      return undefined;
    case 'reading':
      return `${coverage.read.toLocaleString('en-GB')} of ${coverage.of.toLocaleString('en-GB')} read`;
    case 'every':
      return `${coverage.employees.toLocaleString('en-GB')} employees`;
    case 'stopped':
      return `${coverage.read.toLocaleString('en-GB')} of ${coverage.of.toLocaleString('en-GB')} read: the rest could not be read`;
    default: {
      const unknown: never = coverage;
      throw new Error(`unhandled coverage ${String(unknown)}`);
    }
  }
}

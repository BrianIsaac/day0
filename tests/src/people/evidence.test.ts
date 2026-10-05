import { describe, expect, it } from 'vitest';
import {
  groundedQuote,
  managerQuoteFor,
  mentions,
  QUOTE_LIMIT,
} from '../../../src/people/evidence';

describe('people evidence', (): void => {
  it('finds a name as a whole word in any case, never inside another word', (): void => {
    expect(mentions('Ask priya shah about pipeline.', 'Priya Shah')).toBe(true);
    expect(mentions('Ask Priyanka about pipeline.', 'Priya')).toBe(false);
    expect(mentions('Ask anyone.', '--')).toBe(false);
  });

  it("quotes the sentence of the manager's that names the person, never the employee's", (): void => {
    const turns = [
      { speaker: 'employee', text: 'Who do you work with? Priya, perhaps?' },
      {
        speaker: 'manager',
        text: 'We run the close together. Priya for segment and pipeline. Aman too.',
      },
    ] as const;
    expect(managerQuoteFor('Priya', turns)).toBe('Priya for segment and pipeline.');
  });

  it('quotes nothing when no manager turn names the person', (): void => {
    expect(managerQuoteFor('Sara', [{ speaker: 'manager', text: 'Priya does pipeline.' }])).toBe(
      undefined,
    );
  });

  it('keeps a long sentence to the quote limit, cut between words', (): void => {
    const long = `Priya ${'handles the pipeline and '.repeat(30)}more.`;
    const quote = managerQuoteFor('Priya', [{ speaker: 'manager', text: long }]);
    expect(quote?.length).toBeLessThanOrEqual(QUOTE_LIMIT);
    expect(quote?.startsWith('Priya handles')).toBe(true);
    expect(quote?.endsWith('...')).toBe(true);
  });

  it("grounds a model's quote only where the page says it, whitespace and case aside, and it names the person", (): void => {
    const page = '| NetLedger | the ledger | Dana Okafor\n(dana@kestrel.test) |';
    expect(
      groundedQuote(
        'NetLedger | the ledger | Dana Okafor (dana@kestrel.test)',
        page,
        'Dana Okafor',
      ),
    ).toBe('NetLedger | the ledger | Dana Okafor (dana@kestrel.test)');
    expect(groundedQuote('netledger | THE ledger | dana okafor', page, 'Dana Okafor')).toBe(
      'netledger | THE ledger | dana okafor',
    );
  });

  it('refuses a quote the page does not hold, or one that does not name the person', (): void => {
    const page = 'Dana Okafor owns NetLedger access.';
    expect(groundedQuote('Dana Okafor owns Linear access.', page, 'Dana Okafor')).toBe(undefined);
    expect(groundedQuote('owns NetLedger access', page, 'Dana Okafor')).toBe(undefined);
    expect(groundedQuote('   ', page, 'Dana Okafor')).toBe(undefined);
  });
});

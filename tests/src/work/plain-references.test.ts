import { describe, expect, it } from 'vitest';
import { inPlainNames, refsInWords } from '../../../src/work/plain-references';

/** Every way a hosted office reference reads as an internal name (W19-7). */
const INTERNAL = /docs-fixture\/|channel:\/\/|mock-spreadsheet:\/\/|ticket:\/\/|twitter:\/\//;

describe('inPlainNames: the hosted office references as records (W19-7, the v0.19.0 walk)', (): void => {
  it.each([
    [
      "Nell's DM (`A-Nell-docs-full.txt`)",
      'Prep for the Monday queue run is done: I have read the IT access and passwords page (docs-fixture/it-access).',
      'Prep for the Monday queue run is done: I have read the IT access and passwords page.',
    ],
    [
      "Pip's P1 plan (`A-Pip-tB-full.txt`)",
      'Read the customer billing replies doc and the Slack thread channel://office-asks#thread-double-charge to confirm the documented wording for duplicate charge replies.',
      'Read the customer billing replies doc and the Slack thread the double charge thread in #office-asks to confirm the documented wording for duplicate charge replies.',
    ],
    [
      "Pip's docs plan (`A-Pip-docs-full.txt`)",
      'Read the customer billing replies doc at docs-fixture/billing-replies and extract the first-reply guidance for duplicate charges.',
      'Read the customer billing replies doc at the billing replies page and extract the first-reply guidance for duplicate charges.',
    ],
    [
      "Pip's docs DM (`A-Pip-docs-full.txt`)",
      'Hi, draft reply for Hana\'s ask (docs-fixture/billing-replies, "Before I send anything to Northwind").',
      'Hi, draft reply for Hana\'s ask (the billing replies page, "Before I send anything to Northwind").',
    ],
  ])('names the records in %s', (_where, written, read): void => {
    expect(inPlainNames(written)).toBe(read);
    expect(inPlainNames(written)).not.toMatch(INTERNAL);
  });

  it('names a channel, a sheet, a ticket and a social post, and leaves other text alone', (): void => {
    expect(
      inPlainNames(
        'Post in channel://revops, append to mock-spreadsheet://q4-revenue-tracker, comment on ticket://REVOPS-204 and answer twitter://tweet-acme-feedback.',
      ),
    ).toBe(
      'Post in #revops, append to the q4 revenue tracker sheet, comment on REVOPS-204 and answer the social post tweet acme feedback.',
    );
    // Only a page's reference repeats the words beside it; a ticket's is its only name (the second pass).
    expect(inPlainNames('Closed it (ticket://REVOPS-204).')).toBe('Closed it (REVOPS-204).');
    expect(inPlainNames('Nothing to name here: https://example.com/a#b.')).toBe(
      'Nothing to name here: https://example.com/a#b.',
    );
  });
});

describe('refsInWords: the item references as the planner reads them', (): void => {
  it('prints each reference by what it is, with no scheme', (): void => {
    const line = refsInWords([
      'ticket://REVOPS-204',
      'docs-fixture/billing-replies',
      'channel://office-asks#thread-double-charge',
      'mock-spreadsheet://q4-revenue-tracker',
    ]);
    expect(line).toBe(
      'ticket REVOPS-204; the team document billing-replies; thread thread-double-charge in channel office-asks; the spreadsheet q4-revenue-tracker',
    );
    expect(line).not.toMatch(INTERNAL);
    expect(refsInWords([])).toBe('(none)');
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_UNREAD_LISTED,
  endedShort,
  isKindNotRead,
  legacyUnreadRecord,
  reasonWithoutLegacyRecord,
  unreadPagesLine,
  unreadRecordIn,
  withUnreadPages,
} from '../../../src/docs/sync-record';

describe('the record of pages a sync could not read (P5-11)', (): void => {
  it('names each page with its reason and counts them', (): void => {
    const record = withUnreadPages(undefined, [
      { ref: 'a.md', reason: 'HTTP 404' },
      { ref: 'b.md', reason: 'truncated' },
    ]);
    // Re-pinned for D-7: each entry says which it is, a failure here, and the record counts its
    // pages of a kind apart, none here.
    expect(record).toEqual({
      count: 2,
      pages: [
        { ref: 'a.md', reason: 'HTTP 404', kind: 'failed' },
        { ref: 'b.md', reason: 'truncated', kind: 'failed' },
      ],
      notRead: 0,
    });
    expect(withUnreadPages(record, [])).toBe(record);
    expect(withUnreadPages(undefined, [])).toBeUndefined();
  });

  it('adds a later batch to the count and names at most ten pages', (): void => {
    const many = Array.from({ length: 12 }, (_value, index) => ({
      ref: `page-${index}.md`,
      reason: 'HTTP 500',
    }));
    const first = withUnreadPages(undefined, many.slice(0, 7));
    const record = withUnreadPages(first, many.slice(7));
    expect(record?.count).toBe(12);
    expect(record?.pages).toHaveLength(MAX_UNREAD_LISTED);
    expect(withUnreadPages(record, [{ ref: 'x.md', reason: 'gone' }])?.count).toBe(13);
    expect(unreadPagesLine(record)).toMatch(/page-9\.md: HTTP 500; and 2 more\. The next sync/);
  });

  /** A sheet the Feishu reader lists and does not read, as it names it (D-7: the kind is said). */
  const sheet = (index: number): { ref: string; reason: string; kind: 'not-read' } => ({
    ref: `wikcnSheet${index}`,
    reason: `"Sheet ${index}" is a Feishu sheet, which day0 does not read: only documents (docx) are read, as Markdown.`,
    kind: 'not-read',
  });
  const forbidden = {
    ref: 'wikcnPayroll',
    reason:
      'The Feishu app cannot read "Payroll" (Feishu code 2889902): add the app to the document, or to its wiki space as a member.',
  };

  it('never lets pages of a kind Day0 does not read crowd a page it failed to read out of the ten named (W14-R40)', (): void => {
    // The review's input: a wiki with ten sheets and mind notes, then the one forbidden document.
    const tenSheets = Array.from({ length: 10 }, (_value, index) => sheet(index));
    const record = withUnreadPages(withUnreadPages(undefined, tenSheets), [forbidden, sheet(10)]);
    expect(record?.count).toBe(12);
    expect(record?.pages).toHaveLength(MAX_UNREAD_LISTED);
    expect(record?.pages[0]).toEqual({ ...forbidden, kind: 'failed' });
    expect(record?.pages.slice(1).map((page) => page.ref)).toEqual(
      tenSheets.slice(0, 9).map((page) => page.ref),
    );
  });

  it('says a page of a kind Day0 does not read is that, and promises to read again only what it failed to read (W14-R40)', (): void => {
    const sheets = withUnreadPages(undefined, [sheet(1), sheet(2)]);
    expect(unreadPagesLine(sheets)).toBe(
      '2 listed pages are of a kind Day0 does not read: wikcnSheet1: "Sheet 1" is a Feishu sheet, which day0 does not read: only documents (docx) are read, as Markdown; wikcnSheet2: "Sheet 2" is a Feishu sheet, which day0 does not read: only documents (docx) are read, as Markdown.',
    );
    expect(unreadPagesLine(sheets)).not.toMatch(/could not be read|reads them again/);
    const mixed = withUnreadPages(sheets, [forbidden]);
    expect(unreadPagesLine(mixed)).toBe(
      // Re-pinned with W15-R29: one page is "it", where the line said "reads them again".
      '1 page could not be read this sync and keeps its last stored version: wikcnPayroll: The Feishu app cannot read "Payroll" (Feishu code 2889902): add the app to the document, or to its wiki space as a member. The next sync reads it again. 2 more listed pages are of a kind Day0 does not read: wikcnSheet1: "Sheet 1" is a Feishu sheet, which day0 does not read: only documents (docx) are read, as Markdown; wikcnSheet2: "Sheet 2" is a Feishu sheet, which day0 does not read: only documents (docx) are read, as Markdown.',
    );
  });

  it('counts the failures and the pages of a kind apart, once ten failures fill the list (W15-R29)', (): void => {
    const failures = Array.from({ length: 11 }, (_value, index) => ({
      ref: `page-${index}.md`,
      reason: 'HTTP 500',
    }));
    const record = withUnreadPages(withUnreadPages(undefined, [sheet(1)]), failures);
    expect(record?.pages.every((page) => page.reason === 'HTTP 500')).toBe(true);
    // Re-pinned for D-7: this read "12 pages could not be read ... and 2 more", the sheet counted
    // as a failure and promised a read at the next sync; the record now counts it apart.
    expect(unreadPagesLine(record)).toMatch(
      /^11 pages could not be read this sync and keep their last stored version: page-0\.md: HTTP 500; .*; and 1 more\. The next sync reads them again\. 1 more listed page is of a kind Day0 does not read\.$/,
    );
  });

  it('reads the review’s two mixed records true: sheets are never counted as failures, nor promised a read (W15-R29)', (): void => {
    // Reader 3's unread.mts: ten sheets then eleven failures, and ten failures then ten sheets.
    const failures = (count: number) =>
      Array.from({ length: count }, (_value, index) => ({
        ref: `page-${index}.md`,
        reason: 'HTTP 500',
      }));
    const sheets = Array.from({ length: 10 }, (_value, index) => sheet(index));
    const sheetsFirst = unreadPagesLine(
      withUnreadPages(withUnreadPages(undefined, sheets), failures(11)),
    );
    expect(sheetsFirst).toMatch(
      /^11 pages could not be read this sync .*; and 1 more\. The next sync reads them again\. 10 more listed pages are of a kind Day0 does not read\.$/,
    );
    const failuresFirst = unreadPagesLine(
      withUnreadPages(withUnreadPages(undefined, failures(10)), sheets),
    );
    expect(failuresFirst).toMatch(
      /^10 pages could not be read this sync .*page-9\.md: HTTP 500\. The next sync reads them again\. 10 more listed pages are of a kind Day0 does not read\.$/,
    );
  });

  it('takes the kind from the entry, never from its words: a failed page titled with the clause is a failure (W15-R29)', (): void => {
    const titled = {
      ref: 'wikcnGuide',
      reason:
        'The Feishu app cannot read "The kinds of file which Day0 does not read" (Feishu code 2889902): add the app to the document.',
    };
    const record = withUnreadPages(undefined, [titled]);
    expect(record).toMatchObject({ count: 1, notRead: 0, pages: [{ kind: 'failed' }] });
    expect(unreadPagesLine(record)).toMatch(
      /^1 page could not be read this sync and keeps its last stored version: wikcnGuide: /,
    );
  });

  it('reads an entry written before the kind was kept as a failure, and a record without the count as it was read (D-7: no backfill)', (): void => {
    const before = {
      count: 12,
      pages: [{ ref: 'wikcnSheet1', reason: sheet(1).reason }],
    };
    expect(isKindNotRead(before.pages[0] as { kind?: 'failed' | 'not-read' })).toBe(false);
    expect(unreadPagesLine(before)).toMatch(
      /^12 pages could not be read this sync .*; and 11 more\. The next sync reads them again\.$/,
    );
    // A run resumed across the upgrade carries such a record on and gains no count for it.
    expect(withUnreadPages(before, [sheet(2)])).toMatchObject({ count: 13 });
    expect(withUnreadPages(before, [sheet(2)])?.notRead).toBeUndefined();
  });

  it('still knows a kind when a long name pushes its reason past the line bound (second pass)', (): void => {
    const long = `"${'Quarterly board pack '.repeat(14)}.pdf" is a PDF, which Day0 does not read: from a SharePoint library it reads Markdown files, Word documents (.docx) and the site's own pages.`;
    const record = withUnreadPages(undefined, [
      { ref: 'file-01LONG', reason: long, kind: 'not-read' },
    ]);
    expect(record?.pages[0].reason.length).toBeLessThanOrEqual(240);
    // Re-pinned for D-7: the kind is the entry's own, so the cut of a long reason cannot lose it.
    expect(isKindNotRead(record!.pages[0])).toBe(true);
    expect(unreadPagesLine(record)).toMatch(/^1 listed page is of a kind Day0 does not read: /);
  });

  it('joins the named pages without a full stop before each semicolon', (): void => {
    const line = unreadPagesLine(
      withUnreadPages(undefined, [
        { ref: 'a.md', reason: 'HTTP 404.' },
        { ref: 'b.md', reason: 'HTTP 500.' },
      ]),
    );
    expect(line).toBe(
      '2 pages could not be read this sync and keep their last stored version: a.md: HTTP 404; b.md: HTTP 500. The next sync reads them again.',
    );
  });

  it('says nothing for a run that read every page', (): void => {
    expect(unreadPagesLine(undefined)).toBeUndefined();
    expect(unreadPagesLine({ count: 0, pages: [] })).toBeUndefined();
  });

  it('puts the record on one line for the source', (): void => {
    expect(
      unreadPagesLine(withUnreadPages(undefined, [{ ref: 'a.md', reason: 'HTTP 404.' }])),
    ).toBe(
      // Re-pinned with W15-R29: one page is "it", where the line said "reads them again".
      '1 page could not be read this sync and keeps its last stored version: a.md: HTTP 404. The next sync reads it again.',
    );
  });

  it('names a page once when its reason already names it (14-D: a URL reader reason names its page)', (): void => {
    const reason =
      'http://example.com/handbook is plain http, which Day0 reads only for a host you list';
    expect(
      unreadPagesLine(
        withUnreadPages(undefined, [
          { ref: 'http://example.com/handbook', reason },
          { ref: 'b.md', reason: 'HTTP 404' },
        ]),
      ),
    ).toBe(
      `2 pages could not be read this sync and keep their last stored version: ${reason}; b.md: HTTP 404. The next sync reads them again.`,
    );
  });

  it('names a page its reason does not, though the reason holds its reference’s letters (W15-R29)', (): void => {
    // Reader 6's `unread.mts`: a ref `a` and the reason "Gave no body." lost the ref, since the
    // reason was searched for the ref's letters and "Gave" holds them.
    expect(
      unreadPagesLine(withUnreadPages(undefined, [{ ref: 'a', reason: 'Gave no body.' }])),
    ).toBe(
      '1 page could not be read this sync and keeps its last stored version: a: Gave no body. The next sync reads it again.',
    );
    // A reason that names a longer address names another page.
    expect(
      unreadPagesLine(
        withUnreadPages(undefined, [
          { ref: 'https://acme.test/p1', reason: 'https://acme.test/p10 answered 500.' },
          { ref: 'https://acme.test/p1', reason: 'https://acme.test/p1/archive answered 500.' },
          {
            ref: 'https://acme.test/p2',
            reason: 'Day0 was sent on to https://acme.test/p2, which answered 500.',
          },
        ]),
      ),
    ).toBe(
      '3 pages could not be read this sync and keep their last stored version: https://acme.test/p1: https://acme.test/p10 answered 500; https://acme.test/p1: https://acme.test/p1/archive answered 500; Day0 was sent on to https://acme.test/p2, which answered 500. The next sync reads them again.',
    );
  });

  it('keeps each page to one bounded line, whatever lines its failure has', (): void => {
    const record = withUnreadPages(undefined, [
      {
        ref: 'a.md',
        reason: 'Uncaught Error: failed\n    at handler (docSources.ts:1)\n    at run',
      },
      { ref: 'b.md', reason: 'x'.repeat(400) },
    ]);
    expect(record?.pages[0].reason).toBe(
      'Uncaught Error: failed at handler (docSources.ts:1) at run',
    );
    expect(record?.pages[1].reason).toHaveLength(240);
  });

  it('puts the reason a run ended short on one line, whatever lines the failure has', (): void => {
    expect(
      endedShort(
        'Provider said:\n2 pages could not be read this sync and keep their last stored version',
      ),
    ).toBe('Provider said: 2 pages could not be read this sync and keep their last stored version');
  });

  it('reads the run’s own field, and leaves a reason rewrite unable to touch it (D D1 (a))', (): void => {
    const record = withUnreadPages(undefined, [{ ref: 'a.md', reason: 'HTTP 404' }]);
    expect(unreadRecordIn({ unread: record, reason: endedShort('superseded') })).toBe(record);
    expect(unreadRecordIn({ reason: 'The documentation read was interrupted (timeout).' })).toBe(
      undefined,
    );
    expect(unreadRecordIn(undefined)).toBeUndefined();
  });
});

describe('the record an earlier release kept in the reason text', (): void => {
  const legacy = [
    'The documentation read was interrupted (timeout).',
    '12 pages could not be read this sync and keep their last stored version',
    '- https://wiki.example/a: HTTP 404',
    '- b.md: the page is 800 KiB: larger than Day0 stores',
    '- and 10 more',
  ].join('\n');

  // Re-pinned at 12-S3: the sync-runs-unread migration moved every such record onto the field at
  // 0.6.0, so a run reads its record from the field alone and only the migration reads the text.
  it('is read by the migration alone, never by a run, which reads its own field (12-S3)', (): void => {
    const record = {
      count: 12,
      pages: [
        { ref: 'https://wiki.example/a', reason: 'HTTP 404' },
        { ref: 'b.md', reason: 'the page is 800 KiB: larger than Day0 stores' },
      ],
    };
    expect(legacyUnreadRecord(legacy)).toEqual(record);
    expect(unreadRecordIn({ reason: legacy })).toBeUndefined();
    expect(legacyUnreadRecord('a newer sync of the source started before this one finished')).toBe(
      undefined,
    );
  });

  it('leaves the reason the line it ended short on, or nothing when the record was all it held', (): void => {
    expect(reasonWithoutLegacyRecord(legacy)).toBe(
      'The documentation read was interrupted (timeout).',
    );
    expect(reasonWithoutLegacyRecord(legacy.split('\n').slice(1).join('\n'))).toBeUndefined();
    expect(reasonWithoutLegacyRecord('superseded')).toBe('superseded');
    expect(reasonWithoutLegacyRecord(undefined)).toBeUndefined();
  });
});

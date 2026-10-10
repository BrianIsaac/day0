import { describe, expect, it } from 'vitest';
import {
  MAX_UNREAD_LISTED,
  endedShort,
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
    expect(record).toEqual({
      count: 2,
      pages: [
        { ref: 'a.md', reason: 'HTTP 404' },
        { ref: 'b.md', reason: 'truncated' },
      ],
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

  it('says nothing for a run that read every page', (): void => {
    expect(unreadPagesLine(undefined)).toBeUndefined();
    expect(unreadPagesLine({ count: 0, pages: [] })).toBeUndefined();
  });

  it('puts the record on one line for the source', (): void => {
    expect(
      unreadPagesLine(withUnreadPages(undefined, [{ ref: 'a.md', reason: 'HTTP 404.' }])),
    ).toBe(
      '1 page could not be read this sync and keeps its last stored version: a.md: HTTP 404. The next sync reads them again.',
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

import { describe, expect, it } from 'vitest';
import {
  MAX_UNREAD_LISTED,
  unreadPageCount,
  unreadPagesLine,
  withUnreadPages,
} from '../../../src/docs/sync-record';

describe('the record of pages a sync could not read (P5-11)', (): void => {
  it('names each page with its reason under a header that counts them', (): void => {
    const record = withUnreadPages(undefined, [
      { ref: 'a.md', reason: 'HTTP 404' },
      { ref: 'b.md', reason: 'truncated' },
    ]);
    expect(record).toBe(
      [
        '2 pages could not be read this sync and keep their last stored version',
        '- a.md: HTTP 404',
        '- b.md: truncated',
      ].join('\n'),
    );
    expect(unreadPageCount(record)).toBe(2);
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
    expect(unreadPageCount(record)).toBe(12);
    const lines = record?.split('\n') ?? [];
    expect(lines[0]).toBe(
      '12 pages could not be read this sync and keep their last stored version',
    );
    expect(lines.slice(1, -1)).toHaveLength(MAX_UNREAD_LISTED);
    expect(lines.at(-1)).toBe('- and 2 more');
    expect(unreadPageCount(withUnreadPages(record, [{ ref: 'x.md', reason: 'gone' }]))).toBe(13);
    expect(
      withUnreadPages(record, [{ ref: 'x.md', reason: 'gone' }])
        ?.split('\n')
        .at(-1),
    ).toBe('- and 3 more');
  });

  it('reads nothing into a reason that is not an unread-pages record', (): void => {
    expect(unreadPageCount('a newer sync of the source started before this one finished')).toBe(0);
    expect(unreadPagesLine('The documentation read was interrupted (timeout).')).toBeUndefined();
    expect(unreadPagesLine(undefined)).toBeUndefined();
  });

  it('puts the record on one line for the source', (): void => {
    expect(
      unreadPagesLine(withUnreadPages(undefined, [{ ref: 'a.md', reason: 'HTTP 404.' }])),
    ).toBe(
      '1 page could not be read this sync and keeps its last stored version: a.md: HTTP 404. The next sync reads them again.',
    );
  });
});

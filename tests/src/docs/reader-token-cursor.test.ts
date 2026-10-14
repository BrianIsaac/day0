import { describe, expect, it } from 'vitest';
import {
  READER_TOKEN_CURSOR,
  cursorWithToken,
  storedCursorParts,
  withoutReaderToken,
} from '../../../src/docs/reader-token-cursor';
import { FINISHING_CURSOR } from '../../../src/docs/finishing';
import { listingCursor } from '../../../src/docs/readers/batch';

describe('a stored cursor with a sealed reader token (X-1, the stored half)', (): void => {
  it('takes apart what it puts together, the reader’s cursor as it was', (): void => {
    for (const cursor of ['', 'page-2', listingCursor(25, ['a.md', 'b.md']), 'a\u0001b:c']) {
      const stored = cursorWithToken(cursor, 'aXY.c2VhbGVk');
      expect(stored.startsWith(READER_TOKEN_CURSOR)).toBe(true);
      expect(storedCursorParts(stored)).toEqual({ cursor, sealed: 'aXY.c2VhbGVk' });
      expect(withoutReaderToken(stored)).toBe(cursor);
    }
  });

  it('leaves a cursor with no token, the finish’s and none at all as they are', (): void => {
    for (const cursor of ['page-2', listingCursor(50, ['a.md']), FINISHING_CURSOR, undefined]) {
      expect(storedCursorParts(cursor)).toEqual({ cursor });
      expect(withoutReaderToken(cursor)).toBe(cursor);
    }
  });

  it('reads a form cut short as no place, and refuses a sealed part that would make it ambiguous', (): void => {
    expect(storedCursorParts(`${READER_TOKEN_CURSOR}aXY`)).toEqual({ cursor: undefined });
    expect(() => cursorWithToken('page-2', 'a\u0000b')).toThrow('holds no NUL');
  });
});

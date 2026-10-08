import { describe, expect, it } from 'vitest';
import { isListingCursor, ListingChangedError } from '../../../../src/docs/readers/batch';
import {
  firstWalk,
  walkCursor,
  walkFromCursor,
  type FeishuWalk,
} from '../../../../src/docs/readers/feishu-walk';

describe('the Feishu walk carried between batches', (): void => {
  it('carries the queue, the page, the skip and the counts through the cursor', (): void => {
    const walk: FeishuWalk = {
      queue: [null, 'wikcnRevOpsHandbook00000000'],
      pageToken: 'fixture-root-page-2',
      skip: 3,
      listed: 7,
      requests: 2,
    };
    const cursor = walkCursor(walk);
    expect(walkFromCursor(cursor)).toEqual(walk);
    // A provider's own cursor, never one bound to a listing digest.
    expect(isListingCursor(cursor)).toBe(false);
    expect(cursor.startsWith('\u0000')).toBe(false);
  });

  it('starts at the space or the folder it is given', (): void => {
    expect(firstWalk(null)).toEqual({
      queue: [null],
      pageToken: null,
      skip: 0,
      listed: 0,
      requests: 0,
    });
    expect(firstWalk('fldcnRevOpsFolder0000000000').queue).toEqual(['fldcnRevOpsFolder0000000000']);
  });

  it('reads the source again from its first page for a cursor it did not write', (): void => {
    const malformed = (value: unknown): string =>
      `feishu-walk:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
    for (const cursor of [
      '3@abcdefg',
      'feishu-walk:not-json',
      malformed(null),
      malformed({ queue: [], pageToken: null, skip: 0, listed: 0, requests: 0 }),
      malformed({ queue: [7], pageToken: null, skip: 0, listed: 0, requests: 0 }),
      malformed({ queue: [null], pageToken: null, skip: -1, listed: 0, requests: 0 }),
      malformed({ queue: [null], pageToken: null, skip: 0, listed: 0.5, requests: 0 }),
    ]) {
      expect(() => walkFromCursor(cursor), cursor).toThrow(ListingChangedError);
    }
  });
});

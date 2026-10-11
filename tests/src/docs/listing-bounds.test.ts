import { describe, expect, it } from 'vitest';
import {
  listingOverrun,
  MAX_SYNC_BATCHES,
  RELISTED_PAGES_FLOOR,
} from '../../../src/docs/listing-bounds';

describe('a listing that does not end (W15-R8)', (): void => {
  it('lets a run read on while its listing names new pages', (): void => {
    expect(listingOverrun({})).toBeUndefined();
    expect(listingOverrun({ batches: 400, pagesListed: 10_000, relisted: 0 })).toBeUndefined();
    expect(listingOverrun({ batches: MAX_SYNC_BATCHES - 1, pagesListed: 0 })).toBeUndefined();
  });

  it('lets a listing name some pages twice, as one edited mid-walk does', (): void => {
    // A busy workspace: 300 of 5,300 named pages were named before.
    expect(listingOverrun({ batches: 212, pagesListed: 5_300, relisted: 300 })).toBeUndefined();
    // A short listing that repeats itself a little is under the floor.
    expect(
      listingOverrun({ batches: 8, pagesListed: 60, relisted: RELISTED_PAGES_FLOOR - 1 }),
    ).toBeUndefined();
  });

  it('stops a run once most of what its listing named it had named before', (): void => {
    expect(listingOverrun({ batches: 202, pagesListed: 202, relisted: 200 })).toBe(
      "The source's listing did not end: it named 200 pages this sync had already read, as a provider does when it answers a later part of a listing with an earlier one. This sync stopped, and the pages already stored stay. The next sync reads the source again from its first page; if it stops the same way, tell the Day0 maintainers which source it is.",
    );
  });

  it('stops a run that has asked for as many parts of a listing as one sync is given', (): void => {
    expect(listingOverrun({ batches: MAX_SYNC_BATCHES, pagesListed: 0 })).toBe(
      "The source's listing did not end within the 4,000 parts Day0 reads of one listing in a sync, so this sync stopped, and the pages already stored stay. The next sync reads the source again from its first page; if it stops the same way, tell the Day0 maintainers which source it is.",
    );
  });
});

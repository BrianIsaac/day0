import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_STATUSES, SOURCE_AUTHORITIES } from '../../../src/docs/authority';

describe('document authority', (): void => {
  it('orders the trust a source may have most first, and lets a source default its pages to active or draft only', (): void => {
    expect(SOURCE_AUTHORITIES).toEqual(['official', 'team', 'personal']);
    expect(DEFAULT_PAGE_STATUSES).toEqual(['active', 'draft']);
  });
});

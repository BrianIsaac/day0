import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_STATUSES,
  defaultStatusOf,
  pageStatusOf,
  sourceAuthorityOf,
  PAGE_STATUSES,
  RELATION_KINDS,
  RELATION_STATUSES,
  SOURCE_AUTHORITIES,
  STATUS_SOURCES,
} from '../../../src/docs/authority';

describe('document authority', (): void => {
  it('orders the trust a source may have most first, and lets a source default its pages to active or draft only', (): void => {
    expect(SOURCE_AUTHORITIES).toEqual(['official', 'team', 'personal']);
    expect(DEFAULT_PAGE_STATUSES).toEqual(['active', 'draft']);
  });

  it('gives a page one of four statuses, decided by the manager, the source, a marker, a relation or the default', (): void => {
    expect(PAGE_STATUSES).toEqual(['active', 'draft', 'superseded', 'archived']);
    expect(STATUS_SOURCES).toEqual(['manager', 'source-native', 'marker', 'relation', 'default']);
  });

  it('proposes a relation as a duplicate, a successor or a conflict, which the manager confirms or dismisses', (): void => {
    expect(RELATION_KINDS).toEqual([
      'possible_duplicate',
      'possible_successor',
      'possible_conflict',
    ]);
    expect(RELATION_STATUSES).toEqual(['proposed', 'confirmed', 'dismissed']);
  });

  it('reads a page with no status as active and a source with no trust as team, and either given one as given', (): void => {
    expect(pageStatusOf({})).toBe('active');
    expect(pageStatusOf({ status: 'superseded' })).toBe('superseded');
    expect(sourceAuthorityOf({})).toBe('team');
    expect(sourceAuthorityOf({ authority: 'personal' })).toBe('personal');
  });

  it('reads a source with no default status as giving its pages active, and one given draft as draft', (): void => {
    expect(defaultStatusOf({})).toBe('active');
    expect(defaultStatusOf({ defaultStatus: 'draft' })).toBe('draft');
  });
});

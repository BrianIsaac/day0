import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../../../src/events/contract';
import { eventTypesIn, RECORD_FILTER_OF, RECORD_FILTERS } from '../../../src/events/record-filters';

describe('the Record tab filters', (): void => {
  it('places every event type the contract lists, and nothing it does not', (): void => {
    expect(Object.keys(RECORD_FILTER_OF).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('shows each filter a part of the record, never nothing', (): void => {
    for (const filter of RECORD_FILTERS) {
      const types = eventTypesIn(filter);
      expect(types.length).toBeGreaterThan(0);
      expect(types.length).toBeLessThan(EVENT_TYPES.length);
    }
  });

  it('lists the manager’s refusals under both their decisions and what was refused', (): void => {
    for (const type of ['work.actions-rejected', 'skill.rejected', 'surface.rejected'] as const) {
      expect(RECORD_FILTER_OF[type]).toEqual(expect.arrayContaining(['decisions', 'refused']));
    }
  });

  it('lists a handover asked or cancelled as the manager’s decision, a decline as a decision and a refusal, and an expiry as set aside', (): void => {
    expect(RECORD_FILTER_OF['manager.transfer-asked']).toEqual(['decisions']);
    expect(RECORD_FILTER_OF['manager.transfer-cancelled']).toEqual(['decisions']);
    expect(RECORD_FILTER_OF['manager.transfer-declined']).toEqual(['decisions', 'refused']);
    expect(RECORD_FILTER_OF['manager.transfer-expired']).toEqual(['refused']);
  });

  it('keeps the charter’s history, the one-to-one that drafts it included, under Charter', (): void => {
    const charter = eventTypesIn('charter');
    for (const type of EVENT_TYPES) {
      if (type.startsWith('charter.') || type.startsWith('voice.')) expect(charter).toContain(type);
    }
  });

  it("lists an adoption as the manager's decision, and an offer as nothing yet decided (10-A)", (): void => {
    expect(RECORD_FILTER_OF['skill.adopted']).toEqual(['decisions']);
    expect(RECORD_FILTER_OF['skill.adoption-offered']).toEqual([]);
  });

  it('lists a grant as a decision, and leaves a connection the documentation reopened out of them', (): void => {
    expect(RECORD_FILTER_OF['permission.granted']).toContain('decisions');
    expect(RECORD_FILTER_OF['surface.reopened']).not.toContain('decisions');
  });
});

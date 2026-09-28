import { describe, expect, it } from 'vitest';
import { CANDIDATE_PROPERTIES } from '../../../src/work/candidate-properties';

function propertyOf(text: string): string | undefined {
  return CANDIDATE_PROPERTIES.find((property) => property.words.test(text))?.property;
}

describe('the candidate properties', (): void => {
  it('name ownership, priority and age by the words a clause or a plan step uses', (): void => {
    expect(propertyOf('Confirm the ticket is assigned to me first')).toBe('ownership');
    expect(propertyOf('Check the ticket is prioritised')).toBe('priority');
    expect(propertyOf('Skip tickets older than 30 days')).toBe('age');
  });

  it('match whole words only, so a plan step about a page owner is not an ownership check', (): void => {
    expect(propertyOf('Read the disowned page')).toBeUndefined();
    expect(propertyOf('Refresh the pipeline tile and read it back')).toBeUndefined();
  });
});
